// Builtin Bot management skill: durable section that exposes only the
// name/description catalog of builtin-skills/bot-management/SKILL.md. The model
// loads SKILL.md and references/*.md through the read tool at the absolute
// <location> rendered into the catalog; the manual body is never inlined.
//
// The path is sibling-relative to this module so the same lookup resolves in
// the repo tree, the desktop staged host-runtime/host-core tree, and the
// Android bot-host payload (where this module is bundled into
// host-runtime.mjs and the skill files ship as payload siblings recorded in
// payload.json). See host-core/build-android.js and host-core/build-desktop.js.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { section } from '@earendil-works/pi-durable';
import { formatSkillsForPrompt, loadSkillFromFile } from './third-party/pi-skills.js';

const SKILL_FILE = join(dirname(fileURLToPath(import.meta.url)), 'builtin-skills', 'bot-management', 'SKILL.md');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'SKILL_INVALID' });
}

// Installed by the Host runtime as a normal registry section. The catalog
// string is resolved once at registration so renders stay constant (prompt
// cache friendly). A missing or invalid SKILL.md is a packaging failure and
// throws here instead of silently dropping the built-in skill.
export function createBotManagementSkillSection() {
  const { skill, diagnostics } = loadSkillFromFile(SKILL_FILE);
  if (!skill) {
    const detail = (diagnostics ?? []).map((d) => d.message).join('; ');
    throw invalid(`builtin bot-management SKILL.md is missing or invalid at ${SKILL_FILE}${detail ? `: ${detail}` : ''}`);
  }
  const catalog = formatSkillsForPrompt([skill]);
  return section('bot-management-skill', () => catalog, { tag: false });
}
