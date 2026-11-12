// Pure peer & group collaboration helpers adapted for Host message ledger & durable turns
// (mention routing, anti-loop caps, silent "(pass)", and wake / closing-nudge prompts).

export const GROUP_CONFIG_VERSION = 1;
export const GROUP_MAX_MEMBER_TURNS = 10;
export const GROUP_MAX_ROUNDS = 3;
export const GROUP_PROMPT_HISTORY_LIMIT = 24;
export const GROUP_MAX_MESSAGES_PER_TURN = 2;
export const GROUP_CHAT_TAG_PREFIX = '[Group chat: ';
export const AGENT_INBOUND_WAKE_CUE = '[agent]';
export const MAX_REPLY_NUDGES = 2;
export const AGENT_MESSAGE_MAX_TEXT_LENGTH = 8_000;

export function clampLine(text, maxLength = 200) {
  if (typeof text !== 'string') return '';
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxLength) return single;
  return `${single.slice(0, Math.max(0, maxLength - 1))}…`.toWellFormed();
}

export function clampBlock(text, maxLength = AGENT_MESSAGE_MAX_TEXT_LENGTH) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`.toWellFormed();
}

export function clampAgentMessage(text) {
  return clampBlock(text, AGENT_MESSAGE_MAX_TEXT_LENGTH);
}

export function orderRoundSpeakers(memberIds, round) {
  if (!Array.isArray(memberIds) || memberIds.length === 0) return [];
  const offset = ((round % memberIds.length) + memberIds.length) % memberIds.length;
  return [...memberIds.slice(offset), ...memberIds.slice(0, offset)];
}

export function isSameMemberSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function memberMentionHandles(name) {
  if (typeof name !== 'string') return [];
  const lower = name.trim().toLowerCase();
  if (!lower) return [];
  const handles = new Set([lower, lower.replace(/\s+/g, '')]);
  const first = lower.split(/\s+/)[0];
  if (first) handles.add(first);
  return [...handles];
}

function isAsciiWordChar(char) {
  return char !== undefined && /[a-z0-9_]/i.test(char);
}

function findMentionSpans(lower, handle) {
  const needle = `@${handle}`;
  const endsWithAscii = isAsciiWordChar(handle[handle.length - 1]);
  const spans = [];
  for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + 1)) {
    // Do not match inside email addresses or identifiers (e.g. foo@bar).
    if (isAsciiWordChar(lower[index - 1])) continue;
    // ASCII handles require a non-ASCII-word boundary after the handle; CJK handles
    // can be followed immediately by punctuation, whitespace, or CJK sentence text,
    // while longest-handle-first span claiming below prevents prefix collisions.
    if (endsWithAscii && isAsciiWordChar(lower[index + needle.length])) continue;
    spans.push([index, index + needle.length]);
  }
  return spans;
}

export function parseGroupMentions(text, members) {
  if (typeof text !== 'string' || !text) {
    return { isEveryone: false, memberIds: [] };
  }
  const lower = text.toLowerCase();
  const isEveryone =
    /(?:^|[^a-z0-9_])@(?:everyone|all)(?![a-z0-9_])/i.test(lower) ||
    /(?:^|[^a-z0-9_])@(?:所有人|全体成员)/.test(lower);

  if (!Array.isArray(members) || members.length === 0) {
    return { isEveryone, memberIds: [] };
  }

  // Sort candidate handles longest-first so e.g. "@助手二号" claims its @-offset
  // before a shorter prefix handle like "@助手" at the same @ position.
  const candidates = [];
  for (const member of members) {
    if (!member || typeof member.id !== 'string') continue;
    for (const handle of memberMentionHandles(member.name)) {
      candidates.push({ id: member.id, handle });
    }
  }
  candidates.sort((left, right) => right.handle.length - left.handle.length);

  const claimedByAtIndex = new Map(); // @-index -> matched end index
  const matchedIds = new Set();
  for (const { id, handle } of candidates) {
    for (const [start, end] of findMentionSpans(lower, handle)) {
      const claimedEnd = claimedByAtIndex.get(start);
      if (claimedEnd !== undefined && claimedEnd > end) {
        // A strictly longer member handle already matched at this exact '@'.
        continue;
      }
      claimedByAtIndex.set(start, Math.max(claimedEnd ?? 0, end));
      matchedIds.add(id);
    }
  }

  const memberIds = [];
  for (const member of members) {
    if (member && matchedIds.has(member.id) && !memberIds.includes(member.id)) {
      memberIds.push(member.id);
    }
  }
  return { isEveryone, memberIds };
}

export function resolveResponders(members, history) {
  if (!Array.isArray(members) || members.length === 0) return [];
  const items = Array.isArray(history) ? history : [];
  let start = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.speaker?.kind === 'user') {
      start = index;
      break;
    }
  }
  let everyone = false;
  const mentioned = new Set();
  for (const message of items.slice(start)) {
    const content = typeof message?.content === 'string' ? message.content : '';
    const targets = parseGroupMentions(content, members);
    everyone ||= targets.isEveryone;
    for (const id of targets.memberIds) mentioned.add(id);
  }
  return everyone || mentioned.size === 0
    ? [...members]
    : members.filter((member) => mentioned.has(member.id));
}

export function isHostFailureReceiptText(text) {
  return typeof text === 'string' && text.startsWith('[Host 执行失败]');
}

/**
 * Distributed adaptation of Grok Bot's GroupChatOrchestrator responder + round caps:
 * - Caps consecutive bot messages since the latest human message at GROUP_MAX_MEMBER_TURNS (10),
 *   and caps each individual bot's turns since the latest human message at GROUP_MAX_ROUNDS (3).
 * - Applies @mention responder routing:
 *   1) Explicit @everyone/@all/@所有人 wakes all members (within round caps).
 *   2) Explicit @BotName on the unread batch wakes ONLY the mentioned member(s).
 *   3) Otherwise, delegates to resolveResponders(members, recentHistory) from the latest
 *      user message forward (also allowing a member that already spoke in the current
 *      thread to hear an un-mentioned follow-up within its round cap).
 */
export function evaluateGroupTurnEligibility({
  memberId,
  members,
  recentHistory,
  unreadMessages,
}) {
  const history = Array.isArray(recentHistory) ? recentHistory : [];
  const unread = Array.isArray(unreadMessages) ? unreadMessages : [];

  let lastUserIndex = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.speaker?.kind === 'user') {
      lastUserIndex = i;
      break;
    }
  }

  const windowAfterUser = lastUserIndex >= 0 ? history.slice(lastUserIndex + 1) : history;
  let botMessagesSinceUser = 0;
  let ownTurnsSinceUser = 0;
  for (const msg of windowAfterUser) {
    if (msg?.speaker?.kind !== 'member') continue;
    if (isHostFailureReceiptText(msg.content)) continue;
    botMessagesSinceUser += 1;
    if (msg.speaker.id === memberId) ownTurnsSinceUser += 1;
  }

  if (botMessagesSinceUser >= GROUP_MAX_MEMBER_TURNS) {
    return { eligible: false, reason: 'max_member_turns' };
  }
  if (ownTurnsSinceUser >= GROUP_MAX_ROUNDS) {
    return { eligible: false, reason: 'max_rounds' };
  }

  let unreadEveryone = false;
  const unreadMentioned = new Set();
  for (const msg of unread) {
    const parsed = parseGroupMentions(typeof msg?.content === 'string' ? msg.content : '', members);
    unreadEveryone ||= parsed.isEveryone;
    for (const id of parsed.memberIds) unreadMentioned.add(id);
  }

  if (unreadEveryone) {
    return { eligible: true, reason: 'everyone_mention' };
  }
  if (unreadMentioned.size > 0) {
    return unreadMentioned.has(memberId)
      ? { eligible: true, reason: 'direct_mention' }
      : { eligible: false, reason: 'other_member_mentioned' };
  }

  const responders = resolveResponders(members, history);
  if (responders.some((m) => m.id === memberId) || ownTurnsSinceUser > 0) {
    return { eligible: true, reason: 'thread_responder' };
  }
  return { eligible: false, reason: 'not_in_responders' };
}

export function isPassContent(content) {
  if (typeof content !== 'string') return true;
  const trimmed = content.trim();
  return !trimmed || /^\(?\s*pass\s*\)?\.?$/i.test(trimmed);
}

export function isPotentialPassPrefix(text) {
  if (typeof text !== 'string') return true;
  const trimmed = text.trim();
  return !trimmed || isPassContent(trimmed) || /^\(?\s*(?:p(?:a(?:s(?:s\s*\)?\.?)?)?)?)?$/i.test(trimmed);
}

export function formatGroupLine(message, viewerId) {
  const content = clampBlock(message?.content ?? '', 1_200);
  if (message?.speaker?.kind === 'user') {
    return message.speaker.name ? `${message.speaker.name} (user): ${content}` : `User: ${content}`;
  }
  const speakerName = message?.speaker?.name || 'Peer Bot';
  return `${speakerName}${message?.speaker?.id === viewerId ? ' (you)' : ''}: ${content}`;
}

export function formatGroupHistory(history, viewerId, limit = GROUP_PROMPT_HISTORY_LIMIT) {
  const list = Array.isArray(history) ? history.slice(-limit) : [];
  return list.length === 0
    ? '(no messages yet)'
    : list.map((message) => formatGroupLine(message, viewerId)).join('\n');
}

export function groupDisplayName(group) {
  const name = typeof group?.name === 'string' ? group.name.trim() : '';
  return name || 'Group chat';
}

export function describeGroup(group) {
  const name = groupDisplayName(group);
  const description = typeof group?.description === 'string' ? group.description.trim() : '';
  return description ? `"${name}" — ${description}` : `"${name}"`;
}

export function formatGroupChatTag(group, peers) {
  const peerNames = Array.isArray(peers)
    ? peers.map((peer) => peer?.name).filter((n) => typeof n === 'string' && n.trim() !== '')
    : [];
  return `${GROUP_CHAT_TAG_PREFIX}"${groupDisplayName(group)}"${peerNames.length > 0 ? ` - with ${peerNames.join(', ')}` : ''}]`;
}

export function messagesSinceMemberLastSpoke(history, memberId) {
  if (!Array.isArray(history)) return [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const speaker = history[index]?.speaker;
    if (speaker?.kind === 'member' && speaker.id === memberId) {
      return history.slice(index + 1);
    }
  }
  return history;
}

export function buildGroupTurnWakePrompt({
  memberName,
  memberId,
  group,
  peers = [],
  newMessages = [],
  scopeId,
}) {
  const selfLabel = typeof memberName === 'string' && memberName.trim() ? memberName.trim() : 'this Bot';
  const lines = [
    formatGroupChatTag(group, peers),
    `You are ${selfLabel}, participating in group chat ${describeGroup(group)} (scopeId ${JSON.stringify(scopeId)}).`,
  ];
  if (Array.isArray(peers) && peers.length > 0) {
    lines.push(
      'Other participants in this room: ' +
        peers
          .map((p) => {
            const desc = typeof p.description === 'string' && p.description.trim()
              ? ` (${clampLine(p.description, 100)})`
              : '';
            return `${p.name || 'Peer Bot'}${desc}`;
          })
          .join(', ') +
        '.',
    );
  }
  if (Array.isArray(newMessages) && newMessages.length > 0) {
    lines.push('', `New messages in the room (oldest first):\n${formatGroupHistory(newMessages, memberId)}`);
  }
  lines.push(
    '',
    `The ONLY way to speak in this room is calling send_to with scopeId ${JSON.stringify(scopeId)}. Keep room replies concise, natural, and in character. Speak only if you have something genuinely useful to contribute (or were directly asked/@mentioned); if you have nothing new worth adding, send "(pass)" via send_to (or end the turn without sending) to stay silent. Never leak private 1:1 context.`,
  );
  return lines.join('\n');
}

export function buildAgentInboundWakePrompt({
  peerName,
  peerBotId,
  scopeId,
  category,
  text,
  replyTarget,
  originRequestId,
}) {
  const senderLabel = typeof peerName === 'string' && peerName.trim()
    ? peerName.trim()
    : (typeof peerBotId === 'string' && peerBotId ? `Peer Bot (${peerBotId})` : 'a peer Bot');

  // Case 1: Late DM reply resuming a turn that originated from the user's primary chat
  if (category === 'reply' && (!replyTarget || replyTarget.kind === 'primary')) {
    const lines = [
      `${AGENT_INBOUND_WAKE_CUE} ${senderLabel} replied to your earlier delegated request (DM scopeId ${JSON.stringify(scopeId)}${originRequestId ? `, originRequestId ${JSON.stringify(originRequestId)}` : ''}).`,
      'Your user can already see this incoming reply in your 1:1 conversation.',
    ];
    if (typeof text === 'string' && text.trim()) {
      lines.push('', `${senderLabel}: ${clampBlock(text, 2_000)}`);
    }
    lines.push(
      '',
      'Use this result to continue any remaining local verification or synthesis, and write your final answer directly in this primary user chat. Do NOT call send_to back to the peer just to say "thanks" or acknowledge receipt.',
    );
    return lines.join('\n');
  }

  // Case 2: Inbound DM request (or multi-hop reply whose upstream origin is another DM request)
  const targetScopeId = replyTarget?.scopeId ?? scopeId;
  const lines = [
    `${AGENT_INBOUND_WAKE_CUE} A direct message arrived from peer Bot ${senderLabel} (DM scopeId ${JSON.stringify(scopeId)}).`,
    'This is another assistant reaching out asynchronously — not the human user typing directly. Your work in this turn runs visibly inside your 1:1 conversation page with the user.',
  ];
  if (typeof text === 'string' && text.trim()) {
    lines.push('', `${senderLabel}: ${clampBlock(text, 2_000)}`);
  }
  lines.push(
    '',
    `Complete the requested work using your real tools, then deliver the concrete result back to the task dispatcher by invoking send_to with scopeId ${JSON.stringify(targetScopeId)}. Plain assistant text is visible to your user in this chat, NOT transmitted to ${senderLabel} — only a real send_to tool call reaches the peer Bot. Once send_to succeeds and no local work remains, finish the turn cleanly. Only if this message is purely informational (an FYI with no task or question to answer), call send_to with text "(pass)" to confirm no reply is needed.`,
  );
  return lines.join('\n');
}

export function buildClosingSendNudgePrompt({
  peerName,
  scopeId,
  attempt = 1,
}) {
  const targetLabel = typeof peerName === 'string' && peerName.trim() ? peerName.trim() : 'the dispatching peer Bot';
  return [
    `[Host closing-reply check #${attempt}] Your previous turn ended without calling send_to to ${targetLabel} (scopeId ${JSON.stringify(scopeId)}).`,
    `Plain assistant text in this conversation is ONLY shown locally to your user and is NEVER delivered to ${targetLabel} — so ${targetLabel} received nothing and is still waiting on your result.`,
    `If your work produced the answer or result ${targetLabel} asked for, deliver it right now by invoking the send_to tool with scopeId ${JSON.stringify(scopeId)} (make a real tool call, not plain text). If the task is genuinely unfinished, finish it and call send_to. Only if the incoming message was a pure FYI that requires no reply at all, invoke send_to with scopeId ${JSON.stringify(scopeId)} and text "(pass)" so the turn can settle cleanly.`,
  ].join('\n');
}
