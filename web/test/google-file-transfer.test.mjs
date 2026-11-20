import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatAttachmentRef, uploadAttachment } from '../../host-core/attachments.js';
import {
  DRIVE_UPLOAD_MAX_BYTES,
  GMAIL_DRAFT_ATTACH_MAX_BYTES,
  GMAIL_DRAFT_MAX_ATTACHMENTS,
  GOOGLE_DOWNLOAD_DIR_NAME,
  TOOL_DOWNLOAD_MAX_BYTES,
  finishGoogleFileCall,
  prepareGoogleFileCall,
} from '../../host-core/google-file-transfer.js';

// Valid 1x1 PNG image bytes.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2m8AAAAASUVORK5CYII=',
  'base64'
);

async function withTempDirs(fn) {
  const root = await mkdtemp(join(tmpdir(), 'pibot-google-file-transfer-'));
  const cwd = join(root, 'workspace');
  const outside = join(root, 'outside');
  const dataRoot = join(root, 'data');
  await mkdir(cwd, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  try {
    await fn({ root, cwd, outside, dataRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('drive_upload stages workspace file, strips path, keeps caller args immutable, and rejects escape/symlink/raw data/oversize', async () => {
  await withTempDirs(async ({ cwd, outside }) => {
    const content = Buffer.from('Q4 financial report');
    await writeFile(join(cwd, 'report.pdf'), content);
    await writeFile(join(outside, 'secret.txt'), 'top-secret');

    const originalArgs = { path: 'report.pdf', folder: 'Q4', convert: false };
    const staged = await prepareGoogleFileCall('drive_upload', originalArgs, { cwd });
    assert.equal(originalArgs.path, 'report.pdf');
    assert.equal(staged.path, undefined);
    assert.equal(staged.name, 'report.pdf');
    assert.equal(staged.data, content.toString('base64'));
    assert.equal(staged.folder, 'Q4');

    // Refuses model-supplied raw base64 data.
    await assert.rejects(
      () => prepareGoogleFileCall('drive_upload', { name: 'a.txt', data: Buffer.from('x').toString('base64') }, { cwd }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    // Refuses path traversal outside workspace.
    await assert.rejects(
      () => prepareGoogleFileCall('drive_upload', { path: '../outside/secret.txt' }, { cwd }),
      (err) => err.code === 'FORBIDDEN'
    );

    // Refuses symlink escaping workspace.
    const linkPath = join(cwd, 'escape-link.txt');
    let symlinkCreated = false;
    try {
      await symlink(join(outside, 'secret.txt'), linkPath);
      symlinkCreated = true;
    } catch {
      // Windows without symlink privileges may reject creating symlinks.
    }
    if (symlinkCreated) {
      await assert.rejects(
        () => prepareGoogleFileCall('drive_upload', { path: 'escape-link.txt' }, { cwd }),
        (err) => err.code === 'FORBIDDEN'
      );
    }

    // Refuses files larger than DRIVE_UPLOAD_MAX_BYTES.
    await writeFile(join(cwd, 'too-big.bin'), Buffer.alloc(DRIVE_UPLOAD_MAX_BYTES + 1, 0x42));
    await assert.rejects(
      () => prepareGoogleFileCall('drive_upload', { path: 'too-big.bin' }, { cwd }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );
  });
});

test('drive_upload and gmail_draft support attachment://<sha256> refs via host-core/attachments', async () => {
  await withTempDirs(async ({ cwd, dataRoot }) => {
    const botId = 'bot-1';
    const meta = await uploadAttachment(dataRoot, botId, {
      name: 'diagram.png',
      mimeType: 'image/png',
      data: TINY_PNG.toString('base64'),
    });
    const ref = formatAttachmentRef(meta.id);

    const uploadArgs = await prepareGoogleFileCall('drive_upload', { path: ref }, { cwd, dataRoot, botId });
    assert.equal(uploadArgs.name, 'diagram.png');
    assert.equal(uploadArgs.data, TINY_PNG.toString('base64'));

    const draftArgs = await prepareGoogleFileCall(
      'gmail_draft',
      { to: ['sam@acme.dev'], subject: 'Diagram', body: 'See attached', attachments: [ref] },
      { cwd, dataRoot, botId }
    );
    assert.deepEqual(draftArgs.attachments, [{ name: 'diagram.png', data: TINY_PNG.toString('base64') }]);

    // Without dataRoot/botId, attachment:// must be rejected.
    await assert.rejects(
      () => prepareGoogleFileCall('drive_upload', { path: ref }, { cwd }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );
  });
});

test('gmail_draft stages multiple attachments within shared byte and count budgets and rejects raw data', async () => {
  await withTempDirs(async ({ cwd }) => {
    await writeFile(join(cwd, 'a.txt'), 'alpha');
    await writeFile(join(cwd, 'b.txt'), 'beta');

    const prepared = await prepareGoogleFileCall(
      'gmail_draft',
      {
        to: ['sam@acme.dev'],
        subject: 'Files',
        body: 'Attached',
        attach: 'a.txt',
        attachments: [{ path: 'b.txt', name: 'renamed-b.txt' }],
      },
      { cwd }
    );
    assert.equal(prepared.attach, undefined);
    assert.deepEqual(prepared.attachments, [
      { name: 'a.txt', data: Buffer.from('alpha').toString('base64') },
      { name: 'renamed-b.txt', data: Buffer.from('beta').toString('base64') },
    ]);

    // Shared budget enforcement across two files.
    const halfPlus = Math.floor(GMAIL_DRAFT_ATTACH_MAX_BYTES / 2) + 100;
    await writeFile(join(cwd, 'big1.bin'), Buffer.alloc(halfPlus, 1));
    await writeFile(join(cwd, 'big2.bin'), Buffer.alloc(halfPlus, 2));
    await assert.rejects(
      () => prepareGoogleFileCall('gmail_draft', { attachments: ['big1.bin', 'big2.bin'] }, { cwd }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    // Attachment count cap.
    const tooMany = Array.from({ length: GMAIL_DRAFT_MAX_ATTACHMENTS + 1 }, () => 'a.txt');
    await assert.rejects(
      () => prepareGoogleFileCall('gmail_draft', { attachments: tooMany }, { cwd }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );

    // Rejects model-supplied raw base64 in attachments.
    await assert.rejects(
      () => prepareGoogleFileCall('gmail_draft', { attachments: [{ name: 'x.txt', data: 'YQ==' }] }, { cwd }),
      (err) => err.code === 'INVALID_ARGUMENT'
    );
  });
});

test('drive_download and gmail_attachment save safely without overwrite, deduplicate by SHA-256, and never leak base64', async () => {
  await withTempDirs(async ({ cwd }) => {
    const payloadBytes = Buffer.from('PDF-binary-content-1234567890');
    const payloadBase64 = payloadBytes.toString('base64');
    const expectedHash = createHash('sha256').update(payloadBytes).digest('hex');

    // 1. Explicit out path: prepare strips out without mutating original args, finish writes atomically.
    const originalArgs = { ref: '1AbCdefGhIjKlMnOpQrSt', out: 'downloads/q4.pdf' };
    const forwarded = await prepareGoogleFileCall('drive_download', originalArgs, { cwd });
    assert.equal(originalArgs.out, 'downloads/q4.pdf');
    assert.equal(forwarded.out, undefined);

    const mcpResult = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            file: { id: '1AbCdefGhIjKlMnOpQrSt', name: 'q4.pdf', mimeType: 'application/pdf' },
            name: 'q4.pdf',
            data: payloadBase64,
          }),
        },
      ],
      structuredContent: {
        file: { id: '1AbCdefGhIjKlMnOpQrSt', name: 'q4.pdf', mimeType: 'application/pdf' },
        name: 'q4.pdf',
        data: payloadBase64,
      },
      isError: false,
    };

    const finished = await finishGoogleFileCall('drive_download', mcpResult, { cwd, args: originalArgs });
    assert.equal(JSON.stringify(finished).includes(payloadBase64), false, 'base64 must never leak back to model');
    assert.equal(finished.structuredContent.data, undefined);
    assert.equal(finished.structuredContent.sha256, expectedHash);
    assert.equal(finished.structuredContent.relativePath, join('downloads', 'q4.pdf'));
    assert.deepEqual(await readFile(join(cwd, 'downloads', 'q4.pdf')), payloadBytes);

    // Refuses overwriting existing out path in both prepare and finish.
    await assert.rejects(
      () => prepareGoogleFileCall('drive_download', originalArgs, { cwd }),
      (err) => err.code === 'FILE_EXISTS'
    );
    await assert.rejects(
      () => finishGoogleFileCall('drive_download', mcpResult, { cwd, args: originalArgs }),
      (err) => err.code === 'FILE_EXISTS'
    );

    // Refuses escape path in out.
    await assert.rejects(
      () => prepareGoogleFileCall('drive_download', { ref: '1AbCdefGhIjKlMnOpQrSt', out: '../outside/evil.pdf' }, { cwd }),
      (err) => err.code === 'FORBIDDEN'
    );

    // 2. Without out path: content-addressed dedup inside workspace .google-downloads/<sha256>/<safeName>.
    const gmailRaw = {
      ref: 'gmail:att:msg1:2',
      name: 'CON.pdf',
      mimeType: 'application/pdf',
      size: payloadBytes.length,
      data: payloadBase64,
    };
    const first = await finishGoogleFileCall('gmail_attachment', gmailRaw, { cwd, args: { ref: 'gmail:att:msg1:2' } });
    assert.equal(first.data, undefined);
    assert.equal(first.deduplicated, false);
    assert.equal(first.name, '_CON.pdf');
    assert.equal(first.relativePath, join(GOOGLE_DOWNLOAD_DIR_NAME, expectedHash, '_CON.pdf'));

    const second = await finishGoogleFileCall('gmail_attachment', gmailRaw, { cwd, args: { ref: 'gmail:att:msg1:2' } });
    assert.equal(second.deduplicated, true);
    assert.equal(second.savedTo, first.savedTo);

    // Tampered content-addressed file triggers REQUEST_CONFLICT instead of silent reuse/overwrite.
    await writeFile(first.savedTo, 'tampered');
    await assert.rejects(
      () => finishGoogleFileCall('gmail_attachment', gmailRaw, { cwd, args: { ref: 'gmail:att:msg1:2' } }),
      (err) => err.code === 'REQUEST_CONFLICT'
    );
  });
});

test('downloaded JPEG/PNG without out reuses host-core/attachments and returns attachment://<sha256>', async () => {
  await withTempDirs(async ({ cwd, dataRoot }) => {
    const botId = 'bot-img';
    const pngBase64 = TINY_PNG.toString('base64');
    const raw = {
      ref: 'gmail:att:msg2:1',
      name: 'photo.png',
      mimeType: 'image/png',
      size: TINY_PNG.length,
      data: pngBase64,
    };
    const res1 = await finishGoogleFileCall('gmail_attachment', raw, {
      cwd,
      dataRoot,
      botId,
      args: { ref: 'gmail:att:msg2:1' },
    });
    assert.equal(res1.data, undefined);
    assert.equal(res1.savedTo, undefined);
    assert.ok(res1.attachmentRef.startsWith('attachment://'));
    assert.equal(res1.width, 1);
    assert.equal(res1.height, 1);
    assert.equal(res1.deduplicated, false);

    const res2 = await finishGoogleFileCall('gmail_attachment', raw, {
      cwd,
      dataRoot,
      botId,
      args: { ref: 'gmail:att:msg2:1' },
    });
    assert.equal(res2.attachmentRef, res1.attachmentRef);
    assert.equal(res2.deduplicated, true);
  });
});

test('finishGoogleFileCall rejects oversized/malformed downloads and passes through errors and non-download tools', async () => {
  await withTempDirs(async ({ cwd }) => {
    const errRes = { content: [{ type: 'text', text: 'Not found' }], isError: true };
    assert.equal(await finishGoogleFileCall('drive_download', errRes, { cwd, args: { ref: 'x' } }), errRes);

    const searchRes = { account: 'a@b.com', files: [] };
    assert.equal(await finishGoogleFileCall('drive_search', searchRes, { cwd, args: {} }), searchRes);

    await assert.rejects(
      () => finishGoogleFileCall('drive_download', { name: 'a.bin', data: 'not-base64!' }, { cwd, args: { ref: 'x' } }),
      (err) => err.code === 'BAD_RESPONSE'
    );

    const tooLarge = Buffer.alloc(TOOL_DOWNLOAD_MAX_BYTES + 1, 0x33).toString('base64');
    await assert.rejects(
      () => finishGoogleFileCall('drive_download', { name: 'huge.bin', data: tooLarge }, { cwd, args: { ref: 'x' } }),
      (err) => err.code === 'BAD_RESPONSE'
    );
  });
});
