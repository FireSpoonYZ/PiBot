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

const GENERATION_REQUEST_ORIGINAL = `            const message = await streamResponse(runtime, model, messages, options, attempt, context);
            const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, messages: view.messages };
            await classify(runtime, request, message, context);`;

const GENERATION_REQUEST_PATCHED = `            let { message, emittedOutput } = await streamResponse(runtime, model, messages, options, attempt, context);
            if (!runtime.signal.aborted &&
                !context.abortSignal?.aborted &&
                compacted === undefined &&
                !emittedOutput &&
                message.stopReason === "error" &&
                isContextOverflow(message)) {
                let recovered;
                await runtime.hooks.each("recoverContextOverflow", async (hook) => {
                    if (recovered !== undefined || runtime.signal.aborted || context.abortSignal?.aborted)
                        return;
                    const decision = await hook({ model, messages, error: message, attempt, cutoff }, runtime, context);
                    if (Array.isArray(decision?.messages))
                        recovered = decision.messages;
                });
                if (recovered !== undefined && !runtime.signal.aborted && !context.abortSignal?.aborted) {
                    messages = recovered;
                    ({ message } = await streamResponse(runtime, model, messages, options, attempt, context));
                }
            }
            const request = { attempt, compacted, model: ref, thinkingLevel, cutoff, messages: view.messages };
            await classify(runtime, request, message, context);`;

const GENERATION_STREAM_ORIGINAL = `    try {
        const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
        for await (const event of events) {
            // A partial without content, such as pi-ai's opening \`start\` event, shows nothing; a deferred response
            // never gets past it, so it never leaves a partial.
            if (event.type === "done" || event.type === "error" || event.partial.content.length === 0)
                continue;
            changes.observe(event);
            pending = event.partial;
            if (timer === undefined && inFlight === undefined)
                timer = runtime.setTimer(flush, interval);
        }
        return await events.result();
    }`;

const GENERATION_STREAM_PATCHED = `    let emittedOutput = false;
    const hasVisibleOutput = (content) => {
        if (!Array.isArray(content))
            return false;
        for (const block of content) {
            if (!block || typeof block !== "object")
                continue;
            if (block.type === "toolCall")
                return true;
            if (block.type === "text" && typeof block.text === "string" && block.text.length > 0)
                return true;
            if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0)
                return true;
        }
        return false;
    };
    try {
        const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
        for await (const event of events) {
            if (event.type === "done" || event.type === "error")
                continue;
            if (event.type === "toolcall_start" ||
                event.type === "toolcall_delta" ||
                event.type === "toolcall_end" ||
                (event.type === "text_delta" && typeof event.delta === "string" && event.delta.length > 0) ||
                (event.type === "thinking_delta" && typeof event.delta === "string" && event.delta.length > 0) ||
                hasVisibleOutput(event.partial?.content)) {
                emittedOutput = true;
            }
            // A partial without content, such as pi-ai's opening \`start\` event, shows nothing; a deferred response
            // never gets past it, so it never leaves a partial.
            if (event.partial.content.length === 0)
                continue;
            changes.observe(event);
            pending = event.partial;
            if (timer === undefined && inFlight === undefined)
                timer = runtime.setTimer(flush, interval);
        }
        const message = await events.result();
        if (hasVisibleOutput(message?.content))
            emittedOutput = true;
        return { message, emittedOutput };
    }`;

const COMPACTION_OPTIONS_ORIGINAL = `            const options = {
                ...forwarded,
                cacheRetention: "none",
                maxTokens,
                signal: runtime.signal,
                telemetry: context.telemetry,
                sessionId: await ensureProviderSessionId(runtime, context),
                ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
            };
            const message = await runtime.models.completeSimple(model, { messages }, options);`;

