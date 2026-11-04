import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 10000;
const MAX_OUTPUT_BYTES = 50 * 1024; // 50KB
const READ_PAGE_SIZE = 1024;

const lsSchema = Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
    limit: Type.Optional(Type.Integer({ description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`, minimum: 1, maximum: MAX_LIMIT })),
});

const utf8Encoder = new TextEncoder();
function utf8ByteLength(text) {
    return utf8Encoder.encode(text).length;
}

/**
 * Lists a directory's entries via the environment's `openDirReader`: alphabetically sorted, directories suffixed with
 * `/`, dotfiles included, symlinks not followed, never recursive. Output is bounded by `limit` entries and 50KB;
 * truncation is reported as info diagnostics. Errors from the environment (`not_found`, `not_directory`,
 * `permission_denied`, ...) propagate unchanged.
 */
export function createLsTool() {
    return defineTool({
        name: "ls",
        description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${MAX_OUTPUT_BYTES / 1024}KB (whichever is hit first).`,
        parameters: lsSchema,
        replay: "safe",
        outputLimits: { maxBytes: MAX_OUTPUT_BYTES, maxLines: MAX_LIMIT },
        async execute(args, api, context) {
            const env = api.env;
            if (env === undefined)
                throw new Error("No execution environment is configured");
            const reader = getOrThrow(await env.openDirReader(args.path ?? ".", context));
            try {
                const entries = [];
                for (;;) {
                    const page = getOrThrow(await reader.next(READ_PAGE_SIZE, context));
                    entries.push(...page.entries);
                    if (page.done)
                        break;
                }
                // Case-insensitive alphabetical order, byte order as tie-break.
                entries.sort((a, b) => {
                    const left = a.name.toLowerCase();
                    const right = b.name.toLowerCase();
                    if (left < right)
                        return -1;
                    if (left > right)
                        return 1;
                    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
                });
                const limit = args.limit ?? DEFAULT_LIMIT;
                const lines = [];
                let bytes = 0;
                for (const entry of entries.slice(0, limit)) {
                    const line = entry.kind === "directory" ? `${entry.name}/` : entry.name;
                    const lineBytes = utf8ByteLength(line);
                    if (bytes + lineBytes + (lines.length === 0 ? 0 : 1) > MAX_OUTPUT_BYTES)
                        break;
                    if (lines.length > 0)
                        bytes += 1; // newline separator
                    lines.push(line);
                    bytes += lineBytes;
                }
                const diagnostics = [];
                if (entries.length > limit) {
                    diagnostics.push({
                        severity: "info",
                        code: "truncated",
                        message: `Showing first ${limit} of ${entries.length} entries; increase limit (up to ${MAX_LIMIT}) to see more.`,
                    });
                }
                if (lines.length < Math.min(entries.length, limit)) {
                    diagnostics.push({
                        severity: "info",
                        code: "truncated",
                        message: `Output truncated at ${MAX_OUTPUT_BYTES / 1024}KB; showing ${lines.length} of ${Math.min(entries.length, limit)} entries.`,
                    });
                }
                return {
                    output: lines.length === 0 ? [] : [{ type: "text", text: lines.join("\n") }],
                    ...(diagnostics.length === 0 ? {} : { diagnostics }),
                };
            }
            finally {
                await reader.close(context);
            }
        },
    });
}
