// Adapted from stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea (MIT License, Copyright (c) 2026 Lovecast Inc.)
// Adapted for PiBot Center Web application OAuth client configuration.
//
// Validates and normalizes the Center's single Google Web application OAuth
// client configuration (either imported from a downloaded Web client JSON file
// or entered directly as clientId + clientSecret). Fixed HTTPS redirectUri is
// derived exclusively from Center's publicUrl; auth_uri / token_uri in uploaded
// JSON files are never trusted or stored.

export const GOOGLE_CALLBACK_PATH = '/api/oauth/google/callback';
export const GOOGLE_CLIENT_FILE_MAX_BYTES = 64 * 1024;
export const GOOGLE_CREDENTIALS_PAGE = 'https://console.cloud.google.com/apis/credentials';

const CLIENT_ID_PATTERN = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const MAX_CLIENT_ID_LEN = 512;
const MAX_CLIENT_SECRET_LEN = 512;
const MAX_PROJECT_ID_LEN = 256;
const MAX_REDIRECT_URIS = 100;
const CONTROL_OR_SPACE_PATTERN = /[\x00-\x20\x7f]/;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;

const WEB_CLIENT_STEPS =
  `In Google Cloud Console, open Credentials (${GOOGLE_CREDENTIALS_PAGE}), choose Create credentials > OAuth client ID > Web application, add the Center redirect URI, then download its JSON file.`;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates Center's public HTTPS origin and returns the fixed Google OAuth
 * callback URL (`https://<origin>/api/oauth/google/callback`).
 */
export function resolveGoogleRedirectUri(publicUrl) {
  if (typeof publicUrl !== 'string' || publicUrl.trim() === '') {
    throw fail('INVALID_ARGUMENT', 'publicUrl is required');
  }
  let parsed;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw fail('INVALID_ARGUMENT', 'publicUrl must be a valid HTTPS origin');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  ) {
    throw fail('INVALID_ARGUMENT', 'publicUrl must be an HTTPS origin (scheme, host and optional port only)');
  }
  return new URL(GOOGLE_CALLBACK_PATH, parsed.origin).href;
}

function validateClientId(value) {
  if (typeof value !== 'string') {
    throw fail('INVALID_ARGUMENT', 'Google OAuth client_id is required.');
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CLIENT_ID_LEN ||
    !CLIENT_ID_PATTERN.test(trimmed)
  ) {
    throw fail(
      'INVALID_ARGUMENT',
      'Invalid Google OAuth client_id (expected *.apps.googleusercontent.com).'
    );
  }
  return trimmed;
}

function validateClientSecret(value) {
  if (typeof value !== 'string') {
    throw fail('INVALID_ARGUMENT', 'Google OAuth client_secret is required.');
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CLIENT_SECRET_LEN ||
    CONTROL_OR_SPACE_PATTERN.test(trimmed)
  ) {
    throw fail('INVALID_ARGUMENT', 'Invalid Google OAuth client_secret.');
  }
  return trimmed;
}

function validateOptionalProjectId(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw fail('INVALID_ARGUMENT', 'Invalid Google project_id.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > MAX_PROJECT_ID_LEN || CONTROL_PATTERN.test(trimmed)) {
    throw fail('INVALID_ARGUMENT', 'Invalid Google project_id.');
  }
  return trimmed;
}

function hasEmbeddedUserTokens(record) {
  if (!isPlainObject(record)) return false;
  return (
    record.type === 'authorized_user' ||
    'refresh_token' in record ||
    'access_token' in record ||
    'id_token' in record
  );
}

/**
 * Parses and strictly validates a Google Cloud Console Web application OAuth
 * client JSON file against the Center's fixed HTTPS redirectUri.
 *
 * Refuses service-account keys, Desktop (`installed`) clients, saved user token
 * files (`authorized_user` / refresh_token / access_token), oversized payloads,
 * and Web clients whose registered `redirect_uris` omit `expectedRedirectUri`.
 * Ignores any `auth_uri` / `token_uri` fields from the uploaded file.
 */
