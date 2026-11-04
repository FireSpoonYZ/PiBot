import { Type } from "@earendil-works/pi-ai";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { defineTool } from "@earendil-works/pi-durable";
import { withCancel } from "@earendil-works/chord/context";
import path from "node:path";
import picomatch from "picomatch";
import { resolveSearchBinary } from "./search-bin.js";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;
const TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;

const findSchema = Type.Object({
    pattern: Type.String({ description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" }),
    path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum number of results (default: ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` })),
});

function noMatches() {
    return { output: [{ type: "text", text: "No files found matching pattern" }] };
}

// On Windows "/" and "\" are interchangeable separators; on Linux "\" is a literal filename character.
function normalizeSeparators(value) {
    return path.sep === "\\" ? value.replaceAll("\\", "/") : value;
}

function relativize(resultPath, searchPath) {
    // fd prints absolute paths for an absolute search root; keep relative output as-is anyway.
    if (!path.isAbsolute(resultPath))
        return resultPath;
    return normalizeSeparators(path.relative(searchPath, resultPath));
}

export function createFindTool({ dataRoot, toolPaths } = {}) {
    return defineTool({
        name: "find",
        description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is limited to ${DEFAULT_LIMIT} results or ${MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first).`,
        parameters: findSchema,
        replay: "safe",
        outputLimits: { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_LIMIT, retain: "head" },
        async execute(args, api, context) {
            const env = api.env;
            if (env === undefined)
                throw new Error("No execution environment is configured");
            const pattern = args.pattern;
            const searchArg = args.path === undefined ? "." : args.path;
            const limit = args.limit ?? DEFAULT_LIMIT;
            const fdPath = resolveSearchBinary("fd", { dataRoot, toolPaths });
            const searchPath = getOrThrow(await env.absolutePath(searchArg, context));

            // fd smart-case: a pattern with an uppercase letter matches case-sensitively, otherwise not.
            const caseSensitive = pattern.toLowerCase() !== pattern;
            const normalizedPattern = normalizeSeparators(pattern);
            // No slash: match by basename, like fd without --full-path.
            const byBasename = !normalizedPattern.includes("/");
            // With slashes, a leading "**/" makes the pattern match root-relative candidates anywhere.
            const isAbsolutePattern = normalizedPattern.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPattern);
            let effectivePattern = normalizedPattern;
            if (normalizedPattern === "")
                effectivePattern = "**";
            else if (!byBasename && !isAbsolutePattern && !normalizedPattern.startsWith("**/") && normalizedPattern !== "**")
                effectivePattern = `**/${normalizedPattern}`;
            let isMatch;
            try {
                isMatch = picomatch(effectivePattern, {
                    dot: true,
                    nonegate: true,
                    strictBrackets: true,
                    basename: byBasename,
                    nocase: !caseSensitive,
                });
            } catch (error) {
                return { output: [], isError: true, diagnostics: [{ severity: "error", code: "invalid_pattern", message: String(error?.message ?? error) }] };
            }

            // fd honors .gitignore outside git repositories only with --no-require-git; inside one, its default
            // git-aware behavior stops parent ignore rules at nested repository boundaries.
            const fdArgs = ["--type=f", "--color=never", "--hidden", "--exclude=.git"];
            let insideGitRepo = false;
            for (let current = searchPath;;) {
                if (getOrThrow(await env.exists(getOrThrow(await env.joinPath([current, ".git"], context)), context))) {
                    insideGitRepo = true;
                    break;
                }
                const parent = path.dirname(current);
                if (parent === current)
                    break;
                current = parent;
            }
            if (!insideGitRepo)
                fdArgs.push("--no-require-git");
            // Enumerate every file with an empty regex; picomatch filters the NUL records below.
            fdArgs.push("--print0", "--", "", searchPath);

            const encoder = new TextEncoder();
            const fdMax = limit + 1;
            const results = [];
            let pending = "";
            let recordOverflow = false;
            let limitHit = false;
            let stderr = "";
            let stderrOverflow = false;
            // Hitting the limit cancels only this exec; parent cancels, timeouts, and other errors still propagate.
            const child = withCancel(context);
            const result = await env.exec([fdPath, ...fdArgs], {
                cwd: env.cwd,
                inheritEnv: true,
                timeout: TIMEOUT_SECONDS,
                onOutput(text, _ctx, info) {
                    if (info.stream === "stderr") {
                        if (stderrOverflow)
                            return;
                        const room = MAX_STDERR_BYTES - stderr.length;
                        if (text.length > room) {
                            stderr += text.slice(0, room);
                            stderrOverflow = true;
                        } else {
                            stderr += text;
                        }
                        return;
                    }
                    if (recordOverflow)
                        return;
                    pending += text;
                    let nul;
                    while ((nul = pending.indexOf("\0")) !== -1) {
                        const record = normalizeSeparators(pending.slice(0, nul));
                        pending = pending.slice(nul + 1);
                        if (encoder.encode(record).length > MAX_RECORD_BYTES) {
                            recordOverflow = true;
                            child.cancel();
                            return;
                        }
                        if (limitHit)
                            continue;
                        if (isMatch(record)) {
                            results.push(record);
                            if (results.length >= fdMax) {
                                limitHit = true;
                                child.cancel();
                            }
                        }
                    }
                    if (encoder.encode(pending).length > MAX_RECORD_BYTES) {
                        recordOverflow = true;
                        child.cancel();
                        pending = "";
                    }
                },
            }, child.context);

            if (pending !== "" && !recordOverflow && !limitHit) {
                if (encoder.encode(pending).length > MAX_RECORD_BYTES) {
                    recordOverflow = true;
                    child.cancel();
                } else {
                    const record = normalizeSeparators(pending);
                    if (isMatch(record)) {
                        results.push(record);
                        if (results.length >= fdMax)
                            limitHit = true;
                    }
                }
            }

            if (!result.ok) {
                if (result.error.code === "aborted") {
                    if (context.abortSignal?.aborted || (!limitHit && !recordOverflow))
                        throw result.error;
                } else if (result.error.code === "timeout") {
                    throw new Error(`find timed out after ${TIMEOUT_SECONDS} seconds`);
                } else {
                    throw result.error;
                }
            } else if (result.value.exitCode !== 0 && !limitHit && !recordOverflow) {
                const message = stderr.trim() || `fd exited with code ${result.value.exitCode}`;
                return { output: [], isError: true, diagnostics: [{ severity: "error", code: "exit_code", message }] };
            }

            if (recordOverflow) {
                return {
                    output: [],
                    isError: true,
                    diagnostics: [{ severity: "error", code: "record_overflow", message: `A file path in the search output exceeded ${MAX_RECORD_BYTES / 1024}KiB without a NUL terminator; results are incomplete` }],
                };
            }

            const relativized = results.map((line) => relativize(line, searchPath));
            relativized.sort();
            const limitReached = relativized.length >= fdMax;
            if (limitReached)
                relativized.length = limit;

            const outputLines = [];
            let outputBytes = 0;
            let bytesTruncated = false;
            for (const line of relativized) {
                const lineBytes = new TextEncoder().encode(line).length + (outputLines.length === 0 ? 0 : 1);
                if (outputBytes + lineBytes > MAX_OUTPUT_BYTES) {
                    bytesTruncated = true;
                    break;
                }
                outputLines.push(line);
                outputBytes += lineBytes;
            }
            if (outputLines.length === 0) {
                if (bytesTruncated) {
                    return {
                        output: [{ type: "text", text: `[Output truncated at ${MAX_OUTPUT_BYTES / 1024}KB]` }],
                        details: { bytesTruncated: true },
                    };
                }
                return noMatches();
            }

            const notices = [];
            if (limitReached)
                notices.push(`${limit} results limit reached. Use limit=${Math.min(limit * 2, MAX_LIMIT)} for more, or refine pattern`);
            if (bytesTruncated)
                notices.push(`Output truncated at ${MAX_OUTPUT_BYTES / 1024}KB`);
            let text = outputLines.join("\n");
            if (notices.length > 0)
                text += `\n\n[${notices.join(". ")}]`;
            const details = {};
            if (limitReached)
                details.resultLimitReached = limit;
            if (bytesTruncated)
                details.bytesTruncated = true;
            return { output: [{ type: "text", text }], details };
        },
    });
}
