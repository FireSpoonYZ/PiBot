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
export function normalizeVaultControl(input) {
  object(input, ['action', 'masterPassword', 'newMasterPassword', 'expectedRevision', 'item', 'secretRef', 'requestId', 'cancelled']);
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
