import { openStore } from './store.js';
import { ensureSoul, setSoulText } from './bot-soul.js';
import { formatInitialBotSoul } from './bot-prompt.js';
import fs from 'node:fs';
import path from 'node:path';
import { assertDeviceId } from './relay-protocol.js';

/**
 * Open the local bot/host registry for the machine.
 * dataRoot must be a non-empty absolute path; it is resolved and handed to the
 * store, which is responsible for creating it.
 */
export function openHost(options) {
  const dataRoot = options?.dataRoot;
  if (typeof dataRoot !== 'string' || dataRoot.trim() === '' || !path.isAbsolute(dataRoot)) {
    throw invalidArgument('dataRoot must be a non-empty absolute path');
  }
  const expectedDeviceId = options?.expectedDeviceId;
  if (expectedDeviceId !== undefined) assertDeviceId(expectedDeviceId);
  const root = path.resolve(dataRoot);
  const store = openStore(root, expectedDeviceId);
  const defaultWorkspace = path.resolve(root, 'workspaces');

  // 未知 Bot 抛 BOT_NOT_FOUND；SOUL 路径只在此校验过存在性后由 bot-soul.js 内部生成。
  const requireBot = (botId) => {
    assertId(botId, 'botId');
    const bot = store.getBot(botId);
    if (!bot) throw botNotFound(botId);
    return bot;
  };

  const extractBotId = (input) => {
    if (typeof input === 'string') {
      assertId(input, 'botId');
      return input;
    }
    if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
    assertId(input.botId, 'botId');
    return input.botId;
  };

  return {
    deviceId: store.deviceId,
    dataRoot: root,
    defaultWorkspace,
    getHostProfile() {
      return store.getHostProfile();
    },
    createBot(input) {
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      const { requestId, role, cwd, modelRef, description = '', makePrimary } = input;
      if (typeof requestId !== 'string' || requestId.trim() === '') throw invalidArgument('requestId must be a non-empty string');
      if (typeof role !== 'string' || role.trim() === '') throw invalidArgument('role must be non-blank text');
      if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw invalidArgument('cwd must be an absolute path');
      if (typeof description !== 'string' || description.length > 2000) throw invalidArgument('description must be a string of at most 2000 characters');
      if (makePrimary !== undefined && typeof makePrimary !== 'boolean') throw invalidArgument('makePrimary must be a boolean');
      let resolvedModelRef = null;
      if (modelRef !== undefined && modelRef !== null) {
        if (typeof modelRef !== 'string' || modelRef.trim() === '') throw invalidArgument('modelRef must be null or a non-blank string');
        resolvedModelRef = modelRef;
      }
      const normalizedCwd = cwd === undefined ? defaultWorkspace : path.resolve(cwd);

      const request = {
        requestId,
        role,
        cwd: normalizedCwd,
        modelRef: resolvedModelRef,
        description,
        ...(makePrimary !== undefined ? { makePrimary } : {}),
      };
      // Retries for an already-accepted request must not fail when the original
      // cwd has since disappeared; store.createBot does the consistency check.
      if (store.findByRequest(requestId) !== null) {
        // 已受理记录不因上次 SOUL 写入失败而丢失：重试在此幂等补建。
        const retried = store.createBot(request);
        ensureSoul(root, retried.botId, formatInitialBotSoul(retried.role));
        return retried;
      }

      const name = role.trim();
      if (name.length > 120) throw invalidArgument('role must be at most 120 characters');
      request.persistedRole = name;
      if (cwd === undefined) fs.mkdirSync(defaultWorkspace, { recursive: true });
      let stat;
      try {
        stat = fs.statSync(normalizedCwd);
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw invalidCwd(normalizedCwd);
        throw err;
      }
      if (!stat.isDirectory()) throw invalidCwd(normalizedCwd);

      const created = store.createBot(request);
      // 注册记录与 SOUL 文件分两步：文件失败不回滚已受理记录，重试可完成初始化。
      ensureSoul(root, created.botId, formatInitialBotSoul(created.role));
      return created;
    },
    updateBotProfile(input) {
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      requireBot(input.botId);
      let name;
      if (input.name !== undefined) {
        if (typeof input.name !== 'string' || input.name.trim().length < 1 || input.name.trim().length > 120) {
          throw invalidArgument('name must be 1 to 120 non-blank characters');
        }
        name = input.name.trim();
      }
      if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) {
        throw invalidArgument('description must be a string of at most 2000 characters');
      }
      return store.updateBotProfile(input.botId, name, input.description);
    },
    setPrimaryBot(input) {
      const botId = extractBotId(input);
      return store.setPrimaryBot(botId);
    },
    archiveBot(input) {
      const botId = extractBotId(input);
      return store.archiveBot(botId);
    },
    unarchiveBot(input) {
      const botId = extractBotId(input);
      return store.unarchiveBot(botId);
    },
    deleteBot(input) {
      const botId = extractBotId(input);
      store.deleteBot(botId);
      try {
        fs.rmSync(path.join(root, 'bots', botId), { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
      return { botId, deleted: true };
    },
    recordBotActivity(botId, activity) {
      assertId(botId, 'botId');
      return store.recordBotActivity(botId, activity ?? {});
    },
    listExpiredArchivedBots(cutoffIso) {
      assertId(cutoffIso, 'cutoffIso');
      return store.listExpiredArchivedBots(cutoffIso);
    },
    getBot(botId) {
      assertId(botId, 'botId');
      return store.getBot(botId);
    },
    /** Absolute-path + existing-directory check; returns the normalized path. */
    assertBotCwd(input) {
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      const cwd = input.cwd;
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw invalidArgument('cwd must be an absolute path');
      const normalizedCwd = path.resolve(cwd);
      let stat;
      try {
        stat = fs.statSync(normalizedCwd);
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') throw invalidCwd(normalizedCwd);
        throw err;
      }
      if (!stat.isDirectory()) throw invalidCwd(normalizedCwd);
      return normalizedCwd;
    },
    /** Internal center-driven cwd switch; only the runtime apply boundary calls this. */
    setBotCwd(botId, input) {
      requireBot(botId);
      const normalizedCwd = this.assertBotCwd(input);
      return store.setBotCwd(botId, normalizedCwd);
    },
    findByRequest(requestId) {
      assertId(requestId, 'requestId');
      return store.findByRequest(requestId);
    },
    listBots() {
      return store.listBots();
    },
    // 行未初始化返回 null；未知 Bot 由调用方先用 getBot 区分。
    getBotExtensions(botId) {
      assertId(botId, 'botId');
      return store.getBotExtensionSettings(botId);
    },
    // SOUL：首次/缺失时按持久化 role 一次性补建，已有内容永不覆盖。
    ensureBotSoul(botId) {
      const bot = requireBot(botId);
      return ensureSoul(root, bot.botId, bot.role);
    },
    getBotSoul(botId) {
      // 遗留 Bot 的缺失文档在此幂等补建（读取即初始化）。
      const bot = requireBot(botId);
      return ensureSoul(root, bot.botId, bot.role);
    },
    setBotSoul(botId, input) {
      const bot = requireBot(botId);
      if (typeof input !== 'object' || input === null) throw invalidArgument('input must be an object');
      return setSoulText(root, bot.botId, input.expectedRevision, input.text);
    },
    close() {
      store.close();
    },
  };
}

function invalidArgument(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function invalidCwd(cwd) {
  const err = new Error(`cwd is not an existing directory: ${cwd}`);
  err.code = 'INVALID_CWD';
  return err;
}

function botNotFound(botId) {
  const err = new Error(`bot not found: ${botId}`);
  err.code = 'BOT_NOT_FOUND';
  return err;
}

function assertId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw invalidArgument(`${name} must be a non-empty string`);
}

export { openHost as default };
