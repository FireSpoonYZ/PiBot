import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASKED_BY_MAX_CHARS,
  DRIVE_UPLOAD_MAX_BYTES,
  FILE_TOOL_NAMES,
  createFileTools,
  fileTools,
} from '../../center-server/google-workspace/file-tools.js';

function fakeApi() {
  return {
    email: 'owner@acme.dev',
    get: async () => { throw new Error('unexpected direct api.get'); },
    find: async () => { throw new Error('unexpected direct api.find'); },
    send: async () => { throw new Error('unexpected direct api.send'); },
    bytes: async () => { throw new Error('unexpected direct api.bytes'); },
  };
}

function makeRecorder() {
  const calls = [];
  const modules = {
    'google-drive': {
      searchDrive: async (api, args) => { calls.push(['searchDrive', api.email, args]); return { account: api.email, files: [] }; },
      uploadDrive: async (api, args) => { calls.push(['uploadDrive', api.email, args]); return { account: api.email, file: { id: 'f1', name: args.name, mimeType: 'application/pdf' }, done: 'Uploaded' }; },
      makeFolder: async (api, args) => { calls.push(['makeFolder', api.email, args]); return { account: api.email, file: { id: 'd1', name: args.name, mimeType: 'application/vnd.google-apps.folder' }, done: 'Made folder' }; },
      moveDrive: async (api, args) => { calls.push(['moveDrive', api.email, args]); return { account: api.email, file: { id: 'f1', name: 'x', mimeType: 'application/pdf' }, done: 'Moved' }; },
      shareDrive: async (api, args) => { calls.push(['shareDrive', api.email, args]); return { account: api.email, file: { id: 'f1', name: 'x', mimeType: 'application/pdf' }, done: 'Shared' }; },
    },
    'google-drive-read': {
      readDrive: async (api, args) => { calls.push(['readDrive', api.email, args]); return { account: api.email, file: { id: 'f1', name: 'x', mimeType: 'text/plain' }, source: 'text/plain', text: 'hello' }; },
      downloadDrive: async (api, ref) => { calls.push(['downloadDrive', api.email, ref]); return { file: { id: 'f1', name: 'x.pdf', mimeType: 'application/pdf' }, name: 'x.pdf', data: Buffer.from('pdf').toString('base64') }; },
    },
    'google-docs': {
      readDoc: async (api, args) => { calls.push(['readDoc', api.email, args]); return { account: api.email, id: 'doc1', title: 'T', link: 'https://docs.google.com/document/d/doc1/edit', text: '', suggestions: 0, comments: [], openComments: 0 }; },
      createDoc: async (api, args) => { calls.push(['createDoc', api.email, args]); return { account: api.email, id: 'doc1', title: args.title, link: 'https://docs.google.com/document/d/doc1/edit', done: 'Created' }; },
      appendDoc: async (api, args) => { calls.push(['appendDoc', api.email, args]); return { account: api.email, id: 'doc1', title: 'T', link: 'https://docs.google.com/document/d/doc1/edit', done: 'Added to the end' }; },
      replaceInDoc: async (api, args) => { calls.push(['replaceInDoc', api.email, args]); return { account: api.email, id: 'doc1', title: 'T', link: 'https://docs.google.com/document/d/doc1/edit', done: 'Made 1 change' }; },
      commentOnDoc: async (api, args) => { calls.push(['commentOnDoc', api.email, args]); return { account: api.email, id: 'doc1', title: 'T', link: 'https://docs.google.com/document/d/doc1/edit', done: 'Commented on the doc' }; },
    },
    'google-sheets': {
      createSheet: async (api, title) => { calls.push(['createSheet', api.email, title]); return { account: api.email, id: 'sh1', title, link: 'https://docs.google.com/spreadsheets/d/sh1/edit', done: 'Created', ranges: [] }; },
      readSheet: async (api, args) => { calls.push(['readSheet', api.email, args]); return { account: api.email, id: 'sh1', title: 'S', link: 'https://docs.google.com/spreadsheets/d/sh1/edit', tabs: [], range: 'Sheet1!A1:B2', values: [], origin: { row: 1, column: 1 } }; },
      writeSheet: async (api, args) => { calls.push(['writeSheet', api.email, args]); return { account: api.email, id: 'sh1', title: 'S', link: 'https://docs.google.com/spreadsheets/d/sh1/edit', done: 'Wrote 1 row', ranges: ['Sheet1!A1'] }; },
      appendSheet: async (api, args) => { calls.push(['appendSheet', api.email, args]); return { account: api.email, id: 'sh1', title: 'S', link: 'https://docs.google.com/spreadsheets/d/sh1/edit', done: 'Added 1 row', ranges: ['Sheet1!A2'] }; },
      upsertSheet: async (api, args) => { calls.push(['upsertSheet', api.email, args]); return { account: api.email, id: 'sh1', title: 'S', link: 'https://docs.google.com/spreadsheets/d/sh1/edit', done: 'Updated 0, added 1', ranges: ['Sheet1!A2'] }; },
    },
  };
  const tools = createFileTools({ loadOrca: async () => modules });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('fileTools exports all 18 Drive/Docs/Sheets tools with strict schemas and no caller spoofing fields', () => {
  assert.deepEqual(fileTools.map((tool) => tool.name), FILE_TOOL_NAMES);
  assert.equal(fileTools.length, 18);
  const forbiddenProps = ['askedBy', 'caller', 'actor', 'botToken', 'callerSessionId'];
  for (const tool of fileTools) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 0);
    assert.equal(typeof tool.run, 'function');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.inputSchema.properties.account, `${tool.name} should accept optional account`);
    for (const forbidden of forbiddenProps) {
      assert.equal(tool.inputSchema.properties[forbidden], undefined, `${tool.name} must not expose ${forbidden}`);
    }
  }
});

