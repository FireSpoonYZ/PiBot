// web/test/bot-browser-real-desktop.test.mjs
// Real local desktop Chrome/Edge acceptance test for Bot Browser service + desktop-provider + transport normalizer.
// Gated strictly behind `PIBOT_TEST_BROWSER_LIVE=1` so default `npm test` never spawns a browser.
// Uses only a random 127.0.0.1 loopback synthetic HTML form, an isolated temporary profile directory,
// legitimate Bot snapshot/act + owner control APIs, and cleans up browser processes & temp dirs in `finally`.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDesktopBrowserProvider } from '../../host-core/bot-browser/desktop-provider.js';
import { createBotBrowserService } from '../../host-core/bot-browser/service.js';
import { normalizeBrowserControl } from '../../host-core/browser-setup-protocol.js';

const LIVE = process.env.PIBOT_TEST_BROWSER_LIVE === '1';

const FORM_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>PiBot Live Takeover Form</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 1280px; height: 800px; overflow: hidden; font-family: sans-serif; background: #fff; color: #111; }
    #appName { position: fixed; left: 64px; top: 80px; width: 512px; height: 64px; font-size: 20px; padding: 8px; border: 2px solid #333; }
    #humanNote { position: fixed; left: 64px; top: 200px; width: 512px; height: 64px; font-size: 20px; padding: 8px; border: 2px solid #333; }
    #policyAgree { position: fixed; left: 64px; top: 320px; width: 48px; height: 48px; }
    #policyLabel { position: fixed; left: 128px; top: 332px; font-size: 18px; }
    #submitBtn { position: fixed; left: 64px; top: 440px; width: 256px; height: 64px; font-size: 20px; cursor: pointer; }
  </style>
</head>
<body>
  <form method="POST" action="/submit" autocomplete="off">
    <input id="appName" name="appName" type="text" aria-label="App Name" autocomplete="off" />
    <input id="humanNote" name="humanNote" type="text" aria-label="Human Note" autocomplete="off" />
    <input id="policyAgree" name="policyAgree" type="checkbox" aria-label="I agree to the Google API Services: User Data Policy" />
    <label id="policyLabel" for="policyAgree">I agree to the Google API Services: User Data Policy</label>
    <button id="submitBtn" type="submit">Finish and Submit</button>
  </form>
</body>
</html>`;

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function startLoopbackFormServer() {
  const submissions = [];
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && reqUrl.pathname === '/form') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(FORM_HTML);
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/links') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<a href="/form" target="_blank" rel="noopener">Open form</a>');
      return;
    }
    if (req.method === 'POST' && reqUrl.pathname === '/submit') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const params = new URLSearchParams(raw);
        const record = {
          appName: params.get('appName') ?? '',
          humanNote: params.get('humanNote') ?? '',
          policyAgree: params.get('policyAgree') ?? '',
        };
        submissions.push(record);
        const target = `/submitted?id=${submissions.length - 1}`;
        res.writeHead(303, { location: target, 'cache-control': 'no-store' });
        res.end();
      });
      return;
    }
    if (req.method === 'GET' && reqUrl.pathname === '/submitted') {
      const idx = Number.parseInt(reqUrl.searchParams.get('id') ?? '0', 10);
      const record = submissions[idx] ?? { appName: '', humanNote: '', policyAgree: '' };
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Submission Confirmed</title></head>
<body>
  <h1>Submission Confirmed</h1>
  <p>App Name: ${escapeHtml(record.appName)}</p>
  <p>Human Note: ${escapeHtml(record.humanNote)}</p>
  <p>Policy Agreed: ${escapeHtml(record.policyAgree)}</p>
</body>
</html>`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind loopback HTTP server'));
        return;
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        submissions,
      });
    });
  });
}

