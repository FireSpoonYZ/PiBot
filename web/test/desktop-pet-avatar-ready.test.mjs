import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  INITIAL_RESOLVED_PET_AVATAR_STATE,
  resolvePetAvatarState,
  sameBotAvatar,
} from '../../desktop/web/src/pet/avatarReady.ts';
import { INITIAL_PET_SNAPSHOT } from '../../desktop/web/src/pet/protocol.ts';

const petAppTsx = readFileSync(new URL('../../desktop/web/src/pet/PetApp.tsx', import.meta.url), 'utf8');
const petCss = readFileSync(new URL('../../desktop/web/src/pet/pet.css', import.meta.url), 'utf8');
const petProtocolTs = readFileSync(new URL('../../desktop/web/src/pet/protocol.ts', import.meta.url), 'utf8');
const desktopPetRs = readFileSync(new URL('../../desktop/src-tauri/src/desktop_pet.rs', import.meta.url), 'utf8');

const DEFAULT_BLUE_CIRCLE = {
  id: 'jarvis-blue',
  shape: 'blob',
  color: '#2B70F6',
  rotation: 0,
  expressionIndex: 0,
  labelZh: '经典蓝',
  labelEn: 'Classic Blue',
};

const PINK_PEBBLE = {
  id: 'pink-pebble',
  shape: 'pebble',
  color: '#DF4191',
  rotation: -14,
  expressionIndex: 1,
  labelZh: '粉红胶囊',
  labelEn: 'Pink Pebble',
};

const EMERALD_LEAF = {
  id: 'emerald-leaf',
  shape: 'leaf',
  color: '#4EBD64',
  rotation: -10,
  expressionIndex: 5,
  labelZh: '翠绿果实',
  labelEn: 'Green Fruit',
};

function makeResolver(savedMap = {}) {
  return {
    resolvePreset: (botKey) => savedMap[botKey] ?? DEFAULT_BLUE_CIRCLE,
    getDefaultPreset: () => DEFAULT_BLUE_CIRCLE,
  };
}

test('resolvePetAvatarState never yields a fallback blue circle before avatarReady becomes true', () => {
  const resolver = makeResolver();

  // Initial cold-start snapshot
  const s0 = resolvePetAvatarState(INITIAL_PET_SNAPSHOT, INITIAL_RESOLVED_PET_AVATAR_STATE, resolver);
  assert.equal(s0.avatar, null);
  assert.equal(s0.seedKey, '');

  // Pre-connect offline snapshot before Center finishes connecting
  const s1 = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: null,
      botName: 'PiBot',
      avatar: null,
      avatarReady: false,
    },
    s0,
    resolver,
  );
  assert.equal(s1.avatar, null);

  // Authoritative custom avatar arrives from bot_directory
  const s2 = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: 'main-1',
      botName: 'Luna',
      avatar: PINK_PEBBLE,
      avatarReady: true,
      avatarRevision: 2,
    },
    s1,
    resolver,
  );
  assert.deepEqual(s2.avatar, PINK_PEBBLE);
  assert.equal(s2.seedKey, 'local-device:main-1');

  // Re-receiving an equivalent JSON-cloned avatar keeps object identity stable (no effect churn)
  const s2Clone = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: 'main-1',
      botName: 'Luna',
      avatar: { ...PINK_PEBBLE },
      avatarReady: true,
      avatarRevision: 2,
    },
    s2,
    resolver,
  );
  assert.equal(s2Clone, s2);
  assert.equal(sameBotAvatar(s2.avatar, { ...PINK_PEBBLE }), true);

  // Subsequent transient disconnect / main window reload retains previous real avatar instead of flashing blue circle
  const s3 = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: null,
      botName: 'PiBot',
      avatar: null,
      avatarReady: false,
    },
    s2,
    resolver,
  );
  assert.equal(s3, s2);
  assert.deepEqual(s3.avatar, PINK_PEBBLE);
  assert.equal(s3.seedKey, 'local-device:main-1');

  // Reconnected with an updated avatar replaces the previous one cleanly
  const s4 = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: 'main-1',
      botName: 'Luna',
      avatar: EMERALD_LEAF,
      avatarReady: true,
      avatarRevision: 3,
    },
    s3,
    resolver,
  );
  assert.deepEqual(s4.avatar, EMERALD_LEAF);
});

test('resolvePetAvatarState distinguishes legacy local override (rev 0) from Center reset-to-default (rev > 0)', () => {
  const resolver = makeResolver({ 'local-device:main-1': PINK_PEBBLE });

  // Legacy local override (avatarRevision === 0 and avatar === null) uses saved preset
  const legacy = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: 'main-1',
      botName: 'Luna',
      avatar: null,
      avatarReady: true,
      avatarRevision: 0,
    },
    INITIAL_RESOLVED_PET_AVATAR_STATE,
    resolver,
  );
  assert.deepEqual(legacy.avatar, PINK_PEBBLE);

  // Center explicit reset-to-default (avatarRevision > 0 and avatar === null) ignores stale localStorage entry
  const reset = resolvePetAvatarState(
    {
      deviceId: 'local-device',
      botId: 'main-1',
      botName: 'Luna',
      avatar: null,
      avatarReady: true,
      avatarRevision: 4,
    },
    legacy,
    resolver,
  );
  assert.deepEqual(reset.avatar, DEFAULT_BLUE_CIRCLE);
});

test('desktop pet startup reveal contract defers native window show and avatar mount until avatar is ready', () => {
  assert.match(petProtocolTs, /'reveal'/);
  assert.match(petProtocolTs, /avatarReady:\s*boolean\s*;/);
  assert.match(petAppTsx, /resolvePetAvatarState/);
  assert.match(petAppTsx, /data-avatar-ready=\{hasResolvedAvatar \? 'true' : 'false'\}/);
  assert.match(petAppTsx, /\{resolvedAvatar \? \([\s\S]*?<GrokBotAnimatedMark/);
  assert.match(petAppTsx, /petWindow\('reveal'\)/);
  assert.match(petCss, /\.pet-stage\[data-avatar-ready="false"\]\s*\{[\s\S]*?visibility:\s*hidden\s*;/);
  assert.match(desktopPetRs, /"reveal"\s*=>/);
  assert.match(desktopPetRs, /should_show_window_on_show_action/);
  assert.match(desktopPetRs, /should_show_window_on_reveal_action/);
});
