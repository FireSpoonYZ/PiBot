import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const petCss = readFileSync(new URL('../../desktop/web/src/pet/pet.css', import.meta.url), 'utf8');
const petAppTsx = readFileSync(new URL('../../desktop/web/src/pet/PetApp.tsx', import.meta.url), 'utf8');
const petProtocolTs = readFileSync(new URL('../../desktop/web/src/pet/protocol.ts', import.meta.url), 'utf8');
const desktopPetRs = readFileSync(new URL('../../desktop/src-tauri/src/desktop_pet.rs', import.meta.url), 'utf8');

function extractRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[},\\n])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gm');
  const blocks = [...css.matchAll(pattern)].map((match) => match[1]);
  assert.ok(blocks.length > 0, `Expected CSS rule for ${selector}`);
  return blocks.join('\n');
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

test('desktop pet CSS covers all six dockSide x panelSide orientations and speech tail alignment', () => {
  // Default orientation: dockSide="right" + panelSide="top"
  const stageDefault = extractRule(petCss, '.pet-stage');
  const envelopeDefault = extractRule(petCss, '.pet-envelope');
  const composerDefault = extractRule(petCss, '.pet-composer-area');
  const tailDefault = extractRule(petCss, '.pet-bubble-tail');
  assert.match(stageDefault, /justify-content\s*:\s*flex-end\s*;/);
  assert.match(stageDefault, /align-items\s*:\s*flex-end\s*;/);
  assert.match(envelopeDefault, /align-items\s*:\s*flex-end\s*;/);
  assert.match(composerDefault, /align-items\s*:\s*flex-end\s*;/);
  assert.match(tailDefault, /bottom\s*:\s*-7px\s*;/);
  assert.match(tailDefault, /right\s*:\s*41px\s*;/);

  // Left dock orientation
  const stageLeft = extractRule(petCss, '.pet-stage[data-dock-side="left"]');
  const envelopeLeft = extractRule(petCss, '.pet-stage[data-dock-side="left"] .pet-envelope');
  const composerLeft = extractRule(petCss, '.pet-stage[data-dock-side="left"] .pet-composer-area');
  const tailLeft = extractRule(petCss, '.pet-stage[data-dock-side="left"] .pet-bubble-tail');
  assert.match(stageLeft, /align-items\s*:\s*flex-start\s*;/);
  assert.match(envelopeLeft, /align-items\s*:\s*flex-start\s*;/);
  assert.match(composerLeft, /align-items\s*:\s*flex-start\s*;/);
  assert.match(tailLeft, /left\s*:\s*41px\s*;/);

  // Center dock orientation keeps avatar centered even with hover rail column
  const tailCenter = extractRule(petCss, '.pet-stage[data-dock-side="center"] .pet-bubble-tail');
  const dockCenter = extractRule(petCss, '.pet-stage[data-dock-side="center"] .pet-dock:not(.is-composer-open)');
  assert.match(tailCenter, /left\s*:\s*50%\s*;/);
  assert.match(dockCenter, /grid-template-columns\s*:\s*37px 96px 37px\s*;/);
  assert.match(dockCenter, /width\s*:\s*170px\s*;/);

  // Bottom panel orientation flips vertical flow and hides tail when composer sits between dock and bubble
  const stageBottom = extractRule(petCss, '.pet-stage[data-panel-side="bottom"]');
  const tailBottom = extractRule(petCss, '.pet-stage[data-panel-side="bottom"] .pet-bubble-tail');
  const tailBottomOpen = extractRule(
    petCss,
    '.pet-stage[data-panel-side="bottom"][data-composer-open="true"] .pet-bubble-tail',
  );
  assert.match(stageBottom, /justify-content\s*:\s*flex-start\s*;/);
  assert.match(tailBottom, /top\s*:\s*-7px\s*;/);
  assert.match(tailBottomOpen, /display\s*:\s*none\s*;/);

  // Stage DOM attributes remain bound in PetApp.tsx
  assert.match(petAppTsx, /data-dock-side=\{layout\.dockSide\}/);
  assert.match(petAppTsx, /data-panel-side=\{layout\.panelSide\}/);
  assert.match(petAppTsx, /data-composer-open=/);
  assert.match(petAppTsx, /data-composited=/);
});

test('desktop pet CSS dimensions stay mathematically aligned with native desktop_pet.rs anchors and interactions', () => {
  const stageRule = extractRule(petCss, '.pet-stage');
  const dockRule = extractRule(petCss, '.pet-dock');
  const dockOpenRule = extractRule(petCss, '.pet-dock.is-composer-open');
  const avatarRule = extractRule(petCss, '.pet-avatar');
  const composerAreaRule = extractRule(petCss, '.pet-composer-area');
  const composerPillRule = extractRule(petCss, '.pet-composer-pill');
  const recallChipRule = extractRule(petCss, '.pet-recall-chip');

  assert.match(stageRule, /padding\s*:\s*12px\s*;/);
  assert.match(dockRule, /height\s*:\s*104px\s*;/);
  assert.match(dockOpenRule, /width\s*:\s*96px\s*;/);
  assert.match(avatarRule, /width\s*:\s*96px\s*;/);
  assert.match(avatarRule, /height\s*:\s*96px\s*;/);
  assert.match(composerAreaRule, /gap\s*:\s*5px\s*;/);
  assert.match(composerAreaRule, /margin-top\s*:\s*8px\s*;/);
  assert.match(composerPillRule, /width\s*:\s*296px\s*;/);
  assert.match(recallChipRule, /height\s*:\s*22px\s*;/);

  // Native geometry constants match CSS: 12 + 104 + 12 = 128, 96 / 2 = 48, 12 + 104 / 2 = 64
  assert.match(desktopPetRs, /const COLLAPSED_SIZE:\s*\(f64,\s*f64\)\s*=\s*\(164\.0,\s*128\.0\)\s*;/);
  assert.match(desktopPetRs, /const STAGE_PADDING:\s*f64\s*=\s*12\.0\s*;/);
  assert.match(desktopPetRs, /const AVATAR_HALF_SIZE:\s*f64\s*=\s*48\.0\s*;/);
  assert.match(desktopPetRs, /const DOCK_CENTER_OFFSET_Y:\s*f64\s*=\s*64\.0\s*;/);

  // Escape dismissal & recall chip remain wired
  assert.match(petAppTsx, /event\.key !== 'Escape'/);
  assert.match(petAppTsx, /className="pet-recall-chip"/);
});
