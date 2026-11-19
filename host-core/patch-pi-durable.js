#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PI_DURABLE_VERSION = '1.5.2';

const GENERATION_ORIGINAL = `            const threshold = compacted === undefined
                ? thresholdCompaction(view, entries, resolved.contextWindow, compactionPolicy(settings, model, agent.compaction))
                : undefined;
            if (threshold === "blocking") {`;

const GENERATION_PATCHED = `            let threshold = compacted === undefined
                ? thresholdCompaction(view, entries, resolved.contextWindow, compactionPolicy(settings, model, agent.compaction))
                : undefined;
            if (threshold !== undefined) {
                let declined = false;
                await runtime.hooks.each("beforeThresholdCompaction", async (hook) => {
                    if (declined)
                        return;
                    const decision = await hook(agent, runtime, context);
                    if (decision?.decline === true)
                        declined = true;
                });
                if (declined)
                    threshold = undefined;
            }
            if (threshold === "blocking") {`;

const TYPES_ORIGINAL = `export interface GenerationHooks {
    /** Before every request attempt, including recovery; the result is used for that request only. */
    beforeRequest(request: {`;

const TYPES_PATCHED = `export interface GenerationHooks {
    /** Before a threshold compaction is enqueued during preparation; \`{ decline: true }\` suppresses only threshold compaction. */
    beforeThresholdCompaction(agent: Agent, api: HookApi, context: Context): HookResult<{
        readonly decline: true;
    }>;
    /** Before every request attempt, including recovery; the result is used for that request only. */
    beforeRequest(request: {`;

const STORAGE_ORIGINAL = `        let value = parseJson(base.content);
        const tail = await executor.all(\`SELECT seq, kind, version, content FROM \${this.schema.tables.documentRevisions}
\t\t\t\tWHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq\`, id, base.seq, upper);
        for (const revision of tail) {
            if (revision.kind !== "delta" || revision.version !== base.version) {
                throw new Error(\`Document \${id} crosses a stored version boundary without a base\`);
            }
            value = apply(value, parseJson(revision.content));
        }
        return { record, version: base.version, value, deltasSinceBase: tail.length };`;

const STORAGE_PATCHED = `        let value = parseJson(base.content);
        let after = base.seq;
        let deltasSinceBase = 0;
        while (after < upper) {
            const revision = await executor.get(\`SELECT seq, kind, version, content FROM \${this.schema.tables.documentRevisions}
\t\t\t\tWHERE document_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 1\`, id, after, upper);
            if (revision === undefined)
                break;
            if (revision.kind !== "delta" || revision.version !== base.version) {
                throw new Error(\`Document \${id} crosses a stored version boundary without a base\`);
            }
            value = apply(value, parseJson(revision.content));
            after = revision.seq;
            deltasSinceBase++;
        }
        return { record, version: base.version, value, deltasSinceBase };`;

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function applyExactPatch(filePath, original, patched) {
  const source = readFileSync(filePath, 'utf8');
  const origCount = countOccurrences(source, original);
  const patchedCount = countOccurrences(source, patched);
  if (patchedCount === 1 && origCount === 0) return false;
  if (origCount === 1 && patchedCount === 0) {
    writeFileSync(filePath, source.replace(original, patched), 'utf8');
    return true;
  }
  throw new Error(
    `${filePath} does not match expected @earendil-works/pi-durable@${PI_DURABLE_VERSION} ` +
      `source or patched state (original=${origCount}, patched=${patchedCount})`
  );
}

export function patchPiDurable(nodeModulesDir = path.join(HERE, 'node_modules')) {
  const pkgDir = path.join(nodeModulesDir, '@earendil-works', 'pi-durable');
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    throw new Error(`@earendil-works/pi-durable is not installed at ${pkgDir}`);
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (pkg.name !== '@earendil-works/pi-durable' || pkg.version !== PI_DURABLE_VERSION) {
    throw new Error(
      `Expected @earendil-works/pi-durable@${PI_DURABLE_VERSION}, found ${pkg.name}@${pkg.version}`
    );
  }
  const generationChanged = applyExactPatch(
    path.join(pkgDir, 'dist', 'harness', 'generation.js'),
    GENERATION_ORIGINAL,
    GENERATION_PATCHED
  );
  const typesPath = path.join(pkgDir, 'dist', 'harness', 'types.d.ts');
  const typesChanged = existsSync(typesPath)
    ? applyExactPatch(typesPath, TYPES_ORIGINAL, TYPES_PATCHED)
    : false;
  const storageChanged = applyExactPatch(
    path.join(pkgDir, 'dist', 'storage', 'sqlite', 'storage.js'),
    STORAGE_ORIGINAL,
    STORAGE_PATCHED
  );
  return { generationChanged, typesChanged, storageChanged };
}

if (import.meta.main) {
  patchPiDurable();
}
