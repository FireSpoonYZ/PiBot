// host-core/bot-browser/desktop-discovery.js
//
// Desktop Chromium-family browser discovery, per-Bot isolated profile directory
// preparation, personal-profile exclusion guard, Linux strict-snap profile
// relocation, and clean child environment isolation.
//
// Portions ported/adapted from Orca v1.4.265 (commit e64e561738d8d465ab459e7e3f9e46d08b6396ea):
//   - src/main/orcad/browser-providers/chromium/external-chromium-profile-path.ts
//   - src/main/orcad/browser-providers/orcad-browser-provider.ts
//   - src/main/browser/agent-browser/helper-process/agent-browser-user-settings-isolation.ts
//
// MIT License — Copyright (c) 2026 Lovecast Inc.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

import { createHash } from 'node:crypto';
import { constants as FS_CONSTANTS } from 'node:fs';
import { access, chmod, mkdir, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import path, { basename, posix, win32 } from 'node:path';
import { assertId } from '../message-protocol.js';
import { browserError, DESKTOP_BROWSER_DEFAULT_VIEWPORT } from './desktop-policy.js';
import { isolateFromUserAgentBrowserSettings } from './vendor/orca/agent-browser-user-settings-isolation.js';
import { resolveExternalChromiumProfilePath } from './vendor/orca/external-chromium-profile-path.js';

export { resolveExternalChromiumProfilePath };

export const SUPPORTED_DESKTOP_PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
export const DESKTOP_BROWSER_EXECUTABLE_ENV = 'PIBOT_BOT_BROWSER_EXECUTABLE';

const DEFAULT_SNAP_ROOTS = Object.freeze(['/snap', '/var/lib/snapd/snap']);

// Additional environment values that Pi Bot keeps out of child browser processes.
const STRIPPED_ENV_PREFIXES = Object.freeze([
  'PIBOT_CENTER_',
  'PIBOT_VAULT_',
]);

const STRIPPED_ENV_KEYS = Object.freeze(new Set([
  'GOOGLE_API_KEY',
  'GOOGLE_DEFAULT_CLIENT_ID',
  'GOOGLE_DEFAULT_CLIENT_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'CHROME_HEADLESS',
  'CHROME_LOG_FILE',
  'ELECTRON_RUN_AS_NODE',
]));

function pathModuleFor(platform) {
  return platform === 'win32' ? win32 : posix;
}

function normalizeForComparison(filePath, platform) {
  const mod = pathModuleFor(platform);
  const resolved = mod.resolve(filePath);
  const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, '') : resolved;
  return platform === 'win32' || platform === 'darwin' ? trimmed.toLowerCase() : trimmed;
}

function isSameOrInsidePath(candidate, root, platform) {
  const normCandidate = normalizeForComparison(candidate, platform);
  const normRoot = normalizeForComparison(root, platform);
  if (normCandidate === normRoot) return true;
  const sep = platform === 'win32' ? '\\' : '/';
  return normCandidate.startsWith(normRoot.endsWith(sep) ? normRoot : normRoot + sep);
}

/**
 * Known personal browser profile roots that PiBot must NEVER open, attach to,
 * or share with a Bot browser session.
 */
export function personalBrowserProfileRoots({
  platform = process.platform,
  homePath = homedir(),
  env = process.env,
} = {}) {
  const p = pathModuleFor(platform);
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || p.join(homePath, 'AppData', 'Local');
    return [
      p.join(localAppData, 'Google', 'Chrome', 'User Data'),
      p.join(localAppData, 'Google', 'Chrome Beta', 'User Data'),
      p.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
      p.join(localAppData, 'Chromium', 'User Data'),
      p.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      p.join(localAppData, 'Microsoft', 'Edge Beta', 'User Data'),
      p.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    ];
  }
  if (platform === 'darwin') {
    const appSupport = p.join(homePath, 'Library', 'Application Support');
    return [
      p.join(appSupport, 'Google', 'Chrome'),
      p.join(appSupport, 'Google', 'Chrome Beta'),
      p.join(appSupport, 'Google', 'Chrome Canary'),
      p.join(appSupport, 'Chromium'),
      p.join(appSupport, 'Microsoft Edge'),
      p.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
    ];
  }
  const configHome = env.XDG_CONFIG_HOME || p.join(homePath, '.config');
  return [
    p.join(configHome, 'google-chrome'),
    p.join(configHome, 'google-chrome-beta'),
    p.join(configHome, 'chromium'),
    p.join(configHome, 'microsoft-edge'),
    p.join(configHome, 'BraveSoftware', 'Brave-Browser'),
    p.join(homePath, 'snap', 'chromium', 'common', 'chromium'),
  ];
}

