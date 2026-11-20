import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareWithBaseline,
  countCssLiterals,
  countTsxCjkLines,
  formatViolations,
  readBaseline,
  scanUiLiterals,
} from '../../scripts/check-ui-literals.mjs';

test('countCssLiterals exempts styles.css top token block and ui-literal-ok lines', () => {
  const stylesSample = [
    '@import "tailwindcss";',
    ':root {',
    '  --color-bg: #faf9f6;',
    '  --color-scrim: rgb(0 0 0 / .45);',
    '}',
    ':root[data-theme=dark] { --color-bg: #191b19; }',
    '@media (prefers-color-scheme: dark) {',
    '  :root[data-theme=system] { --color-bg: #191b19; }',
    '}',
    '* { box-sizing: border-box; }',
    '.ok { color: #fff; /* ui-literal-ok */ }',
    '/* comment #123456 rgba(0,0,0,0.5) */',
    '.bad-hex { color: #2563eb; }',
    '.bad-rgb { background: rgba(0, 0, 0, 0.2); }',
    '.bad-hsl { border-color: hsl(210 50% 50%); }',
  ].join('\n');
  assert.equal(countCssLiterals(stylesSample, 'web/src/styles.css'), 3);
  assert.equal(countCssLiterals('.other { color: #112233; }', 'web/src/other.css'), 1);
});

test('countTsxCjkLines ignores comments, t() calls, and i18n-ok lines', () => {
  const tsxSample = [
    '// 纯中文注释',
    '/* 多行注释',
    ' * 中文说明',
    ' */',
    "const url = 'https://example.com'; // 尾部中文注释",
    "const ok1 = t('确定', 'OK');",
    "const ok2 = raw.includes('主智能体受保护'); // i18n-ok",
    "{/* JSX 注释中文 */}",
    "const bad1 = '硬编码中文';",
    "const bad2 = format('不要误判');",
  ].join('\n');
  assert.equal(countTsxCjkLines(tsxSample), 2);
});

test('compareWithBaseline flags exceeded counts and untracked files', () => {
  const baseline = { css: { 'web/src/a.css': 2 }, cjk: { 'web/src/A.tsx': 1 } };
  assert.equal(compareWithBaseline({ css: { 'web/src/a.css': 2 }, cjk: {} }, baseline).ok, true);

  const exceeded = compareWithBaseline({ css: { 'web/src/a.css': 3 }, cjk: { 'web/src/A.tsx': 1 } }, baseline);
  assert.equal(exceeded.ok, false);
  assert.equal(exceeded.violations.length, 1);
  assert.equal(exceeded.violations[0].reason, 'exceeded');

  const untracked = compareWithBaseline(
    { css: { 'web/src/a.css': 2, 'web/src/new.css': 1 }, cjk: { 'web/src/A.tsx': 1 } },
    baseline,
  );
  assert.equal(untracked.ok, false);
  assert.equal(untracked.violations.length, 1);
  assert.equal(untracked.violations[0].reason, 'untracked');
});

test('web/src UI color literals and untranslated CJK lines do not exceed baseline', () => {
  const actual = scanUiLiterals();
  const baseline = readBaseline();
  const result = compareWithBaseline(actual, baseline);
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : `UI literals check failed:\n${formatViolations(result.violations)}`,
  );
});