const COMPACTION_OPTIONS_PATCHED = `            const providerSessionId = await ensureProviderSessionId(runtime, context);
            const options = {
                ...forwarded,
                cacheRetention: "none",
                maxTokens,
                signal: runtime.signal,
                telemetry: context.telemetry,
                // Summarization has its own instructions and history. Keep it out of
                // Antigravity's chat session, with a stable identity for task retries.
                sessionId: ref.provider === "antigravity-acp"
                    ? JSON.stringify(["antigravity-compaction", providerSessionId, runtime.taskId])
                    : providerSessionId,
                ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
            };
            const message = await runtime.models.completeSimple(model, { messages }, options);`;

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

const TYPES_OVERFLOW_ORIGINAL = `    beforeProviderRequest(request: {
        readonly model: Model<Api>;
        readonly payload: unknown;
    }, api: HookApi, context: Context): HookResult<{
        readonly payload: unknown;
    }>;
    /** Every terminal provider message, before classification. */
    afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;`;

const TYPES_OVERFLOW_PATCHED = `    beforeProviderRequest(request: {
        readonly model: Model<Api>;
        readonly payload: unknown;
    }, api: HookApi, context: Context): HookResult<{
        readonly payload: unknown;
    }>;
    /**
     * After a provider request fails with a context overflow before emitting visible output; at most once per request
     * attempt (and skipped after native compaction), returning replacement messages retries in place at the same cutoff.
     */
    recoverContextOverflow(request: {
        readonly model: Model<Api>;
        readonly messages: readonly Message[];
        readonly error: AssistantMessage;
        readonly attempt: number;
        readonly cutoff: EntryId;
    }, api: HookApi, context: Context): HookResult<{
        readonly messages: readonly Message[];
    }>;
    /** Every terminal provider message, before classification. */
    afterResponse(message: AssistantMessage, api: HookApi, context: Context): void | Promise<void>;`;

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

function applyExactPatches(filePath, patches) {
  let source = readFileSync(filePath, 'utf8');
  let changed = false;
  for (const { original, patched } of patches) {
    const origCount = countOccurrences(source, original);
    const patchedCount = countOccurrences(source, patched);
    if (patchedCount === 1 && origCount === 0) continue;
    if (origCount === 1 && patchedCount === 0) {
      source = source.replace(original, patched);
      changed = true;
      continue;
    }
    throw new Error(
      `${filePath} does not match expected @earendil-works/pi-durable@${PI_DURABLE_VERSION} ` +
        `source or patched state (original=${origCount}, patched=${patchedCount})`
    );
  }
  if (changed) {
    writeFileSync(filePath, source, 'utf8');
  }
  return changed;
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
  const generationChanged = applyExactPatches(
    path.join(pkgDir, 'dist', 'harness', 'generation.js'),
    [
      { original: GENERATION_ORIGINAL, patched: GENERATION_PATCHED },
      { original: GENERATION_REQUEST_ORIGINAL, patched: GENERATION_REQUEST_PATCHED },
      { original: GENERATION_STREAM_ORIGINAL, patched: GENERATION_STREAM_PATCHED },
    ]
  );
  const typesPath = path.join(pkgDir, 'dist', 'harness', 'types.d.ts');
  const typesChanged = existsSync(typesPath)
    ? applyExactPatches(typesPath, [
        { original: TYPES_ORIGINAL, patched: TYPES_PATCHED },
        { original: TYPES_OVERFLOW_ORIGINAL, patched: TYPES_OVERFLOW_PATCHED },
      ])
    : false;
  const storageChanged = applyExactPatches(
    path.join(pkgDir, 'dist', 'storage', 'sqlite', 'storage.js'),
    [{ original: STORAGE_ORIGINAL, patched: STORAGE_PATCHED }]
  );
  const compactionChanged = applyExactPatches(
    path.join(pkgDir, 'dist', 'harness', 'compaction.js'),
    [{ original: COMPACTION_OPTIONS_ORIGINAL, patched: COMPACTION_OPTIONS_PATCHED }]
  );
  return { generationChanged, typesChanged, storageChanged, compactionChanged };
}

if (import.meta.main) {
  patchPiDurable();
}