export function isPersonalBrowserProfilePath(candidatePath, context = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return false;
  const platform = context.platform ?? process.platform;
  const roots = personalBrowserProfileRoots(context);
  return roots.some(
    (root) =>
      isSameOrInsidePath(candidatePath, root, platform) ||
      isSameOrInsidePath(root, candidatePath, platform)
  );
}

/**
 * Isolate the Chromium child process from user AGENT_BROWSER_* overrides and
 * sensitive Google/PiBot environment variables (adapted from Orca MIT).
 */
export function isolateChildBrowserEnvironment(inheritedEnv = process.env) {
  const isolated = isolateFromUserAgentBrowserSettings(inheritedEnv, []);
  const clean = {};
  for (const [key, value] of Object.entries(isolated)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (STRIPPED_ENV_KEYS.has(upper)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    clean[key] = value;
  }
  return clean;
}

export async function defaultProbeExecutable(filePath, platform = process.platform) {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return 'missing';
  } catch {
    return 'missing';
  }
  if (platform === 'win32') {
    return 'ok';
  }
  try {
    await access(filePath, FS_CONSTANTS.X_OK);
    return 'ok';
  } catch {
    return 'not_executable';
  }
}

function inferBrowserKind(executablePath) {
  const lower = basename(executablePath).toLowerCase();
  const fullLower = executablePath.toLowerCase();
  if (lower.includes('msedge') || fullLower.includes('microsoft edge') || fullLower.includes('microsoft-edge')) {
    return 'edge';
  }
  if (lower.includes('brave') || fullLower.includes('brave')) {
    return 'brave';
  }
  if (lower.includes('chromium') || fullLower.includes('chromium')) {
    return 'chromium';
  }
  if (lower.includes('chrome') || fullLower.includes('google chrome')) {
    return 'chrome';
  }
  return 'custom';
}

