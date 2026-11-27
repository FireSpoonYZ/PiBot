import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const kwinRuleFile = readFileSync(new URL('../../desktop/linux/desktop-pet.kwinrule', import.meta.url), 'utf8');
const kdeRuleRs = readFileSync(new URL('../../desktop/src-tauri/src/kde_window_rule.rs', import.meta.url), 'utf8');
const desktopPetRs = readFileSync(new URL('../../desktop/src-tauri/src/desktop_pet.rs', import.meta.url), 'utf8');
const libRs = readFileSync(new URL('../../desktop/src-tauri/src/lib.rs', import.meta.url), 'utf8');
const buildRs = readFileSync(new URL('../../desktop/src-tauri/build.rs', import.meta.url), 'utf8');
const mainCap = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/capabilities/main.json', import.meta.url), 'utf8'));
const petCap = JSON.parse(readFileSync(new URL('../../desktop/src-tauri/capabilities/pet.json', import.meta.url), 'utf8'));
const petSettingsTsx = readFileSync(new URL('../../desktop/web/src/pet/DesktopPetSettings.tsx', import.meta.url), 'utf8');

function parseKwinRuleKeys(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('[') || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    assert.ok(eq > 0, `expected key=value line in desktop-pet.kwinrule: ${line}`);
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

test('desktop-pet.kwinrule stays in sync with Rust MANAGED_RULE_ENTRIES', () => {
  const fileEntries = parseKwinRuleKeys(kwinRuleFile);
  const blockMatch = kdeRuleRs.match(/const MANAGED_RULE_ENTRIES:[\s\S]*?=\s*&\[([\s\S]*?)\];/);
  assert.ok(blockMatch, 'MANAGED_RULE_ENTRIES constant must exist in kde_window_rule.rs');

  const constMap = new Map([
    ['RULE_DESCRIPTION', 'PiBot desktop pet'],
    ['RULE_WMCLASS', 'pibot'],
    ['RULE_TITLE', 'PiBot'],
  ]);

  const rustEntries = new Map();
  for (const [, key, rawVal] of blockMatch[1].matchAll(/\("([^"]+)",\s*([^)]+)\)/g)) {
    const trimmed = rawVal.trim();
    const val = trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : constMap.get(trimmed);
    assert.ok(val !== undefined, `unexpected value expression for ${key}: ${trimmed}`);
    rustEntries.set(key, val);
  }

  assert.deepEqual([...fileEntries.entries()], [...rustEntries.entries()]);
  assert.equal(fileEntries.get('wmclass'), 'pibot');
  assert.equal(fileEntries.get('title'), 'PiBot');
  assert.equal(fileEntries.get('above'), 'true');
  assert.equal(fileEntries.get('aboverule'), '2');
  assert.equal(fileEntries.get('skiptaskbar'), 'true');
  assert.equal(fileEntries.get('skiptaskbarrule'), '2');
  assert.equal(fileEntries.get('skippager'), 'true');
  assert.equal(fileEntries.get('skippagerrule'), '2');
  assert.equal(fileEntries.get('skipswitcher'), 'true');
  assert.equal(fileEntries.get('skipswitcherrule'), '2');
});

test('KDE window rule automation and main-window-only command permissions are wired cleanly', () => {
  assert.match(buildRs, /"desktop_pet_kde_rule"/);
  assert.ok(mainCap.permissions.includes('allow-desktop-pet-kde-rule'));
  assert.ok(!petCap.permissions.includes('allow-desktop-pet-kde-rule'));

  assert.match(libRs, /pub mod kde_window_rule;/);
  assert.match(libRs, /kde_window_rule::KdeWindowRuleManager::default\(\)/);
  assert.match(libRs, /kde_window_rule::ensure_auto_configured_in_background\(app\.handle\(\)\)/);
  assert.match(libRs, /kde_window_rule::desktop_pet_kde_rule/);

  assert.match(desktopPetRs, /kde_window_rule::ensure_auto_configured\(app\)\.await/);
  assert.match(desktopPetRs, /reapply_linux_window_hints\(&window\)/);

  assert.match(kdeRuleRs, /ensure_main_webview\(&webview\)\?/);
  assert.match(petSettingsTsx, /petKdeRule\('status'\)/);
  assert.match(petSettingsTsx, /kdeRule\?\.supported/);
});
