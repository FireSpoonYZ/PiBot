import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const petCss = readFileSync(new URL('../../desktop/web/src/pet/pet.css', import.meta.url), 'utf8');
const petAppTsx = readFileSync(new URL('../../desktop/web/src/pet/PetApp.tsx', import.meta.url), 'utf8');
const petProtocolTs = readFileSync(new URL('../../desktop/web/src/pet/protocol.ts', import.meta.url), 'utf8');

function extractRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gm');
  const blocks = [...css.matchAll(pattern)].map((match) => match[1]);
  assert.ok(blocks.length > 0, `Expected CSS rule for ${selector}`);
  return blocks.join('\n');
}

test('pet.css guards against implicit focus scroll and transitional flex-end top-left clipping', () => {
  const rootRule = extractRule(petCss, '#root');
  const stageRule = extractRule(petCss, '.pet-stage');
  assert.match(rootRule, /overflow\s*:\s*hidden\s*;/);
  assert.match(rootRule, /overflow\s*:\s*clip\s*;/, 'html/body/#root must use overflow: clip to block implicit scroll offsets');
  assert.match(stageRule, /overflow\s*:\s*hidden\s*;/);
  assert.match(stageRule, /overflow\s*:\s*clip\s*;/, '.pet-stage must use overflow: clip to block implicit scroll offsets');

  // During opening/closing transitions (composer unmounted while window height changes),
  // stage must anchor vertically to flex-start so mascot never drops or jumps toward top-left.
  const stageOpening = extractRule(petCss, '.pet-stage[data-composer-phase="opening"]');
  const stageClosing = extractRule(petCss, '.pet-stage[data-composer-phase="closing"]');
  assert.match(stageOpening, /justify-content\s*:\s*flex-start\s*;/);
  assert.match(stageClosing, /justify-content\s*:\s*flex-start\s*;/);

  // Hover rail must be visually hidden without changing .pet-dock layout width during transitions
  for (const phase of ['opening', 'closing']) {
    const railRule = extractRule(petCss, `.pet-stage[data-composer-phase="${phase}"] .pet-hover-rail`);
    assert.match(railRule, /opacity\s*:\s*0\s*;/);
    assert.match(railRule, /visibility\s*:\s*hidden\s*;/);
    assert.match(railRule, /pointer-events\s*:\s*none\s*;/);
  }
});