export function desktopBrowserCandidates({
  platform = process.platform,
  homePath = homedir(),
  env = process.env,
  managedDir = null,
} = {}) {
  const p = pathModuleFor(platform);
  const candidates = [];
  const seen = new Set();
  const push = (filePath, kind) => {
    if (!filePath || typeof filePath !== 'string') return;
    const key = normalizeForComparison(filePath, platform);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ executablePath: filePath, kind });
  };

  if (managedDir) {
    if (platform === 'win32') {
      push(p.join(managedDir, 'chrome.exe'), 'chromium');
      push(p.join(managedDir, 'chromium.exe'), 'chromium');
    } else if (platform === 'darwin') {
      push(p.join(managedDir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), 'chromium');
      push(p.join(managedDir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'), 'chrome');
      push(p.join(managedDir, 'chrome'), 'chromium');
    } else {
      push(p.join(managedDir, 'chrome'), 'chromium');
      push(p.join(managedDir, 'chromium'), 'chromium');
    }
  }

  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const root of roots) {
      push(p.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), 'chrome');
    }
    for (const root of roots) {
      push(p.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), 'edge');
    }
    for (const root of roots) {
      push(p.join(root, 'Chromium', 'Application', 'chrome.exe'), 'chromium');
    }
    for (const root of roots) {
      push(p.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), 'brave');
    }
    return candidates;
  }

  if (platform === 'darwin') {
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'chrome');
    push(p.join(homePath, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'), 'chrome');
    push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'edge');
    push(p.join(homePath, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'), 'edge');
    push('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium');
    push(p.join(homePath, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), 'chromium');
    push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'brave');
    push(p.join(homePath, 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser'), 'brave');
    return candidates;
  }

  if (platform === 'linux') {
    const names = [
      ['google-chrome-stable', 'chrome'],
      ['google-chrome', 'chrome'],
      ['chromium', 'chromium'],
      ['chromium-browser', 'chromium'],
      ['microsoft-edge-stable', 'edge'],
      ['microsoft-edge', 'edge'],
      ['brave-browser', 'brave'],
    ];
    const dirs = [
      '/usr/bin',
      '/usr/local/bin',
      '/snap/bin',
      '/var/lib/snapd/snap/bin',
      ...String(env.PATH || '')
        .split(':')
        .filter((dir) => dir && dir.startsWith('/')),
    ];
    for (const [binName, kind] of names) {
      for (const dir of dirs) {
        push(p.join(dir, binName), kind);
      }
    }
    push('/opt/google/chrome/chrome', 'chrome');
    push('/opt/microsoft/msedge/msedge', 'edge');
    push('/opt/brave.com/brave/brave-browser', 'brave');
    return candidates;
  }

  return candidates;
}

export function defaultTransportForPlatform(platform = process.platform, requested = undefined) {
  if (requested === 'pipe' || requested === 'loopback') {
    return requested;
  }
  // POSIX supports native private stdio pipe (--remote-debugging-pipe, zero TCP ports).
  // Windows uses ephemeral 127.0.0.1 loopback-only DevTools WebSocket.
  return platform === 'win32' ? 'loopback' : 'pipe';
}

/**
 * Discover a locally installed or project-managed Chromium-family browser
 * without requiring Orca or manual user configuration.
 */
export async function discoverDesktopBrowser(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const homePath = opts.homePath ?? homedir();
  const probeExecutable = opts.probeExecutable ?? ((filePath) => defaultProbeExecutable(filePath, platform));
  const transport = defaultTransportForPlatform(platform, opts.transport);

  if (!SUPPORTED_DESKTOP_PLATFORMS.includes(platform)) {
    return {
      available: false,
      reason: 'desktop_platform_unsupported',
      detail: `Desktop Bot browser is not supported on platform '${platform}'.`,
      executablePath: null,
      kind: 'none',
      transport: null,
    };
  }

  const explicit = (opts.executablePath ?? env[DESKTOP_BROWSER_EXECUTABLE_ENV] ?? '').trim();
  if (explicit) {
    const p = pathModuleFor(platform);
    if (!p.isAbsolute(explicit)) {
      return {
        available: false,
        reason: 'executable_not_found',
        detail: 'Configured desktop browser executable must be an absolute path.',
        executablePath: null,
        kind: 'none',
        transport: null,
      };
    }
    const probe = await probeExecutable(explicit);
    if (probe !== 'ok') {
      return {
        available: false,
        reason: probe === 'not_executable' ? 'executable_not_executable' : 'executable_not_found',
        detail:
          probe === 'not_executable'
            ? `Configured browser executable is not executable: ${explicit}`
            : `Configured browser executable was not found: ${explicit}`,
        executablePath: null,
        kind: 'none',
        transport: null,
      };
    }
    return {
      available: true,
      reason: null,
      detail: null,
      executablePath: explicit,
      kind: inferBrowserKind(explicit),
      transport,
    };
  }

  const candidates = desktopBrowserCandidates({
    platform,
    homePath,
    env,
    managedDir: opts.managedDir ?? null,
  });

  for (const candidate of candidates) {
    const probe = await probeExecutable(candidate.executablePath);
    if (probe === 'ok') {
      return {
        available: true,
        reason: null,
        detail: null,
        executablePath: candidate.executablePath,
        kind: candidate.kind,
        transport,
      };
    }
  }

  return {
    available: false,
    reason: 'browser_executable_not_found',
    detail:
      'No supported Chrome, Edge, Chromium, or Brave executable was found on this desktop host.',
    executablePath: null,
    kind: 'none',
    transport: null,
  };
}

export function botProfileIdentity(botId, baseDir) {
  return createHash('sha256').update(`${botId}\u0000${baseDir}`).digest('hex').slice(0, 16);
}

/**
 * Resolve, validate, and ensure a strictly private per-Bot profile directory.
 * Rejects personal Chrome/Edge/Chromium/Brave directories unconditionally.
 */
export async function prepareBotProfileDir({
  botId,
  profileDir,
  dataDir,
  executablePath,
  platform = process.platform,
  env = process.env,
  homePath = homedir(),
  snapRoots = DEFAULT_SNAP_ROOTS,
  passwdHomePath = null,
} = {}) {
  assertId(botId, 'botId');

  const p = pathModuleFor(platform);
  let targetDir = null;
  if (typeof profileDir === 'string' && profileDir.trim()) {
    targetDir = p.resolve(profileDir.trim());
  } else if (typeof dataDir === 'string' && dataDir.trim()) {
    const hash = createHash('sha256').update(botId).digest('hex').slice(0, 24);
    targetDir = p.join(p.resolve(dataDir.trim()), 'bot-browser', 'profiles', hash);
  } else {
    throw browserError(
      'BROWSER_PROFILE_UNCONFIGURED',
      'Desktop browser provider requires an isolated profileDir or dataDir.'
    );
  }

  if (isPersonalBrowserProfilePath(targetDir, { platform, homePath, env })) {
    throw browserError(
      'BROWSER_UNSAFE_PROFILE_DIR',
      'Refusing to launch Bot browser using a personal browser profile directory.'
    );
  }

  let effectiveDir = targetDir;
  if (executablePath && platform === 'linux') {
    const identity = botProfileIdentity(botId, targetDir);
    effectiveDir = await resolveExternalChromiumProfilePath(executablePath, targetDir, identity, {
      platform,
      snapRoots,
      homePath: passwdHomePath ?? (() => userInfo().homedir),
    });
    if (isPersonalBrowserProfilePath(effectiveDir, { platform, homePath, env })) {
      throw browserError(
        'BROWSER_UNSAFE_PROFILE_DIR',
        'Resolved profile path collides with a personal browser profile directory.'
      );
    }
  }

  try {
    await mkdir(effectiveDir, { recursive: true, mode: 0o700 });
    if (platform !== 'win32') {
      await chmod(effectiveDir, 0o700);
    }
    await access(effectiveDir, FS_CONSTANTS.W_OK);
  } catch (err) {
    throw browserError(
      'BROWSER_PROFILE_UNWRITABLE',
      `Bot browser profile directory is not writable: ${err?.message || 'permission denied'}`
    );
  }

  return effectiveDir;
}

/**
 * Hardened Chromium launch flags: headless compositor, isolated per-Bot profile,
 * zero extensions, zero sync, zero public debugging ports, never disabling web
 * security or certificate verification.
 */
export function buildChromiumLaunchArgs({
  profilePath,
  transport = 'pipe',
  viewport = DESKTOP_BROWSER_DEFAULT_VIEWPORT,
  platform = process.platform,
} = {}) {
  if (typeof profilePath !== 'string' || !profilePath.trim()) {
    throw browserError('INVALID_ARGUMENT', 'profilePath is required to launch Chromium');
  }
  if (transport !== 'pipe' && transport !== 'loopback') {
    throw browserError('INVALID_ARGUMENT', `Unsupported CDP transport: ${String(transport)}`);
  }

  const args = [
    '--headless=new',
    `--user-data-dir=${profilePath}`,
    `--window-size=${viewport.width},${viewport.height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--hide-scrollbars',
  ];

  if (platform === 'linux') {
    // Avoid renderer crashes in container environments with small /dev/shm without relaxing sandbox.
    args.push('--disable-dev-shm-usage');
  }

  if (transport === 'pipe') {
    args.push('--remote-debugging-pipe');
  } else {
    // Ephemeral loopback-only port (Chromium binds 127.0.0.1); never --remote-allow-origins=*
    // and never 0.0.0.0.
    args.push('--remote-debugging-port=0');
  }

  args.push('about:blank');
  return args;
}

export function resolveManagedBrowserDir(baseDir) {
  if (!baseDir) return null;
  return path.join(baseDir, 'managed-install', 'chromium');
}
