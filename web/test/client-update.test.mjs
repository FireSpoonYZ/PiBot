import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatUpdateBytes,
  resolveAutoInstallAction,
  updateProgress,
} from '../src/ClientUpdate.ts';

test('resolveAutoInstallAction chains downloaded -> install only when user armed download-and-install', () => {
  // Unarmed (e.g. reopened app with a previously downloaded package): never auto-install.
  assert.equal(resolveAutoInstallAction(false, 'downloaded'), 'clear');
  assert.equal(resolveAutoInstallAction(false, 'downloading'), 'clear');
  assert.equal(resolveAutoInstallAction(false, 'available'), 'clear');
  assert.equal(resolveAutoInstallAction(false, undefined), 'clear');

  // Armed after user clicked "下载并安装":
  // - still downloading (async platforms like Android): keep waiting
  assert.equal(resolveAutoInstallAction(true, 'downloading'), 'keep');
  // - download finished: immediately trigger install
  assert.equal(resolveAutoInstallAction(true, 'downloaded'), 'install');

  // Any terminal / cancelled / error / idle / already-installing phase clears the armed intent
  for (const phase of [
    'idle',
    'checking',
    'available',
    'up-to-date',
    'waiting-permission',
    'waiting-install',
    'waiting-tasks',
    'installing',
    'complete',
    'cancelled',
    'error',
    undefined,
  ]) {
    assert.equal(resolveAutoInstallAction(true, phase), 'clear', `phase=${String(phase)}`);
  }
});

test('updateProgress and formatUpdateBytes handle edge cases cleanly', () => {
  assert.equal(updateProgress(undefined), null);
  assert.equal(updateProgress({ phase: 'downloading', currentVersion: '0.0.30', downloadedBytes: 0, totalBytes: 0 }), null);
  assert.equal(updateProgress({ phase: 'downloading', currentVersion: '0.0.30', downloadedBytes: 50, totalBytes: 200 }), 25);
  assert.equal(updateProgress({ phase: 'downloading', currentVersion: '0.0.30', downloadedBytes: 300, totalBytes: 200 }), 100);
  assert.equal(formatUpdateBytes(512), '512 B');
  assert.equal(formatUpdateBytes(1024 * 1024 * 64.2), '64.2 MB');
  assert.equal(formatUpdateBytes(undefined), '');
});
