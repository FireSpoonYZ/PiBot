import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { section } from '@earendil-works/pi-durable';
import { formatSkillsForPrompt, loadSkillFromFile } from '../third-party/pi-skills.js';

function fail(message) {
  return Object.assign(new Error(message), { code: 'SKILL_INVALID' });
}

function inside(root, path) {
  const real = realpathSync(path);
  const rel = relative(root, real);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw fail('Skill path is outside its package.');
  return real;
}

function readOptionalJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function discoverSkills(packageRoot) {
  const root = realpathSync(packageRoot);
  const direct = join(root, 'SKILL.md');
  let paths;
  if (existsSync(direct)) {
    paths = ['.'];
  } else {
    const manifest = readOptionalJson(join(root, 'capability.json'));
    const pkg = readOptionalJson(join(root, 'package.json'));
    paths = manifest?.skills ?? pkg?.pi?.skills ?? ['.'];
  }
  if (!Array.isArray(paths)) throw fail('Skill paths must be an array.');
  const files = new Set();
  function scan(path) {
    const dir = inside(root, path);
    const info = statSync(dir);
    if (!info.isDirectory()) throw fail('Skill path must be a directory.');
    const skillFile = join(dir, 'SKILL.md');
    if (existsSync(skillFile)) {
      files.add(inside(root, skillFile));
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        scan(join(dir, entry.name));
      }
    }
  }
  for (const path of paths) {
    if (typeof path !== 'string' || isAbsolute(path)) throw fail('Skill path must be relative to the package.');
    scan(resolve(root, path));
  }
  const skills = [];
  const names = new Set();
  for (const file of [...files].sort()) {
    const result = loadSkillFromFile(file);
    if (!result.skill) throw fail('A managed SKILL.md could not be loaded.');
    if (names.has(result.skill.name)) throw fail('Managed skill names must be unique.');
    names.add(result.skill.name);
    skills.push(result.skill);
  }
  if (!skills.length) throw fail('No managed SKILL.md was found.');
  return skills;
}

export async function createSkillDriver({ installationId, packageRoot, host }) {
  const bots = new Set();
  return {
    async forBot(context) {
      const { botId } = context;
      let active = false;
      let closed = false;
      let skills = [];
      const key = 'skill-' + createHash('sha256').update(JSON.stringify([installationId, botId])).digest('hex').slice(0, 32);
      const checkOpen = () => {
        if (closed) throw fail('Skill capability is closed.');
      };
      const check = () => {
        checkOpen();
        host.assertCapabilityAllowed(botId, installationId);
      };
      const bot = {
        durableContributions: {
          sections: [section(key, async (input, invocation) => {
            invocation.abortSignal?.throwIfAborted();
            const owner = await host.resolveConversationBot(input.conversationId);
            invocation.abortSignal?.throwIfAborted();
            if (!active || owner !== botId) return undefined;
            check();
            return formatSkillsForPrompt(skills) || undefined;
          }, { tag: false })],
        },
        requestContributions: {},
        actions: {},
        async prepare() { checkOpen(); skills = discoverSkills(packageRoot); checkOpen(); },
        async activate() { checkOpen(); active = true; },
        async quiesce() { active = false; closed = true; },
        async close() { await bot.quiesce(); bots.delete(bot); },
      };
      bots.add(bot);
      return bot;
    },
    async close() { await Promise.all([...bots].map(bot => bot.close())); },
  };
}
