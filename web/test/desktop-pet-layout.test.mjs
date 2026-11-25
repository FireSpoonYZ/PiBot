import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const petCss = readFileSync(new URL('../../desktop/web/src/pet/pet.css', import.meta.url), 'utf8');
const petAppTsx = readFileSync(new URL('../../desktop/web/src/pet/PetApp.tsx', import.meta.url), 'utf8');
const petProtocolTs = readFileSync(new URL('../../desktop/web/src/pet/protocol.ts', import.meta.url), 'utf8');
const desktopPetRs = readFileSync(new URL('../../desktop/src-tauri/src/desktop_pet.rs', import.meta.url), 'utf8');

function extractRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `Expected CSS rule for ${selector}`);
  return match[1];
}

test('desktop pet quick composer sits directly below mascot in both top and bottom panel orientations', () => {
  assert.doesNotMatch(petCss, /\.pet-dock-row\b/, 'pet.css should no longer lay out composer beside mascot in .pet-dock-row');
  assert.doesNotMatch(petAppTsx, /className="pet-dock-row"/, 'PetApp.tsx should place .pet-composer-area directly under .pet-dock inside .pet-envelope');

  const bubbleDefault = extractRule(petCss, '.pet-bubble-wrap');
  const dockDefault = extractRule(petCss, '.pet-dock');
  const composerDefault = extractRule(petCss, '.pet-composer-area');
  assert.match(bubbleDefault, /order\s*:\s*1\s*;/);
  assert.match(dockDefault, /order\s*:\s*2\s*;/);
  assert.match(composerDefault, /order\s*:\s*3\s*;/);
  assert.match(composerDefault, /margin-top\s*:\s*8px\s*;/);

  // Near top screen edge (panel-side="bottom"), keep composer directly below dock (not flipped above it)
  assert.doesNotMatch(
    petCss,
    /\.pet-stage\[data-panel-side="bottom"\]\s+\.pet-envelope\s*\{[^}]*column-reverse/,
    'bottom panel orientation must not column-reverse composer above mascot',
  );
  const dockBottom = extractRule(petCss, '.pet-stage[data-panel-side="bottom"] .pet-dock');
  const composerBottom = extractRule(petCss, '.pet-stage[data-panel-side="bottom"] .pet-composer-area');
  const bubbleBottom = extractRule(petCss, '.pet-stage[data-panel-side="bottom"] .pet-bubble-wrap');
  assert.match(dockBottom, /order\s*:\s*1\s*;/);
  assert.match(composerBottom, /order\s*:\s*2\s*;/);
  assert.match(bubbleBottom, /order\s*:\s*3\s*;/);

  // Center dock alignment keeps composer, mascot, and bubble centered along one vertical axis
  const centerStage = extractRule(petCss, '.pet-stage[data-dock-side="center"]');
  const centerEnvelope = extractRule(petCss, '.pet-stage[data-dock-side="center"] .pet-envelope');
  const centerComposer = extractRule(petCss, '.pet-stage[data-dock-side="center"] .pet-composer-area');
  assert.match(centerStage, /align-items\s*:\s*center\s*;/);
  assert.match(centerEnvelope, /align-items\s*:\s*center\s*;/);
  assert.match(centerComposer, /align-items\s*:\s*center\s*;/);

  assert.match(petProtocolTs, /export type PetDockSide\s*=\s*'left'\s*\|\s*'right'\s*\|\s*'center'\s*;/);
  assert.match(petProtocolTs, /composerHeight\?\s*:\s*number\s*;/);
  assert.match(petAppTsx, /composerHeight/);
});

test('desktop pet quick composer dismisses automatically on focus loss without breaking avatar click or internal controls', () => {
  assert.match(petProtocolTs, /focused\?\s*:\s*boolean\s*;/);
  assert.match(desktopPetRs, /WindowEvent::Focused\(focused\)/);
  assert.match(petAppTsx, /window\.addEventListener\('blur',\s*onWindowBlur\)/);
  assert.match(petAppTsx, /typeof payload\.focused === 'boolean'/);
  assert.match(petAppTsx, /className="pet-composer-area"[\s\S]*?onBlur=/);
  assert.match(petAppTsx, /dockRef\.current\?\.contains\(next\)/);
  assert.match(petAppTsx, /avatarPressValidRef\.current \|\| pointerRef\.current/);
});
