import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyMarkdownLink } from '../src/markdownLink.ts';

test('chat backup directories and relative paths are copyable Host paths, not web links', () => {
  for (const path of ['/home/services/e-launcher/backups/rollout/', './reports/receipt.md', 'reports/receipt.md']) {
    assert.deepEqual(classifyMarkdownLink(path), { kind: 'host-path', path });
  }
});

test('chat only opens explicit, credential-free HTTPS links in the browser', () => {
  const href = 'https://example.test/receipt?version=2#details';
  assert.deepEqual(classifyMarkdownLink(href), { kind: 'web', href });
  for (const blocked of [
    undefined, '', 'http://example.test/receipt', '//example.test/receipt',
    '#details', 'https:///missing-host', 'https://user:password@example.test/',
    'file:///home/services/secret', 'javascript:alert(1)',
  ]) {
    assert.equal(classifyMarkdownLink(blocked), null, blocked);
  }
});
