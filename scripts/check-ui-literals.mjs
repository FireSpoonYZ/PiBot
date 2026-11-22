#!/usr/bin/env node
// scripts/check-ui-literals.mjs — 静态守卫：防止 web/src 新增 CSS 颜色字面量与未走 t() 的 CJK 文案。
//
//   node scripts/check-ui-literals.mjs                    # 输出计数 JSON 并与基线比较，超基线或新文件则 exit 1
//   node scripts/check-ui-literals.mjs --write-baseline   # 写入 scripts/ui-literals-baseline.json
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_SRC_DIR = path.join(ROOT, 'web', 'src');
export const BASELINE_PATH = path.join(ROOT, 'scripts', 'ui-literals-baseline.json');

const CSS_COLOR_LITERAL_RE =
  /(?<![A-Za-z0-9_-])(?:#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![A-Za-z0-9_-])|(?:rgba?|hsla?)\s*\()/i;
const STYLES_TOP_TOKEN_HEAD_RE =
  /^(?:@import\b|:root\b|@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\))/;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const TRANSLATE_CALL_RE = /(?<![A-Za-z0-9_$])t\s*\(/;

function toPosixRel(rootDir, absPath) {
  return path.relative(rootDir, absPath).split(path.sep).join('/');
}

function collectFiles(dir, extension, results = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, extension, results);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      results.push(fullPath);
    }
  }
  return results;
}

function stripCssCommentsByLine(source) {
  const rawLines = source.split(/\r?\n/);
  let inComment = false;
  return rawLines.map((raw, idx) => {
    let code = '';
    let i = 0;
    while (i < raw.length) {
      if (inComment) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
        } else {
          inComment = false;
          i = end + 2;
        }
      } else {
        const start = raw.indexOf('/*', i);
        if (start === -1) {
          code += raw.slice(i);
          i = raw.length;
        } else {
          code += raw.slice(i, start);
          inComment = true;
          i = start + 2;
        }
      }
    }
    return { lineNo: idx + 1, raw, code };
  });
}

function countBraces(text) {
  let delta = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '{') delta += 1;
    else if (text[i] === '}') delta -= 1;
  }
  return delta;
}

export function countCssLiterals(source, relPath) {
  const lines = stripCssCommentsByLine(source);
  let inTopTokenBlock =
    relPath === 'web/src/styles.css' || relPath === 'web/src/design-system/tokens.css';
  let braceDepth = 0;
  let count = 0;

  for (const { raw, code } of lines) {
    if (inTopTokenBlock && braceDepth === 0) {
      const trimmed = code.trim();
      if (trimmed && !STYLES_TOP_TOKEN_HEAD_RE.test(trimmed)) {
        inTopTokenBlock = false;
      }
    }
    const exemptTopTokens = inTopTokenBlock;
    braceDepth = Math.max(0, braceDepth + countBraces(code));

    if (exemptTopTokens) continue;
    if (raw.includes('ui-literal-ok')) continue;
    if (CSS_COLOR_LITERAL_RE.test(code)) {
      count += 1;
    }
  }

  return count;
}

function stripTsxCommentsByLine(source) {
  const rawLines = source.split(/\r?\n/);
  let inBlockComment = false;
  return rawLines.map((raw, idx) => {
    let code = '';
    let i = 0;
    let quote = null;
    while (i < raw.length) {
      const ch = raw[i];
      const next = raw[i + 1];
      if (inBlockComment) {
        const end = raw.indexOf('*/', i);
        if (end === -1) {
          i = raw.length;
        } else {
          inBlockComment = false;
          i = end + 2;
        }
        continue;
      }
      if (quote) {
        code += ch;
        if (ch === '\\' && i + 1 < raw.length) {
          code += next;
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === '/' && next === '*') {
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (ch === '/' && next === '/') {
        break;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        code += ch;
        i += 1;
        continue;
      }
      code += ch;
      i += 1;
    }
    return { lineNo: idx + 1, raw, code };
  });
}

export function countTsxCjkLines(source) {
  const lines = stripTsxCommentsByLine(source);
  let count = 0;

  for (const { raw, code } of lines) {
    if (raw.includes('i18n-ok')) continue;
    if (!CJK_RE.test(code)) continue;
    if (TRANSLATE_CALL_RE.test(code)) continue;
    count += 1;
  }

  return count;
}

function sortRecord(entries) {
  const out = {};
  for (const [key, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    out[key] = value;
  }
  return out;
}

export function scanUiLiterals(rootDir = ROOT) {
  const srcDir = path.join(rootDir, 'web', 'src');
  const cssEntries = [];
  for (const file of collectFiles(srcDir, '.css')) {
    const rel = toPosixRel(rootDir, file);
    const count = countCssLiterals(readFileSync(file, 'utf8'), rel);
    if (count > 0) cssEntries.push([rel, count]);
  }

  const cjkEntries = [];
  for (const file of collectFiles(srcDir, '.tsx')) {
    const rel = toPosixRel(rootDir, file);
    const count = countTsxCjkLines(readFileSync(file, 'utf8'));
    if (count > 0) cjkEntries.push([rel, count]);
  }

  return {
    css: sortRecord(cssEntries),
    cjk: sortRecord(cjkEntries),
  };
}

export function readBaseline(baselinePath = BASELINE_PATH) {
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  return {
    css: parsed && typeof parsed.css === 'object' && parsed.css !== null ? parsed.css : {},
    cjk: parsed && typeof parsed.cjk === 'object' && parsed.cjk !== null ? parsed.cjk : {},
  };
}

export function compareWithBaseline(actual, baseline) {
  const violations = [];
  for (const category of ['css', 'cjk']) {
    const actualMap = actual?.[category] ?? {};
    const baseMap = baseline?.[category] ?? {};
    for (const file of Object.keys(actualMap).sort()) {
      const count = actualMap[file];
      if (count <= 0) continue;
      if (!Object.prototype.hasOwnProperty.call(baseMap, file)) {
        violations.push({ category, file, actual: count, baseline: null, reason: 'untracked' });
      } else if (count > baseMap[file]) {
        violations.push({ category, file, actual: count, baseline: baseMap[file], reason: 'exceeded' });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export function formatViolations(violations) {
  return violations
    .map((v) =>
      v.reason === 'untracked'
        ? `[${v.category}] ${v.file}: ${v.actual} (not in baseline)`
        : `[${v.category}] ${v.file}: ${v.actual} > baseline ${v.baseline}`,
    )
    .join('\n');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  const self = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === 'win32' ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

function main() {
  const writeBaseline = process.argv.includes('--write-baseline');
  const actual = scanUiLiterals();
  const payload = JSON.stringify(actual, null, 2) + '\n';

  if (writeBaseline) {
    writeFileSync(BASELINE_PATH, payload, 'utf8');
    process.stdout.write(payload);
    return;
  }

  process.stdout.write(payload);
  const baseline = readBaseline();
  const result = compareWithBaseline(actual, baseline);
  if (!result.ok) {
    console.error('UI literal check failed:\n' + formatViolations(result.violations));
    process.exit(1);
  }
}

if (isMainModule()) {
  main();
}
