// Adapted from @earendil-works/pi-coding-agent 1.3.0, MIT.
// dist/core/skills.js and dist/utils/frontmatter.js; managed paths and diagnostics adapted.
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parse } from 'yaml';

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function validateName(name) {
  const errors = [];
  if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)');
  if (name.startsWith('-') || name.endsWith('-')) errors.push('name must not start or end with a hyphen');
  if (name.includes('--')) errors.push('name must not contain consecutive hyphens');
  return errors;
}

function validateDescription(description) {
  const errors = [];
  if (typeof description !== 'string' || description.trim() === '') errors.push('description is required');
  else if (description.length > MAX_DESCRIPTION_LENGTH) errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  return errors;
}

function parseFrontmatter(content) {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized };
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) return { frontmatter: {}, body: normalized };
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  return { frontmatter: yamlString ? (parse(yamlString) ?? {}) : {}, body };
}

export function loadSkillFromFile(filePath) {
  const diagnostics = [];
  let frontmatter;
  try {
    ({ frontmatter } = parseFrontmatter(readFileSync(filePath, 'utf8')));
  } catch (error) {
    return { skill: null, diagnostics: [{ type: 'warning', message: error.message, path: filePath }] };
  }
  const description = frontmatter.description;
  const hasDescription = typeof description === 'string' && description.trim() !== '';
  const skillDir = dirname(filePath);
  const name = (typeof frontmatter.name === 'string' && frontmatter.name) || basename(skillDir);
  for (const message of [...validateDescription(description), ...validateName(name)]) {
    diagnostics.push({ type: 'warning', message, path: filePath });
  }
  if (!hasDescription) return { skill: null, diagnostics };
  return {
    skill: {
      name, description, filePath, baseDir: skillDir,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    },
    diagnostics,
  };
}

export function formatSkillsForPrompt(skills, fileReadTool = 'read') {
  const visibleSkills = skills.filter(s => !s.disableModelInvocation);
  if (visibleSkills.length === 0) return '';
  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    fileReadTool === 'read'
      ? "Use the read tool to load a skill's file when the task matches its description."
      : fileReadTool === 'bash'
        ? "Use bash to load a skill's file when the task matches its description."
        : "Load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];
  for (const skill of visibleSkills) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