test('PetApp.tsx wires the two-phase composer state machine and removes extra rAF layout delay', () => {
  assert.match(petAppTsx, /from '\.\/composerLayout'/);
  for (const symbol of [
    'beginComposerOpen',
    'ackComposerOpenNative',
    'canCommitComposerOpen',
    'commitComposerOpen',
    'beginComposerClose',
    'completeComposerClose',
    'forceCloseComposer',
    'evaluateComposerFocusEvent',
    'planComposerOpenLayout',
    'planComposerCloseLayout',
    'shouldRenderComposer',
    'shouldHoldOrientationUpdate',
    'shouldSyncNormalNativeLayout',
    'mergePetOrientation',
    'doesViewportMatchLayout',
  ]) {
    assert.match(petAppTsx, new RegExp(`\\b${symbol}\\b`), `PetApp.tsx must use ${symbol} from composerLayout`);
  }

  // Composer mounts strictly via phase-gated shouldRenderComposer, never raw boolean toggle
  assert.match(petAppTsx, /const showComposer = shouldRenderComposer\(composerPhase,\s*settingsOpen\)/);
  assert.match(petAppTsx, /data-composer-phase=\{composerPhase\}/);

  // Two-phase open: request native expansion before mounting composer, then commit after viewport readiness
  assert.match(petAppTsx, /beginComposerOpen\([\s\S]*?petWindow\('set-layout'[\s\S]*?ackComposerOpenNative\(/);
  assert.match(petAppTsx, /canCommitComposerOpen\([\s\S]*?commitComposerOpen\(/);

  // Two-phase close: unmount composer first in 'closing', wait a paint frame, then shrink native window
  assert.match(
    petAppTsx,
    /beginComposerClose\([\s\S]*?requestAnimationFrame\([\s\S]*?planComposerCloseLayout\([\s\S]*?petWindow\('set-layout'[\s\S]*?completeComposerClose\(/,
  );

  // Normal useLayoutEffect sync runs without an extra requestAnimationFrame hop
  assert.doesNotMatch(
    petAppTsx,
    /useLayoutEffect\(\(\)\s*=>\s*\{\s*const raf = requestAnimationFrame\(syncNativeLayout\)/,
    'useLayoutEffect must not re-introduce an extra rAF frame before syncNativeLayout',
  );
});

test('PetApp.tsx locks scroll offsets on focus and routes all focus/dismiss paths through composerLayout', () => {
  assert.match(petAppTsx, /focus\(\{\s*preventScroll:\s*true\s*\}\)/);
  assert.doesNotMatch(
    petAppTsx,
    /composerRef\.current\?\.focus\(/,
    'all programmatic composer focus calls must go through focusComposerNoScroll (preventScroll: true)',
  );
  assert.match(petAppTsx, /scrollLeft\s*=\s*0/);
  assert.match(petAppTsx, /scrollTop\s*=\s*0/);

  for (const kind of ['native-focus', 'window-focus', 'window-blur', 'composer-focus', 'composer-blur']) {
    assert.match(
      petAppTsx,
      new RegExp(`kind:\\s*'${kind}'`),
      `PetApp.tsx must route ${kind} events through evaluateComposerFocusEvent`,
    );
  }

  // Escape & avatar click toggle stay wired to requestOpenComposer / requestCloseComposer
  assert.match(petAppTsx, /event\.key !== 'Escape'[\s\S]*?requestCloseComposer\(\)/);
  assert.match(petAppTsx, /requestOpenComposer\(\)/);
  assert.match(petAppTsx, /requestCloseComposer\(\)/);

  // Protocol exposes optional native work-area capped dimensions on DesktopPetWindowState
  const windowStateBlock = petProtocolTs.match(/export interface DesktopPetWindowState\s*\{([^}]*)\}/);
  assert.ok(windowStateBlock, 'Expected DesktopPetWindowState interface in protocol.ts');
  assert.match(windowStateBlock[1], /width\?\s*:\s*number\s*;/);
  assert.match(windowStateBlock[1], /height\?\s*:\s*number\s*;/);
});

test('PetApp.tsx commits open orientation synchronously via flushSync and clears avatarPressValidRef on pointer release', () => {
  // 1. Synchronous flushSync commit eliminates 1-frame right/left -> center jump in React 19 ResizeObserver
  assert.match(petAppTsx, /import\s*\{[^}]*\bflushSync\b[^}]*\}\s*from\s*'react-dom'/);
  assert.match(
    petAppTsx,
    /tryCommitComposerOpen[\s\S]*?commitComposerOpen\([\s\S]*?flushSync\(\(\)\s*=>\s*\{[\s\S]*?setLayout\([\s\S]*?updateComposerState\(nextState\);[\s\S]*?\}\);[\s\S]*?resetStageScroll\(\);/,
  );

  // 2. .pet-avatar clears avatarPressValidRef after pointerup / lostpointercapture via macrotask setTimeout(..., 0)
  //    so a 1-5px press-release without click never permanently locks blur dismissal
  assert.match(
    petAppTsx,
    /scheduleAvatarPressReset[\s\S]*?setTimeout\(\(\)\s*=>\s*\{[\s\S]*?if\s*\(!pointerRef\.current\)\s*\{[\s\S]*?avatarPressValidRef\.current\s*=\s*false;[\s\S]*?\}\s*\},\s*0\);/,
  );
  assert.doesNotMatch(
    petAppTsx,
    /queueMicrotask\([^)]*avatarPressValidRef/,
    'avatarPressValidRef reset must use macrotask setTimeout(..., 0), not queueMicrotask (which runs before click)',
  );
  assert.match(
    petAppTsx,
    /className="pet-avatar"[\s\S]*?onPointerUp=\{\(\)\s*=>\s*\{[\s\S]*?pointerRef\.current\s*=\s*null;[\s\S]*?scheduleAvatarPressReset\(\);[\s\S]*?\}\}/,
  );
  assert.match(
    petAppTsx,
    /className="pet-avatar"[\s\S]*?onLostPointerCapture=\{\(\)\s*=>\s*\{[\s\S]*?pointerRef\.current\s*=\s*null;[\s\S]*?scheduleAvatarPressReset\(\);[\s\S]*?\}\}/,
  );
  assert.match(petAppTsx, /clearAvatarPressResetTimer\(\);[\s\S]*?voice\.dispose\(\);/);

  // 3. Context menu quick-prompt closes settings panel before opening composer
  assert.match(
    petAppTsx,
    /setSettingsOpen\(false\);\s*requestOpenComposer\(\{\s*ignoreCurrentBubble:\s*true\s*\}\);/,
  );
});