test('all 18 tools delegate to upstream Orca domain functions with normalized arguments and trusted askedBy', async () => {
  const { calls, byName } = makeRecorder();
  const api = fakeApi();
  const askedBy = 'asked by Carol via Scout';

  await byName.get('drive_search').run({ query: '  Q4 budget  ', in: 'Finance', limit: 10, pageToken: 'tok1', account: 'owner@acme.dev' }, { api });
  await byName.get('drive_list').run({ folder: 'root', limit: 5 }, { api });
  await byName.get('drive_read').run({ ref: '1AbCdefGhIjKlMnOpQrSt', offset: 16000 }, { api });
  await byName.get('drive_download').run({ ref: '1AbCdefGhIjKlMnOpQrSt' }, { api });
  await byName.get('drive_upload').run({ name: 'report.pdf', data: Buffer.from('hello').toString('base64'), folder: 'Q4', convert: false }, { api, askedBy });
  await byName.get('drive_mkdir').run({ name: 'Q4', in: 'Finance' }, { api, askedBy });
  await byName.get('drive_move').run({ ref: '1AbCdefGhIjKlMnOpQrSt', folder: 'Q4' }, { api });
  await byName.get('drive_share').run({ ref: '1AbCdefGhIjKlMnOpQrSt', with: ['Sam@Acme.dev'], notify: false }, { api, askedBy });

  await byName.get('docs_read').run({ ref: '1AbCdefGhIjKlMnOpQrSt', offset: 0 }, { api });
  await byName.get('docs_create').run({ title: 'Launch notes', markdown: '# Hi', folder: 'Q4' }, { api, askedBy });
  await byName.get('docs_append').run({ ref: '1AbCdefGhIjKlMnOpQrSt', markdown: '## Next' }, { api });
  await byName.get('docs_replace').run({ ref: '1AbCdefGhIjKlMnOpQrSt', old: 'teh', new: 'the', suggest: true, matchCase: true }, { api });
  await byName.get('docs_comment').run({ ref: '1AbCdefGhIjKlMnOpQrSt', text: 'Looks good', on: 'by Friday' }, { api, askedBy });

  await byName.get('sheets_create').run({ title: 'Q4 leads' }, { api });
  await byName.get('sheets_read').run({ ref: '1AbCdefGhIjKlMnOpQrSt', tab: 'Q4', range: 'A1:F50' }, { api });
  await byName.get('sheets_write').run({ ref: '1AbCdefGhIjKlMnOpQrSt', tab: 'Q4', range: 'B2', values: [[1200]], formulas: false }, { api });
  await byName.get('sheets_append').run({ ref: '1AbCdefGhIjKlMnOpQrSt', values: [['Ada', 42]] }, { api });
  await byName.get('sheets_upsert').run({ ref: '1AbCdefGhIjKlMnOpQrSt', key: 'Email', values: [['Ada', 'ada@acme.dev']] }, { api });

  assert.equal(calls.length, 18);
  assert.deepEqual(calls[0], ['searchDrive', 'owner@acme.dev', { query: 'Q4 budget', in: 'Finance', limit: 10, pageToken: 'tok1' }]);
  assert.deepEqual(calls[1], ['searchDrive', 'owner@acme.dev', { in: 'root', limit: 5 }]);
  assert.deepEqual(calls[4], ['uploadDrive', 'owner@acme.dev', { name: 'report.pdf', data: Buffer.from('hello').toString('base64'), folder: 'Q4', convert: false, askedBy }]);
  assert.deepEqual(calls[5], ['makeFolder', 'owner@acme.dev', { name: 'Q4', in: 'Finance', askedBy }]);
  assert.deepEqual(calls[7], ['shareDrive', 'owner@acme.dev', { ref: '1AbCdefGhIjKlMnOpQrSt', with: ['sam@acme.dev'], role: 'reader', notify: false, askedBy }]);
  assert.deepEqual(calls[9], ['createDoc', 'owner@acme.dev', { title: 'Launch notes', markdown: '# Hi', folder: 'Q4', askedBy }]);
  assert.deepEqual(calls[11], ['replaceInDoc', 'owner@acme.dev', { ref: '1AbCdefGhIjKlMnOpQrSt', pairs: [{ old: 'teh', new: 'the' }], suggest: true, matchCase: true }]);
  assert.deepEqual(calls[12], ['commentOnDoc', 'owner@acme.dev', { ref: '1AbCdefGhIjKlMnOpQrSt', text: `Looks good\n\n${askedBy}`, on: 'by Friday' }]);
  assert.deepEqual(calls[13], ['createSheet', 'owner@acme.dev', 'Q4 leads']);
});

