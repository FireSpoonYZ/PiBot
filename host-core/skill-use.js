import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { getOrThrow } from '@earendil-works/pi-durable/env';

// Match the pinned read tool's path normalization and filename fallback order.
async function readPath(env, path, context) {
  const normalized = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  const resolved = getOrThrow(await env.absolutePath(normalized, context));
  for (const candidate of new Set([resolved, resolved.replace(/ (AM|PM)\./gi, '\u202F$1.'),
    resolved.normalize('NFD'), resolved.replace(/'/g, '\u2019'), resolved.normalize('NFD').replace(/'/g, '\u2019')])) {
    if (getOrThrow(await env.exists(candidate, context))) return realpath(candidate);
  }
  return null;
}

export async function reportSkillRead({ call, result, api, context, skills, installationId, version, packageRoot, botId, host }) {
  if (call.name !== 'read' || result.isError || typeof call.arguments?.path !== 'string') return;
  const output = result.structuredOutput;
  if (!(typeof output === 'string' ? output.trim().length : output?.type === 'image')) return;
  const file = await readPath(await host.getSkillReadEnv(api.conversationId, context), call.arguments.path, context);
  if (!file) return;
  const skill = skills.toSorted((a, b) => b.baseDir.length - a.baseDir.length).find(item => {
    const rel = relative(item.baseDir, file);
    return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
      && !rel.split(sep).some(part => part.startsWith('.') || part === 'node_modules');
  });
  if (!skill) return;
  const memberPath = relative(skill.baseDir, file).split(sep).join('/');
  if (memberPath !== 'SKILL.md' && !/^(references|scripts|templates|assets)\//.test(memberPath)) return;
  const requestId = createHash('sha256').update(JSON.stringify([
    host.host.deviceId, botId, installationId, version, api.conversationId, api.taskId, call.id,
  ])).digest('hex');
  const signal = context.abortSignal
    ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000);
  await host.reportSkillUse(botId, {
    requestId, installationId, version, skillName: skill.name,
    skillPath: relative(await realpath(packageRoot), skill.baseDir).split(sep).join('/') || '.',
    path: memberPath,
  }, signal);
}