export function parseGoogleWebClientFile(fileText, expectedRedirectUri) {
  if (typeof fileText !== 'string' || fileText.trim().length === 0) {
    throw fail('INVALID_ARGUMENT', `A Google Web OAuth client JSON file is required. ${WEB_CLIENT_STEPS}`);
  }
  if (Buffer.byteLength(fileText, 'utf8') > GOOGLE_CLIENT_FILE_MAX_BYTES) {
    throw fail(
      'PAYLOAD_TOO_LARGE',
      `This file exceeds the ${GOOGLE_CLIENT_FILE_MAX_BYTES} byte limit for a Google OAuth client file. ${WEB_CLIENT_STEPS}`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw fail('INVALID_ARGUMENT', `This is not a valid Google client JSON file. ${WEB_CLIENT_STEPS}`);
  }
  if (!isPlainObject(parsed)) {
    throw fail('INVALID_ARGUMENT', `This is not a valid Google OAuth client file. ${WEB_CLIENT_STEPS}`);
  }

  if (parsed.type === 'service_account' || 'private_key' in parsed) {
    throw fail(
      'INVALID_ARGUMENT',
      `This is a service-account key, which cannot sign a person in. Create a Web application OAuth client instead. ${WEB_CLIENT_STEPS}`
    );
  }
  if (hasEmbeddedUserTokens(parsed)) {
    throw fail(
      'INVALID_ARGUMENT',
      `This is a saved Google sign-in token file, not a Web OAuth client file. Do not upload user tokens. ${WEB_CLIENT_STEPS}`
    );
  }
  if ('installed' in parsed) {
    throw fail(
      'INVALID_ARGUMENT',
      `This is a Desktop app ("installed") OAuth client file. Center requires a Web application ("web") OAuth client. ${WEB_CLIENT_STEPS}`
    );
  }
  if (!('web' in parsed) || !isPlainObject(parsed.web)) {
    throw fail(
      'INVALID_ARGUMENT',
      `This is not a Google Web application OAuth client file (missing top-level "web" object). ${WEB_CLIENT_STEPS}`
    );
  }

  const web = parsed.web;
  if (hasEmbeddedUserTokens(web)) {
    throw fail(
      'INVALID_ARGUMENT',
      `This file contains user token fields and is not a valid Web OAuth client file. ${WEB_CLIENT_STEPS}`
    );
  }

  const clientId = validateClientId(web.client_id);
  const clientSecret = validateClientSecret(web.client_secret);
  const projectId = validateOptionalProjectId(web.project_id);

  if (!Array.isArray(web.redirect_uris) || web.redirect_uris.length === 0) {
    throw fail(
      'INVALID_ARGUMENT',
      `This Web OAuth client file has no registered redirect_uris. Add "${expectedRedirectUri}" as an Authorized redirect URI in Google Cloud Console and download the JSON again.`
    );
  }
  if (web.redirect_uris.length > MAX_REDIRECT_URIS) {
    throw fail('INVALID_ARGUMENT', 'Too many redirect_uris in Google Web OAuth client file.');
  }
  const hasMatchingRedirect = web.redirect_uris.some(
    (entry) => typeof entry === 'string' && entry.trim() === expectedRedirectUri
  );
  if (!hasMatchingRedirect) {
    throw fail(
      'INVALID_ARGUMENT',
      `This Web OAuth client file does not include Center's fixed Authorized redirect URI ("${expectedRedirectUri}"). Add it in Google Cloud Console and re-download the JSON.`
    );
  }

  return {
    clientId,
    clientSecret,
    ...(projectId ? { projectId } : {}),
  };
}

/**
 * Validates the `manage('configure', input)` payload.
 * Automatic first-time setup requires a Web JSON file for the exact project.
 */
export function parseGoogleClientConfigureInput(input, expectedRedirectUri) {
  if (!isPlainObject(input)) {
    throw fail('INVALID_ARGUMENT', 'Expected a configuration object.');
  }
  const allowedKeys = new Set(['clientFile', 'clientId', 'clientSecret', 'projectId', 'ifUnconfigured']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) {
      throw fail('INVALID_ARGUMENT', `Unexpected configuration field: ${key}`);
    }
  }

  const hasFile = input.clientFile !== undefined && input.clientFile !== null;
  const hasDirect = input.clientId !== undefined || input.clientSecret !== undefined;
  const automatic = input.ifUnconfigured === true;
  if (input.ifUnconfigured !== undefined && (!automatic || !hasFile || !input.projectId)) {
    throw fail('INVALID_ARGUMENT', 'Automatic Google setup requires a Web client file and project ID.');
  }
  if (hasFile && hasDirect) {
    throw fail(
      'INVALID_ARGUMENT',
      'Provide either clientFile or clientId/clientSecret, not both.'
    );
  }

  if (hasFile) {
    const parsed = parseGoogleWebClientFile(input.clientFile, expectedRedirectUri);
    const overrideProjectId = validateOptionalProjectId(input.projectId);
    if (automatic && (!overrideProjectId || parsed.projectId !== overrideProjectId)) {
      throw fail('INVALID_ARGUMENT', 'The Google Web OAuth client file is not for this project.');
    }
    const projectId = overrideProjectId ?? parsed.projectId;
    return {
      clientId: parsed.clientId,
      clientSecret: parsed.clientSecret,
      ...(projectId ? { projectId } : {}),
    };
  }

  if (!hasDirect) {
    throw fail(
      'INVALID_ARGUMENT',
      'Provide a Web OAuth clientFile or both clientId and clientSecret.'
    );
  }

  const clientId = validateClientId(input.clientId);
  const clientSecret = validateClientSecret(input.clientSecret);
  const projectId = validateOptionalProjectId(input.projectId);
  return {
    clientId,
    clientSecret,
    ...(projectId ? { projectId } : {}),
  };
}
