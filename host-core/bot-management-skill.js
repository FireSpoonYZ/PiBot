// Builtin skills: durable section that exposes only the
// name/description catalog of bundled SKILL.md files. The model
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

const SKILL_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'builtin-skills');
const SKILL_NAMES = ['bot-management', 'google-account-connection'];

function invalid(message) {
  return Object.assign(new Error(message), { code: 'SKILL_INVALID' });
}

// Installed by the Host runtime as a normal registry section. The catalog
// string is resolved once at registration so renders stay constant (prompt
// cache friendly). A missing or invalid SKILL.md is a packaging failure and
// throws here instead of silently dropping the built-in skill.
export function createBotManagementSkillSection() {
  const skills = SKILL_NAMES.map((name) => {
    const file = join(SKILL_ROOT, name, 'SKILL.md');
    const { skill, diagnostics } = loadSkillFromFile(file);
    if (!skill) {
      const detail = (diagnostics ?? []).map((d) => d.message).join('; ');
      throw invalid(`builtin ${name} SKILL.md is missing or invalid at ${file}${detail ? `: ${detail}` : ''}`);
    }
    return skill;
  });
  const catalog = formatSkillsForPrompt(skills);
  return section('bot-management-skill', () => catalog, { tag: false });
}
