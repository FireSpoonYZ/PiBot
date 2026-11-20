import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideImagePasteAction,
  extractValidPastedImageFiles,
  isDesktopLinuxPlatform,
  pickedImagesToFiles,
} from '../../desktop/web/src/imagePaste.ts';

function makeClipboard({ files = [], items = [], text = '' } = {}) {
  return {
    files,
    items,
    getData(format) {
      return format === 'text/plain' ? text : '';
    },
  };
}

test('zero-byte DOM images are ignored and trigger Linux native clipboard fallback when text is empty', () => {
  const zeroFile = new File([], 'empty.png', { type: 'image/png' });
  const clipboard = makeClipboard({
    files: [zeroFile],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => zeroFile }],
    text: '',
  });

  assert.deepEqual(extractValidPastedImageFiles(clipboard), []);
  assert.deepEqual(
    decideImagePasteAction(clipboard, { isDesktopLinux: true, hasNativeClipboard: true }),
    { files: [], preventDefault: false, useNativeClipboardFallback: true },
  );
  assert.deepEqual(
    decideImagePasteAction(clipboard, { isDesktopLinux: false, hasNativeClipboard: true }),
    { files: [], preventDefault: false, useNativeClipboardFallback: false },
  );
});

test('empty DOM paste (WebKitGTK Wayland PNG) falls back only on desktop Linux with empty text', () => {
  const emptyClipboard = makeClipboard({ files: [], items: [], text: '' });
  assert.deepEqual(
    decideImagePasteAction(emptyClipboard, { isDesktopLinux: true, hasNativeClipboard: true }),
    { files: [], preventDefault: false, useNativeClipboardFallback: true },
  );
  assert.deepEqual(
    decideImagePasteAction(emptyClipboard, { isDesktopLinux: true, hasNativeClipboard: false }),
    { files: [], preventDefault: false, useNativeClipboardFallback: false },
  );
  assert.deepEqual(
    decideImagePasteAction(emptyClipboard, { isDesktopLinux: false, hasNativeClipboard: true }),
    { files: [], preventDefault: false, useNativeClipboardFallback: false },
  );

  // Plain text paste (including whitespace-only) is preserved without preventDefault or fallback.
  for (const text of ['hello world', '   ']) {
    const textClipboard = makeClipboard({ files: [], items: [], text });
    assert.deepEqual(
      decideImagePasteAction(textClipboard, { isDesktopLinux: true, hasNativeClipboard: true }),
      { files: [], preventDefault: false, useNativeClipboardFallback: false },
    );
  }
});

test('valid DOM image preserves preventDefault on empty text and allows normal text paste when text is present', () => {
  const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'shot.png', { type: 'image/png' });

  const imageOnly = makeClipboard({ files: [png], text: '' });
  const onlyDecision = decideImagePasteAction(imageOnly, { isDesktopLinux: true, hasNativeClipboard: true });
  assert.equal(onlyDecision.files.length, 1);
  assert.equal(onlyDecision.preventDefault, true);
  assert.equal(onlyDecision.useNativeClipboardFallback, false);

  const imageWithText = makeClipboard({ files: [png], text: 'caption' });
  const withTextDecision = decideImagePasteAction(imageWithText, { isDesktopLinux: true, hasNativeClipboard: true });
  assert.equal(withTextDecision.files.length, 1);
  assert.equal(withTextDecision.preventDefault, false);
  assert.equal(withTextDecision.useNativeClipboardFallback, false);
});

test('desktop Linux platform check excludes Android, Windows, and macOS', () => {
  assert.equal(
    isDesktopLinuxPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64)' }),
    true,
  );
  assert.equal(
    isDesktopLinuxPlatform({ platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' }),
    false,
  );
  assert.equal(
    isDesktopLinuxPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }),
    false,
  );
  assert.equal(
    isDesktopLinuxPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }),
    false,
  );
});

test('pickedImagesToFiles decodes base64 payloads into non-empty File instances', async () => {
  const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const files = pickedImagesToFiles([
    { name: 'clipboard.png', mimeType: 'image/png', data: Buffer.from(raw).toString('base64') },
    { name: 'empty.png', mimeType: 'image/png', data: '' },
  ]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'clipboard.png');
  assert.equal(files[0].type, 'image/png');
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()), raw);
});
