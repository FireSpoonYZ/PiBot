import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '@earendil-works/pi-durable';
import { ExecutionError, FileError, getOrThrow } from '@earendil-works/pi-durable/env';
import { withCancel } from '@earendil-works/chord/context';
import { resolveSearchBinary } from './search-bin.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 10000;
const TIMEOUT_SECONDS = 60;
const MAX_VISIBLE_BYTES = 50 * 1024;
const MAX_VISIBLE_LINES = 10000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_LINE_CHARS = 500;
const MAX_STDERR_BYTES = 16 * 1024;
const LINE_TRUNCATION_MARKER = '…';

const grepSchema = Type.Object({
  pattern: Type.String({ description: 'Search pattern: a regular expression, or a literal string when literal is set' }),
  path: Type.Optional(Type.String({ description: 'Directory or file to search (default: the current working directory)' })),
  glob: Type.Optional(Type.String({ description: "Glob filter for files to search, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search (default: false)' })),
  literal: Type.Optional(Type.Boolean({ description: 'Treat pattern as a literal string instead of a regex (default: false)' })),
  context: Type.Optional(Type.Integer({ minimum: 0, description: 'Lines of context to show before and after each match (default: 0)' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: "Maximum matches to return (default: 100)" })),
});

function requireEnv(api) {
  if (api.env === undefined)
    throw new Error('No execution environment is configured');
  return api.env;
}

// Resolve the search target against the environment's cwd (default '.'), never the host data root.
async function resolveSearchTarget(env, pathArg, context) {
  const root = getOrThrow(await env.absolutePath(pathArg ?? '.', context));
  if (typeof root !== 'string' || root.length === 0)
    throw new Error('No search path');
  let info;
  try {
    info = getOrThrow(await env.fileInfo(root, context));
  }
  catch (error) {
    if (error instanceof FileError && error.code === 'not_found')
      throw new Error('Path not found: ' + root);
    throw error;
  }
  if (info.kind !== 'file' && info.kind !== 'directory' && info.kind !== 'symlink')
    throw new Error('Not a searchable path: ' + root);
  return { root, kind: info.kind };
}

// Directory searches show paths relative to the search root; a single-file search shows just the file name.
function displayPath(root, kind, filePath) {
  if (kind !== 'directory')
    return path.basename(filePath);
  const relative = path.relative(root, filePath);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative))
    return relative;
  return path.basename(filePath);
}

// Ascend from the search start looking for a .git entry, so rg's --no-require-git is only used
// outside git work trees (where .gitignore still applies once it is set).
async function insideGitWorkTree(env, start, context) {
  let current = start;
  while (true) {
    if (getOrThrow(await env.exists(path.join(current, '.git'), context)))
      return true;
    const parent = path.dirname(current);
    if (parent === current)
      return false;
    current = parent;
  }
}

// rg JSON encodes non-UTF-8 text as base64 'bytes' instead of 'text'; decode it so no hit is lost.
function textOf(field) {
  if (field === undefined)
    return undefined;
  if (typeof field.text === 'string')
    return field.text;
  if (typeof field.bytes === 'string')
    return Buffer.from(field.bytes, 'base64').toString('utf8');
  return undefined;
}

/**
 * Search file contents with ripgrep (rg). Output is formatted from rg's JSON stream: match lines as
 * 'path:line: text', context lines as 'path-line- text', with paths relative to the search root (or
 * just the file name for a single-file search). Bounded accumulation: at most 50KB of visible result,
 * at most 'limit' matches plus their trailing context, 500 Unicode code points per line, and a 64KB
 * cap on a single rg JSON record. The scan is stopped (only this command's process) as soon as a bound
 * is hit, so a huge tree is not walked to completion.
 */
export function createGrepTool({ dataRoot, toolPaths } = {}) {
  return defineTool({
    name: 'grep',
    description: "Search file contents for a pattern. Returns matching lines with paths relative to the search root and line numbers. Respects .gitignore (inside and outside git work trees) and excludes .git; hidden files are searched. Output is truncated to 100 matches or 50KB (whichever is hit first), and lines longer than 500 characters are truncated with a '…' marker.",
    parameters: grepSchema,
    replay: 'safe',
    outputLimits: { maxBytes: MAX_VISIBLE_BYTES, maxLines: MAX_VISIBLE_LINES, retain: 'head' },
    async execute(args, api, context) {
      const env = requireEnv(api);
      const limit = args.limit ?? DEFAULT_LIMIT;
      const contextLines = args.context ?? 0;
      const { root, kind } = await resolveSearchTarget(env, args.path, context);
      const rgPath = resolveSearchBinary('rg', { dataRoot, toolPaths });
      // A single-file search starts from the file's directory, so ignore rules of its ancestors apply
      // and rg never tries to walk the file itself as a directory.
      const searchStart = kind === 'directory' ? root : path.dirname(root);
      const searchTarget = kind === 'directory' ? root : path.basename(root);
      const argv = [rgPath, '--json', '--line-number', '--color=never', '--hidden', '--regexp=' + args.pattern];
      if (args.ignoreCase)
        argv.push('--ignore-case');
      if (args.literal)
        argv.push('--fixed-strings');
      if (args.glob !== undefined)
        argv.push('--glob=' + args.glob);
      argv.push('--glob=!.git/**', '--glob=!**/.git/**');
      if (!(await insideGitWorkTree(env, searchStart, context)))
        argv.push('--no-require-git');
      if (contextLines > 0)
        argv.push('--context=' + contextLines);
      argv.push('--', searchTarget);

      const { context: execContext, cancel } = withCancel(context);
      const output = [];
      let outBytes = 0;
      let matchCount = 0;
      let lastMatchPath = null;
      let lastMatchLine = null;
      let linesTruncated = false;
      let lineBuf = '';
      let stderr = '';
      let stopped = null;
      let selfCancelled = false;
      const stop = (info) => {
        if (stopped !== null)
          return;
        stopped = info;
        selfCancelled = true;
        cancel(info.message);
      };
      const limitStopMessage = limit + ' matches limit reached; results may be incomplete. Use a larger limit or refine the pattern.';
      const recordTooLargeMessage = 'A single ripgrep output record exceeded the 64KB limit; search stopped. Refine the pattern or glob, or narrow the search path.';
      const appendLine = (text) => {
        if (output.length >= MAX_VISIBLE_LINES)
          return false;
        const bytes = Buffer.byteLength(text, 'utf8') + 1; // trailing newline separator of the joined output
        if (outBytes + bytes > MAX_VISIBLE_BYTES)
          return false;
        output.push(text);
        outBytes += bytes;
        return true;
      };
      const handleRecord = (line) => {
        if (stopped !== null)
          return;
        let event;
        try {
          event = JSON.parse(line);
        }
        catch {
          stop({ reason: 'protocol', message: 'Malformed JSON record in ripgrep output.' });
          return;
        }
        if (event.type === 'end') {
          // The trailing context of the last kept match precedes its file's end event; anything later can
          // only belong to other files or matches, so stop instead of walking the rest of the tree.
          if (matchCount >= limit)
            stop({ reason: 'limit', message: limitStopMessage });
          return;
        }
        if (event.type !== 'match' && event.type !== 'context')
          return;
        const filePath = textOf(event.data?.path);
        const lineNumber = event.data?.line_number;
        const lines = event.data?.lines;
        if (typeof filePath !== 'string' || typeof lineNumber !== 'number' ||
            (event.type === 'match' && (lines === undefined || textOf(lines) === undefined))) {
          stop({ reason: 'protocol', message: 'ripgrep output record is missing required fields.' });
          return;
        }
        const isMatch = event.type === 'match';
        if (isMatch) {
          if (matchCount >= limit) {
            stop({ reason: 'limit', message: limitStopMessage });
            return;
          }
          matchCount++;
          lastMatchPath = filePath;
          lastMatchLine = lineNumber;
        }
        else if (matchCount >= limit) {
          // Keep only the trailing context of the last kept match; a line of any other file or past its
          // context window belongs to a later match — stop instead of showing its leading context.
          if (filePath !== lastMatchPath || lineNumber > lastMatchLine + contextLines) {
            stop({ reason: 'limit', message: limitStopMessage });
            return;
          }
        }
        const shown = (textOf(lines) ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '').replace(/\n$/, '');
        const codePoints = Array.from(shown);
        let lineText;
        if (codePoints.length > MAX_LINE_CHARS) {
          lineText = codePoints.slice(0, MAX_LINE_CHARS).join('') + LINE_TRUNCATION_MARKER;
          linesTruncated = true;
        }
        else {
          lineText = shown;
        }
        const shownPath = displayPath(root, kind, filePath);
        const prefix = isMatch ? shownPath + ':' + lineNumber + ': ' : shownPath + '-' + lineNumber + '- ';
        if (!appendLine(prefix + lineText)) {
          stop({ reason: 'truncated', message: 'Output truncated to 50KB; results may be incomplete. Refine the pattern or glob, or narrow the search path.' });
        }
        else if (isMatch && contextLines === 0 && matchCount >= limit) {
          // No trailing context was requested; the limit is reached as soon as the last match is shown.
          stop({ reason: 'limit', message: limitStopMessage });
        }
      };
      const handleBoundedRecord = (line) => {
        if (Buffer.byteLength(line, 'utf8') > MAX_RECORD_BYTES) {
          stop({ reason: 'record', message: recordTooLargeMessage });
          return;
        }
        handleRecord(line);
      };
      const execResult = await env.exec(argv, {
        cwd: kind === 'directory' ? undefined : searchStart,
        timeout: TIMEOUT_SECONDS,
        onOutput: (text, _ctx, info) => {
          if (info.stream === 'stderr') {
            if (stderr.length < MAX_STDERR_BYTES) {
              stderr += text;
              if (stderr.length > MAX_STDERR_BYTES)
                stderr = stderr.slice(0, MAX_STDERR_BYTES);
            }
            return;
          }
          if (stopped !== null)
            return;
          lineBuf += text;
          let newline;
          while ((newline = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, newline);
            lineBuf = lineBuf.slice(newline + 1);
            if (line.length > 0)
              handleBoundedRecord(line);
          }
          if (lineBuf.length > 0 && Buffer.byteLength(lineBuf, 'utf8') > MAX_RECORD_BYTES) {
            stop({ reason: 'record', message: recordTooLargeMessage });
          }
        },
      }, execContext);

      if (context.abortSignal?.aborted) {
        if (execResult.ok)
          throw new ExecutionError('aborted', 'aborted');
        throw execResult.error;
      }
      if (!execResult.ok) {
        if (execResult.error.code !== 'aborted' || !selfCancelled)
          throw execResult.error;
      }
      // Flush a trailing fragment that arrived without a newline; a parse failure there is a protocol
      // error unless we stopped the scan ourselves.
      if (stopped === null && lineBuf.length > 0) {
        const line = lineBuf;
        lineBuf = '';
        handleBoundedRecord(line);
      }

      if (stopped?.reason === 'protocol' || stopped?.reason === 'record') {
        const stderrText = stderr.trim();
        const message = stderrText ? stopped.message + '\n' + stderrText : stopped.message;
        return {
          output: [{ type: 'text', text: message }],
          isError: true,
          diagnostics: [{ severity: 'error', code: stopped.reason === 'protocol' ? 'record_parse_error' : 'record_too_large', message }],
        };
      }
      if (execResult.ok && !selfCancelled) {
        const exitCode = execResult.value.exitCode;
        if (exitCode !== 0 && exitCode !== 1) {
          const stderrText = stderr.trim();
          const message = stderrText || 'ripgrep exited with code ' + exitCode;
          return {
            output: [{ type: 'text', text: message }],
            isError: true,
            diagnostics: [{ severity: 'error', code: 'exit_code', message: 'ripgrep exited with code ' + exitCode }],
          };
        }
      }
      if (matchCount === 0) {
        if (stopped?.reason === 'truncated') {
          const message = 'Output was truncated before any match could be shown. Refine the pattern or glob, or narrow the search path.';
          return { output: [{ type: 'text', text: message }], isError: true, diagnostics: [{ severity: 'error', code: 'output_truncated', message }] };
        }
        return { output: [{ type: 'text', text: 'No matches found' }] };
      }
      const diagnostics = [];
      if (stopped?.reason === 'limit')
        diagnostics.push({ severity: 'warn', code: 'match_limit', message: stopped.message });
      if (stopped?.reason === 'truncated')
        diagnostics.push({ severity: 'warn', code: 'output_truncated', message: stopped.message });
      if (linesTruncated)
        diagnostics.push({ severity: 'warn', code: 'line_truncated', message: 'Some lines truncated to 500 characters. Use the read tool to see full lines' });
      return { output: [{ type: 'text', text: output.join('\n') }], diagnostics };
    },
  });
}
