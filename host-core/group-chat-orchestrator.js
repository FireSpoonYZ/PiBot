// Per-room exclusive concurrency lock + epoch-cancellable sequential round-robin orchestrator
// (adapted for Host durable room scopes: at most one member turn runs per room at any time,
// speakers rotate each round via orderRoundSpeakers, and newer external/user messages advance
// the room epoch so stale rounds stop cleanly at the next member boundary without STALE_INPUT).

import {
  GROUP_MAX_MEMBER_TURNS,
  GROUP_MAX_MESSAGES_PER_TURN,
  GROUP_MAX_ROUNDS,
  SHARED_ROOM_HISTORY_LIMIT,
  isPassContent,
  messagesSinceMemberLastSpoke,
  orderRoundSpeakers,
  resolveResponders,
} from './group-chat.js';

/**
 * Per-room exclusive FIFO run scheduler + monotonic turn epoch tracker.
 * Guarantees concurrency = 1 per room scopeId across all local Bots.
 */
export class RoomTurnScheduler {
  constructor() {
    this.queues = new Map();
    this.turnEpochs = new Map();
    this.disposed = false;
  }

  nextTurnEpoch(scopeId) {
    const next = (this.turnEpochs.get(scopeId) ?? 0) + 1;
    this.turnEpochs.set(scopeId, next);
    return next;
  }

  currentTurnEpoch(scopeId) {
    return this.turnEpochs.get(scopeId) ?? 0;
  }

  hasActiveRun(scopeId) {
    return this.queues.get(scopeId)?.active != null;
  }

  enqueueExclusive(scopeId, task) {
    const queue = this.#queueFor(scopeId);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    queue.pending.push({ task, resolve, reject, promise });
    queueMicrotask(() => this.#pump(scopeId));
    return promise;
  }

  async drain(scopeId) {
    const queue = this.queues.get(scopeId);
    if (!queue) return;
    const snapshot = [
      ...(queue.active ? [queue.active.settled] : []),
      ...queue.pending.map((item) => item.promise),
    ];
    await Promise.allSettled(snapshot);
  }

  async drainAll() {
    const all = [];
    for (const scopeId of this.queues.keys()) {
      all.push(this.drain(scopeId));
    }
    await Promise.allSettled(all);
  }

  dispose() {
    this.disposed = true;
  }

  #queueFor(scopeId) {
    let queue = this.queues.get(scopeId);
    if (!queue) {
      queue = { active: null, pending: [] };
      this.queues.set(scopeId, queue);
    }
    return queue;
  }

  #pump(scopeId) {
    const queue = this.queues.get(scopeId);
    if (!queue || queue.active !== null) return;
    if (this.disposed) {
      while (queue.pending.length > 0) {
        queue.pending.shift().resolve();
      }
      this.queues.delete(scopeId);
      return;
    }
    const next = queue.pending.shift();
    if (!next) {
      this.queues.delete(scopeId);
      return;
    }
    let markSettled;
    const settled = new Promise((res) => {
      markSettled = res;
    });
    const active = { item: next, settled };
    queue.active = active;
    let running;
    try {
      running = Promise.resolve().then(() => next.task());
    } catch (err) {
      running = Promise.reject(err);
    }
    running.then(
      (val) => {
        next.resolve(val);
        if (queue.active === active) queue.active = null;
        markSettled();
        this.#pump(scopeId);
      },
      (err) => {
        next.reject(err);
        if (queue.active === active) queue.active = null;
        markSettled();
        this.#pump(scopeId);
      },
    );
  }
}

/**
 * Drives a bounded, epoch-cancellable sequential round-robin for one room turn:
 * - Up to GROUP_MAX_ROUNDS (3) rounds per turn
 * - Speaker order rotated per round via orderRoundSpeakers(responderIds, round)
 * - Strictly awaits one member at a time so each subsequent speaker sees prior speakers' messages
 * - Caps per-member-turn output at GROUP_MAX_MESSAGES_PER_TURN (2) and room total at GROUP_MAX_MEMBER_TURNS (10)
 * - Stops immediately when a round yields 0 messages or !isCurrent() (a newer external/user message arrived)
 */
export class GroupChatOrchestrator {
  constructor(deps) {
    this.deps = deps;
  }

  async run(args) {
    const members = await this.deps.resolveMembers(args.memberIds ?? []);
    if (!Array.isArray(members) || members.length === 0) return;

    const memberById = new Map(members.map((member) => [member.id, member]));
    let totalMessages = typeof args.initialTotalMessages === 'number' && args.initialTotalMessages > 0
      ? args.initialTotalMessages
      : 0;

    for (let round = 0; round < GROUP_MAX_ROUNDS; round += 1) {
      if (!this.deps.isCurrent()) return;
      const resolved = resolveResponders(
        members,
        this.deps.readHistory(),
      ).map((member) => member.id);
      const responderIds = round === 0 && Array.isArray(args.pendingResponderIds) && args.pendingResponderIds.length > 0
        ? members
            .filter((m) => resolved.includes(m.id) || args.pendingResponderIds.includes(m.id))
            .map((m) => m.id)
        : resolved;
      let messagesThisRound = 0;

      for (const memberId of orderRoundSpeakers(responderIds, round)) {
        if (totalMessages >= GROUP_MAX_MEMBER_TURNS || !this.deps.isCurrent()) {
          return;
        }
        const member = memberById.get(memberId);
        if (member == null) continue;

        const sent = await this.runOneTurn(args.group, member, members, round);
        let hitCap = false;
        for (const content of sent) {
          this.deps.postMemberMessage?.(member, content);
          totalMessages += 1;
          messagesThisRound += 1;
          if (totalMessages >= GROUP_MAX_MEMBER_TURNS) {
            hitCap = true;
            break;
          }
        }
        this.deps.finalizeMemberTurn?.(member);
        if (hitCap) return;
      }

      if (messagesThisRound === 0) return;
    }
  }

  async runOneTurn(group, member, members, round = 0) {
    const peers = members.filter((other) => other.id !== member.id);
    const history = this.deps.readHistory();
    const newMessages = this.deps.isSharedRoom === true
      ? history.slice(-SHARED_ROOM_HISTORY_LIMIT)
      : messagesSinceMemberLastSpoke(history, member.id);
    const sent = await this.deps.runMemberTurn({
      member,
      group,
      peers,
      newMessages,
      round,
    });

    const spoken = [];
    if (Array.isArray(sent)) {
      for (const content of sent) {
        if (isPassContent(content)) continue;
        const trimmed = typeof content === 'string' ? content.trim() : '';
        if (trimmed.length === 0) continue;
        spoken.push(trimmed);
        if (spoken.length >= GROUP_MAX_MESSAGES_PER_TURN) break;
      }
    }
    return spoken;
  }
}