function parseToolJson(result) {
  assert.ok(Array.isArray(result?.output) && result.output[0]?.type === 'text', 'tool result must carry JSON text');
  return JSON.parse(result.output[0].text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, { timeoutMs = 8_000, intervalMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }
  return lastValue;
}

test(
  'real desktop Chrome/Edge: isolated profile, same-page two-client takeover, uncommitted field preservation, lease loss/preemption, and handback',
  { skip: !LIVE },
  async () => {
    const botId = 'bot-real-desktop-1';
    const dataRoot = await mkdtemp(join(tmpdir(), 'pibot-real-browser-'));
    const { server, baseUrl, submissions } = await startLoopbackFormServer();

    let clockNow = Date.now();
    const host = {
      deviceId: 'dev-real-desktop-test',
      dataRoot,
      getBot(id) {
        if (id !== botId) return null;
        return {
          botId,
          deviceId: 'dev-real-desktop-test',
          primaryConversationId: 'conv-real-desktop-1',
        };
      },
      listBots() {
        return [this.getBot(botId)];
      },
    };

    const clientA = {
      role: 'owner',
      clientId: 'desktop-client-a',
      holderLabel: 'Desktop-A',
      authenticated: true,
    };
    const clientB = {
      role: 'owner',
      clientId: 'mobile-client-b',
      holderLabel: 'Mobile-B',
      authenticated: true,
    };

    // Exercises the real default `./desktop-provider.js` loader inside createBotBrowserService.
    const service = createBotBrowserService({
      host,
      resolveConversationBot: async (convId) => {
        if (convId === 1001) return botId;
        throw Object.assign(new Error('not owned'), { code: 'BOT_CONTEXT_REQUIRED' });
      },
      now: () => clockNow,
      leaseTtlMs: 10_000,
    });

    // Helper: every control call passes through the real transport normalizer first.
    const controlViaTransport = (rawInput, authority) =>
      service.control(normalizeBrowserControl(rawInput), authority);

    try {
      // 1. Honest availability probe (no browser spawned yet).
      const initialStatus = await controlViaTransport({ action: 'status', botId }, clientA);
      assert.equal(
        initialStatus.available,
        true,
        `Real desktop Chrome/Edge must be installed for PIBOT_TEST_BROWSER_LIVE=1 (reason: ${initialStatus.reason ?? 'unknown'})`
      );
      assert.equal(initialStatus.canStreamInteract, true);
      assert.equal(initialStatus.phase, 'bot');

      // 2. Bot opens the synthetic loopback form in its isolated temporary profile.
      const [botTool] = service.toolsForBot({ botId });
      const openedRes = await botTool.execute(
        { action: 'open', url: `${baseUrl}/form` },
        { conversationId: 1001 },
        {}
      );
      assert.notEqual(openedRes.isError, true, `Bot open failed: ${openedRes.output?.[0]?.text}`);
      const opened = parseToolJson(openedRes);
      const pageId = opened.pageId;
      assert.ok(pageId, 'open must return an owned pageId');

      // Verify isolated per-bot profile directory was created inside dataRoot.
      const isolatedProfileStat = await stat(join(dataRoot, 'bot-browser', 'profiles', botId));
      assert.equal(isolatedProfileStat.isDirectory(), true);

      // 3. Bot inspects page via restricted snapshot, fills App Name, and is stopped BEFORE Policy checkbox.
      const snapRes = await botTool.execute(
        { action: 'snapshot', snapshot: { interactive: true } },
        { conversationId: 1001 },
        {}
      );
      assert.notEqual(snapRes.isError, true, `Bot snapshot failed: ${snapRes.output?.[0]?.text}`);
      const snap = parseToolJson(snapRes);
      const appNameMatch = /\[(e\d+)\]\s+textbox\s+"App Name"/i.exec(snap.snapshot);
      const policyMatch = /\[(e\d+)\]\s+checkbox\s+"[^"]*User Data Policy[^"]*"/i.exec(snap.snapshot);
      assert.ok(appNameMatch, `Expected App Name textbox ref in snapshot:\n${snap.snapshot}`);
      assert.ok(policyMatch, `Expected User Data Policy checkbox ref in snapshot:\n${snap.snapshot}`);

      const fillRes = await botTool.execute(
        { action: 'act', act: { kind: 'fill', ref: appNameMatch[1], value: 'PiBot-Cloud-App' } },
        { conversationId: 1001 },
        {}
      );
      assert.notEqual(fillRes.isError, true, `Bot fill failed: ${fillRes.output?.[0]?.text}`);

      // Policy checkbox must be blocked BEFORE clicking and hold the session for human takeover.
      const policyClickRes = await botTool.execute(
        { action: 'act', act: { kind: 'click', ref: policyMatch[1] } },
        { conversationId: 1001 },
        {}
      );
      assert.equal(policyClickRes.isError, true);
      const policyErr = parseToolJson(policyClickRes);
      assert.equal(policyErr.code, 'BROWSER_SENSITIVE_BLOCKED');
      assert.equal(policyErr.status, 'PAUSED_FOR_HUMAN');

      // 4. Client A takes over the EXACT same page (uncommitted App Name field stays in DOM).
      const preTakeoverStatus = await controlViaTransport({ action: 'status', botId }, clientA);
      assert.equal(preTakeoverStatus.phase, 'held');
      assert.equal(preTakeoverStatus.attentionRequested, true);

      const takenA = await controlViaTransport(
        { action: 'takeover', botId, pageId, revision: preTakeoverStatus.revision },
        clientA
      );
      assert.equal(takenA.phase, 'human');
      assert.equal(takenA.pageId, pageId);
      assert.equal(takenA.tabs.length, 1);
      assert.equal(takenA.isHolder, true);
      assert.equal(takenA.holderLabel, 'Desktop-A');
      assert.equal(typeof takenA.lease, 'string');

      // Bot tool remains hard-blocked during human control.
      const botBlockedDuringHuman = await botTool.execute({ action: 'snapshot' }, { conversationId: 1001 }, {});
      assert.equal(botBlockedDuringHuman.isError, true);
      assert.equal(parseToolJson(botBlockedDuringHuman).status, 'PAUSED_FOR_HUMAN');

      // Client A fetches a real bounded frame from headless Chrome/Edge.
      const frameA = await controlViaTransport(
        { action: 'frame', botId, pageId, lease: takenA.lease, revision: takenA.revision },
        clientA
      );
      assert.equal(frameA.pageId, pageId);
      assert.equal(frameA.revision, takenA.revision);
      assert.ok(frameA.mimeType === 'image/jpeg' || frameA.mimeType === 'image/png');
      assert.equal(frameA.width, 1280);
      assert.equal(frameA.height, 800);
      assert.ok(frameA.data.length > 100 && frameA.data.length <= 737280);

      // Client A clicks #humanNote at relative (0.25, 0.29) and types text directly into the live DOM.
      const clickNote = await controlViaTransport(
        {
          action: 'input',
          botId,
          pageId,
          lease: takenA.lease,
          revision: takenA.revision,
          frameSeq: frameA.seq,
          event: { kind: 'click', x: 0.25, y: 0.29 },
        },
        clientA
      );
      assert.equal(clickNote.ok, true);

      const typeNote = await controlViaTransport(
        {
          action: 'input',
          botId,
          pageId,
          lease: takenA.lease,
          revision: clickNote.revision,
          event: { kind: 'text', text: 'ApprovedByClientA' },
        },
        clientA
      );
      assert.equal(typeNote.ok, true);

      // Stale revision must be rejected without dispatching input.
      await assert.rejects(
        () => controlViaTransport(
          {
            action: 'input',
            botId,
            pageId,
            lease: takenA.lease,
            revision: Math.max(0, typeNote.revision - 1),
            event: { kind: 'text', text: 'ShouldNotType' },
          },
          clientA
        ),
        { code: 'BROWSER_STALE_REVISION' }
      );

      // 5. Client B observes read-only (no lease token), cannot steal without force, then explicitly preempts.
      const statusB = await controlViaTransport({ action: 'status', botId }, clientB);
      assert.equal(statusB.phase, 'human');
      assert.equal(statusB.holderLabel, 'Desktop-A');
      assert.equal(statusB.isHolder, false);
      assert.equal(statusB.lease, undefined);

      await assert.rejects(
        () => controlViaTransport({ action: 'takeover', botId, pageId }, clientB),
        { code: 'BROWSER_LEASE_CONFLICT' }
      );

      const takenB = await controlViaTransport(
        { action: 'takeover', botId, pageId, force: true },
        clientB
      );
      assert.equal(takenB.phase, 'human');
      assert.equal(takenB.pageId, pageId);
      assert.equal(takenB.holderLabel, 'Mobile-B');
      assert.equal(takenB.isHolder, true);
      assert.notEqual(takenB.lease, takenA.lease);
      assert.ok(takenB.revision > takenA.revision);

      // Client A's superseded lease is IMMEDIATELY rejected (even if Client A passes the latest revision).
      await assert.rejects(
        () => controlViaTransport(
          {
            action: 'input',
            botId,
            pageId,
            lease: takenA.lease,
            revision: takenB.revision,
            event: { kind: 'text', text: 'StaleHolderText' },
          },
          clientA
        ),
        { code: 'BROWSER_LEASE_CONFLICT' }
      );

      // 6. Lease expiry / disconnect fails closed into 'held' (never auto-returns to Bot), and old lease is rejected.
      clockNow += 15_000;
      const heldAfterDisconnect = await controlViaTransport({ action: 'status', botId }, clientB);
      assert.equal(heldAfterDisconnect.phase, 'held');
      assert.equal(heldAfterDisconnect.reason, 'disconnected_hold');

      const botStillBlockedWhileHeld = await botTool.execute({ action: 'snapshot' }, { conversationId: 1001 }, {});
      assert.equal(botStillBlockedWhileHeld.isError, true);
      assert.equal(parseToolJson(botStillBlockedWhileHeld).status, 'PAUSED_FOR_HUMAN');

      await assert.rejects(
        () => controlViaTransport(
          {
            action: 'input',
            botId,
            pageId,
            lease: takenB.lease,
            revision: heldAfterDisconnect.revision,
            event: { kind: 'click', x: 0.06875, y: 0.43 },
          },
          clientB
        ),
        { code: 'BROWSER_LEASE_EXPIRED' }
      );

      // Client B explicitly resumes takeover on the SAME page with a fresh lease token.
      const resumedB = await controlViaTransport(
        { action: 'takeover', botId, pageId, resume: true },
        clientB
      );
      assert.equal(resumedB.phase, 'human');
      assert.equal(resumedB.pageId, pageId);
      assert.notEqual(resumedB.lease, takenB.lease);

      // 7. Client B ticks #policyAgree (0.06875, 0.43) and clicks #submitBtn (0.15, 0.59) on the SAME form.
      const checkPolicy = await controlViaTransport(
        {
          action: 'input',
          botId,
          pageId,
          lease: resumedB.lease,
          revision: resumedB.revision,
          event: { kind: 'click', x: 0.06875, y: 0.43 },
        },
        clientB
      );
      assert.equal(checkPolicy.ok, true);

      const clickSubmit = await controlViaTransport(
        {
          action: 'input',
          botId,
          pageId,
          lease: resumedB.lease,
          revision: checkPolicy.revision,
          event: { kind: 'click', x: 0.15, y: 0.59 },
        },
        clientB
      );
      assert.equal(clickSubmit.ok, true);

      // Wait for real browser POST /submit -> 303 /submitted navigation to settle.
      const landedView = await waitForCondition(async () => {
        if (submissions.length === 0) return null;
        const st = await controlViaTransport({ action: 'status', botId, lease: resumedB.lease }, clientB);
        const tabUrl = st.tabs.find((t) => t.id === pageId)?.url ?? '';
        return tabUrl.includes('/submitted') ? st : null;
      });
      assert.ok(landedView, 'Expected form submission to navigate to /submitted');
      assert.equal(submissions.length, 1);
      assert.deepEqual(submissions[0], {
        appName: 'PiBot-Cloud-App',
        humanNote: 'ApprovedByClientA',
        policyAgree: 'on',
      });

      // 8. Client B hands control back to Bot; old lease is rejected and Bot observes result via restricted snapshot.
      const handedBack = await controlViaTransport(
        {
          action: 'handback',
          botId,
          pageId,
          lease: resumedB.lease,
          revision: landedView.revision,
        },
        clientB
      );
      assert.equal(handedBack.phase, 'bot');
      assert.equal(handedBack.lease, undefined);

      await assert.rejects(
        () => controlViaTransport(
          {
            action: 'input',
            botId,
            pageId,
            lease: resumedB.lease,
            revision: handedBack.revision,
            event: { kind: 'click', x: 0.5, y: 0.5 },
          },
          clientB
        ),
        { code: 'BROWSER_TAKEOVER_REQUIRED' }
      );

      const postHandbackSnapRes = await botTool.execute(
        { action: 'snapshot' },
        { conversationId: 1001 },
        {}
      );
      assert.notEqual(postHandbackSnapRes.isError, true, `Post-handback snapshot failed: ${postHandbackSnapRes.output?.[0]?.text}`);
      const postHandbackSnap = parseToolJson(postHandbackSnapRes);
      assert.ok(postHandbackSnap.url.includes('/submitted'));
      assert.ok(postHandbackSnap.snapshot.includes('Submission Confirmed'));
      assert.ok(postHandbackSnap.snapshot.includes('PiBot-Cloud-App'));
      assert.ok(postHandbackSnap.snapshot.includes('ApprovedByClientA'));
    } finally {
      await service.close().catch(() => {});
      await new Promise((resolve) => server.close(() => resolve()));
      await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
);

test('real desktop: follow a web-opened tab and wait for actual page conditions', { skip: !LIVE }, async (t) => {
  const { server, baseUrl } = await startLoopbackFormServer();
  const profileDir = await mkdtemp(join(tmpdir(), 'pibot-popup-wait-'));
  const provider = await createDesktopBrowserProvider({ botId: 'popup-bot', profileDir, maxTabs: 2 });
  t.after(async () => {
    try { await provider.close(); }
    finally {
      await new Promise(resolve => server.close(resolve));
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  const main = await provider.perform({ action: 'open', url: baseUrl + '/links' });
  const snapshot = await provider.perform({ action: 'snapshot', pageId: main.pageId });
  const link = snapshot.refs.find(el => el.role === 'link' && el.name === 'Open form');
  assert.ok(link);
  await provider.perform({ action: 'act', pageId: main.pageId, command: { kind: 'click', ref: link.ref } });
  const popup = await waitForCondition(async () => {
    const status = await provider.perform({ action: 'status' });
    assert.equal(status.pageId, main.pageId);
    return status.tabs.find(tab => tab.id !== main.pageId && tab.url === baseUrl + '/form');
  });
  assert.ok(popup, 'the opened form must appear in the tab list');
  await provider.perform({ action: 'select', pageId: popup.id });
  const wait = command => provider.perform({ action: 'act', pageId: popup.id, command: { kind: 'wait', ...command } });
  assert.equal((await wait({ selector: '#humanNote', url: baseUrl + '/form', text: 'Finish and Submit',
    load: 'load', timeoutMs: 2000 })).ok, true);
  await assert.rejects(wait({ selector: '#absent', timeoutMs: 100 }), { code: 'BROWSER_TIMEOUT' });
  await assert.rejects(wait({ url: baseUrl + '/other', timeoutMs: 100 }), { code: 'BROWSER_TIMEOUT' });
  const result = await provider.perform({ action: 'closeTab', pageId: popup.id });
  assert.equal(result.pageId, main.pageId);
  assert.equal(result.tabs.length, 1);
});
