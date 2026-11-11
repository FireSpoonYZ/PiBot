import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readPaste, PAIRING_CODE_PREFIX } from '../../desktop/web/src/pairingCode.ts';
import { encodePairingCode } from '../../center-server/pairing.js';

const secret = () => randomBytes(24).toString('base64url');
const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const encode = payload => PAIRING_CODE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

test('the center and the desktop client agree on the pairing code format', () => {
  // Exactly what the center hands out, with and without a private CA.
  const plain = encodePairingCode({ url: 'https://center.example.com', secret: secret() });
  assert.deepEqual(readPaste(plain), { kind: 'code', centerHost: 'center.example.com' });

  const withCa = encodePairingCode({ url: 'https://192.168.1.10:8443', secret: secret(), ca: PEM });
  assert.deepEqual(readPaste(withCa), { kind: 'code', centerHost: '192.168.1.10:8443' });
});

test('surrounding and wrapped whitespace does not matter', () => {
  const code = encodePairingCode({ url: 'https://center.example.com', secret: secret() });
  assert.equal(readPaste(`\n  ${code}  \r\n`).kind, 'code');
  assert.equal(readPaste(`${code.slice(0, 30)}\n${code.slice(30, 60)}\r\n  ${code.slice(60)}`).kind, 'code');
});

test('tells apart the ways a paste can be wrong', () => {
  assert.equal(readPaste('').kind, 'empty');
  assert.equal(readPaste('  \n ').kind, 'empty');
  assert.equal(readPaste('https://center.example.com').kind, 'not-code');
  assert.equal(readPaste('hunter2').kind, 'not-code');
  assert.equal(readPaste('pibot.abc').kind, 'not-code');
  assert.equal(readPaste('pibotx.abc').kind, 'not-code');
  assert.equal(readPaste('pibot2.abc').kind, 'unsupported');
  assert.equal(readPaste('pibot10.abc').kind, 'unsupported');

  assert.equal(readPaste('pibot1.').kind, 'damaged');
  assert.equal(readPaste('pibot1.!!!not-base64!!!').kind, 'damaged');
  assert.equal(readPaste(PAIRING_CODE_PREFIX + Buffer.from('not json').toString('base64url')).kind, 'damaged');
  // Cut off mid-way, as when only part of the string reaches the clipboard.
  const code = encodePairingCode({ url: 'https://center.example.com', secret: secret() });
  assert.equal(readPaste(code.slice(0, code.length - 10)).kind, 'damaged');
});

test('rejects codes whose fields are unusable', () => {
  const good = { u: 'https://center.example.com', c: secret() };
  assert.equal(readPaste(encode(good)).kind, 'code');
  for (const bad of [
    { c: good.c },
    { u: good.u },
    { u: 5, c: good.c },
    { u: good.u, c: 'short' },
    { u: good.u, c: 'x'.repeat(65) },
    { u: good.u, c: `${good.c.slice(1)}!` },
    { u: good.u, c: good.c, a: 7 },
    { u: 'not a url', c: good.c },
    { u: 'ftp://center.example.com', c: good.c },
    { u: 'javascript:alert(1)', c: good.c },
  ]) {
    assert.equal(readPaste(encode(bad)).kind, 'damaged', JSON.stringify(bad));
  }
  // Unknown extra fields are tolerated, and so is a null or missing CA.
  assert.equal(readPaste(encode({ ...good, future: [1], a: null })).kind, 'code');
});

test('the host shown to the user comes from the code, not from anything the page could guess', () => {
  const shown = payload => readPaste(encode({ c: secret(), ...payload })).centerHost;
  assert.equal(shown({ u: 'https://Center.Example.com:8443/' }), 'center.example.com:8443');
  assert.equal(shown({ u: 'https://center.example.com:443' }), 'center.example.com');
  // A look-alike userinfo trick must not display the part before the @ as the host.
  assert.equal(shown({ u: 'https://good.example.com@evil.example.net' }), 'evil.example.net');
});
