// Secret-path errors never reflect user input or underlying exceptions.
const MESSAGES = Object.freeze({
  VAULT_INVALID_ARGUMENT: 'Invalid Vault request.',
  VAULT_LOCKED: 'Vault is locked. Call vault_unlock to open the private unlock card.',
  VAULT_UNLOCK_FAILED: 'Vault could not be unlocked.',
  VAULT_NOT_INITIALIZED: 'Call vault_unlock to initialize Vault in the private unlock card.',
  VAULT_ALREADY_INITIALIZED: 'Vault is already initialized.',
  VAULT_REQUEST_EXPIRED: 'This Vault unlock request has expired. Request a new unlock card.',
  VAULT_REQUEST_BUSY: 'This Vault unlock request is already being processed.',
  VAULT_CONFLICT: 'Vault changed. Refresh and try again.',
  VAULT_NOT_FOUND: 'Vault item is unavailable.',
  VAULT_FORBIDDEN: 'Vault access is not permitted.',
  VAULT_UNAVAILABLE: 'Vault is unavailable.',
  VAULT_INPUT_UNCONFIRMED: 'Secret input is unconfirmed. Do not retry automatically.',
  VAULT_SESSION_REQUIRED: 'Open a Shower session first.',
  VAULT_INPUT_UNSUPPORTED: 'Secret input is unsupported for this target.',
  VAULT_NOT_CONFIGURED: 'External Vault is not configured.',
  VAULT_NEEDS_LOGIN: 'External Vault is signed out. Call vault_unlock to sign in and unlock privately.',
  VAULT_LOGIN_CHALLENGE: 'The account requires additional login verification.',
  VAULT_CONNECTION_FAILED: 'Vault service is unreachable.',
  VAULT_UNSUPPORTED: 'This Vault operation is not supported by the current Vault source.',
  VAULT_STALE_SESSION: 'Vault session changed. Try again.',
  RUNTIME_BUSY: 'Host is preparing an update.',
});
export const VAULT_ERROR_CODES = Object.freeze(Object.keys(MESSAGES).filter(code => code.startsWith('VAULT_')));
export function vaultError(code) {
  return Object.assign(new Error(MESSAGES[code] ?? MESSAGES.VAULT_UNAVAILABLE), {
    code: Object.hasOwn(MESSAGES, code) ? code : 'VAULT_UNAVAILABLE',
  });
}
export function safeVaultError(error) { return vaultError(error?.code); }
export const VAULT_MAX_ITEMS = 1000;
export function vaultString(value, max, min = 0) {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw vaultError('VAULT_INVALID_ARGUMENT');
  return value;
}
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw vaultError('VAULT_INVALID_ARGUMENT');
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw vaultError('VAULT_INVALID_ARGUMENT');
  return value;
}
export function normalizeVaultItem(item) {
  object(item, ['secretRef', 'label', 'username', 'password', 'allowedBotIds']);
  const value = { label: vaultString(item.label, 200, 1), allowedBotIds: item.allowedBotIds };
  if (!Array.isArray(value.allowedBotIds) || value.allowedBotIds.length > 256) throw vaultError('VAULT_INVALID_ARGUMENT');
  value.allowedBotIds = [...new Set(value.allowedBotIds.map(id => vaultString(id, 128, 1)))];
  if (item.secretRef !== undefined) value.secretRef = vaultString(item.secretRef, 128, 1);
  if (item.username !== undefined) value.username = vaultString(item.username, 320);
  if (item.password !== undefined) value.password = vaultString(item.password, 1000, 1);
  if (!value.secretRef && value.password === undefined) throw vaultError('VAULT_INVALID_ARGUMENT');
  return value;
}
const EXTERNAL_CONTROL_FIELDS = Object.freeze({
  status: [], check: [], logout: [], lock: [], sync: [], list: [],
  configure: ['expectedRevision', 'source', 'serverUrl', 'email'],
  unlock: ['masterPassword', 'expectedEpoch'],
  setGrants: ['expectedRevision', 'secretRef', 'allowedBots'],
});
// 中心外部密码库控制输入（contract §4 联合）：严格白名单 + 有界字符串，秘密字段
// 与普通参数同边界处理，绝不进入日志或反射错误。
export function normalizeExternalVaultControl(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.hasOwn(EXTERNAL_CONTROL_FIELDS, input.action)) throw vaultError('VAULT_INVALID_ARGUMENT');
  object(input, ['action', ...EXTERNAL_CONTROL_FIELDS[input.action]]);
  const value = { action: input.action };
  if (input.action === 'configure') {
    value.expectedRevision = revision(input.expectedRevision);
    if (input.source !== 'local' && input.source !== 'vaultwarden') throw vaultError('VAULT_INVALID_ARGUMENT');
    value.source = input.source;
    if (input.serverUrl !== undefined) value.serverUrl = vaultString(input.serverUrl, 2048, 1);
    if (input.email !== undefined) value.email = vaultString(input.email, 320, 1);
    return value;
  }
  if (input.action === 'setGrants') {
    value.expectedRevision = revision(input.expectedRevision);
    value.secretRef = vaultString(input.secretRef, 128, 1);
    if (!Array.isArray(input.allowedBots) || input.allowedBots.length > 256) throw vaultError('VAULT_INVALID_ARGUMENT');
    value.allowedBots = input.allowedBots.map((grant) => {
      object(grant, ['deviceId', 'botId']);
      return { deviceId: vaultString(grant.deviceId, 128, 1), botId: vaultString(grant.botId, 128, 1) };
    });
    return value;
  }
  for (const key of EXTERNAL_CONTROL_FIELDS[input.action]) {
    value[key] = vaultString(input[key], key === 'expectedEpoch' ? 128 : 1024, 1);
  }
  return value;
}
export function normalizeVaultControl(input) {
  object(input, ['action', 'masterPassword', 'newMasterPassword', 'expectedRevision', 'item', 'secretRef', 'requestId', 'cancelled', 'input']);
  if (input.action === 'external') {
    object(input, ['action', 'input']);
    return { action: 'external', input: normalizeExternalVaultControl(input.input) };
  }
  if (input.action === 'respondUnlock') {
    const requestId = vaultString(input.requestId, 128, 1);
    if (input.cancelled === true) {
      object(input, ['action', 'requestId', 'cancelled']);
      return { action: input.action, requestId, cancelled: true };
    }
    object(input, ['action', 'requestId', 'masterPassword', 'cancelled']);
    if (input.cancelled !== undefined && input.cancelled !== false) throw vaultError('VAULT_INVALID_ARGUMENT');
    return { action: input.action, requestId, masterPassword: vaultString(input.masterPassword, 1024, 1) };
  }
  const fields = {
    status: [], initialize: ['masterPassword'], unlock: ['masterPassword'], lock: [],
    list: [], save: ['expectedRevision', 'item'], delete: ['expectedRevision', 'secretRef'],
    changePassword: ['masterPassword', 'newMasterPassword'],
  };
  if (!Object.hasOwn(fields, input.action)) throw vaultError('VAULT_INVALID_ARGUMENT');
  object(input, ['action', ...fields[input.action]]);
  const value = { action: input.action };
  for (const key of fields[input.action]) {
    if (key === 'item') value.item = normalizeVaultItem(input.item);
    else if (key === 'expectedRevision') value[key] = revision(input[key]);
    else value[key] = vaultString(input[key], key === 'secretRef' ? 128 : 1024, 1);
  }
  return value;
}
export function normalizeVaultTarget(target) {
  object(target, ['x', 'y', 'windowId']);
  for (const key of ['x', 'y', ...(target.windowId === undefined ? [] : ['windowId'])]) {
    if (!Number.isSafeInteger(target[key]) || target[key] < (key === 'windowId' ? 1 : 0) || target[key] > 2147483647) {
      throw vaultError('VAULT_INVALID_ARGUMENT');
    }
  }
  return { x: target.x, y: target.y, ...(target.windowId === undefined ? {} : { windowId: target.windowId }) };
}