test('Center drive_upload refuses unstaged local paths, invalid base64, path separators in name, and oversized payloads', async () => {
  const { byName } = makeRecorder();
  const api = fakeApi();
  const upload = byName.get('drive_upload');

  await assert.rejects(
    () => upload.run({ path: '/etc/passwd' }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT' && /Host/.test(err.message)
  );
  await assert.rejects(
    () => upload.run({ path: 'report.pdf', name: 'report.pdf', data: Buffer.from('x').toString('base64') }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => upload.run({ name: '../evil.pdf', data: Buffer.from('x').toString('base64') }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => upload.run({ name: 'report.pdf', data: 'not!base64!' }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  const oversized = Buffer.alloc(DRIVE_UPLOAD_MAX_BYTES + 1, 0x61).toString('base64');
  await assert.rejects(
    () => upload.run({ name: 'huge.bin', data: oversized }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
});

test('rejects forged caller/actor fields, invalid ranges/values, bad emails, and aborted signals', async () => {
  const { byName } = makeRecorder();
  const api = fakeApi();

  await assert.rejects(
    () => byName.get('drive_mkdir').run({ name: 'X', askedBy: 'forged' }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => byName.get('drive_share').run({ ref: '1AbCdefGhIjKlMnOpQrSt', with: ['not-an-email'] }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => byName.get('docs_replace').run({ ref: '1AbCdefGhIjKlMnOpQrSt', pairs: [{ old: 'a', new: 'b' }], old: 'a', new: 'b' }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => byName.get('sheets_read').run({ ref: '1AbCdefGhIjKlMnOpQrSt', range: 'Sheet1!A1:B2' }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => byName.get('sheets_write').run({ ref: '1AbCdefGhIjKlMnOpQrSt', range: 'A1', values: ['flat-row'] }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );
  await assert.rejects(
    () => byName.get('docs_comment').run({ ref: '1AbCdefGhIjKlMnOpQrSt', text: 'x'.repeat(1901) }, { api }),
    (err) => err.code === 'INVALID_ARGUMENT'
  );

  const ac = new AbortController();
  ac.abort(new Error('cancelled'));
  await assert.rejects(
    () => byName.get('drive_search').run({}, { api, signal: ac.signal }),
    /cancelled/
  );
});

test('docs_comment clips long askedBy and avoids duplicating existing attribution line', async () => {
  const { calls, byName } = makeRecorder();
  const api = fakeApi();
  const longAskedBy = 'asked by ' + 'A'.repeat(200) + ' via Bot';
  await byName.get('docs_comment').run({ ref: '1AbCdefGhIjKlMnOpQrSt', text: 'Review note' }, { api, askedBy: longAskedBy });
  const sentText = calls[0][2].text;
  const line = sentText.split('\n\n')[1];
  assert.equal(line.length, ASKED_BY_MAX_CHARS);

  const shortAskedBy = 'asked by Bob via Helper';
  await byName.get('docs_comment').run({ ref: '1AbCdefGhIjKlMnOpQrSt', text: `Already noted\n\n${shortAskedBy}` }, { api, askedBy: shortAskedBy });
  assert.equal(calls[1][2].text, `Already noted\n\n${shortAskedBy}`);
});
