import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyGoogleSetupPageSensitivity,
  createGoogleSetupService,
  deriveCenterBrandingLinks,
  evaluateModeAvailability,
} from '../../host-core/google-setup/service.js';
import {
  googleConsoleApiIds,
  googleConsoleStepUrl,
  googleSignInScopes,
} from '../../host-core/google-setup/console.js';
import {
  GOOGLE_SETUP_PAUSED_AFTER_MS,
  googleSetupActionsLine,
  googleSetupBlocker,
} from '../../host-core/google-setup/blocker.js';
import { sanitizePersistedRun } from '../../host-core/google-setup/store.js';

const OWNER = Object.freeze({ actor: 'owner', trustedOwner: true });

function makeEnv(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pibot-google-setup-test-'));
  let clock = overrides.startTime ?? 10_000;
  let centerStatus =
    overrides.centerStatus !== undefined
      ? overrides.centerStatus
      : {
          reachable: true,
          isAdmin: true,
          publicUrl: 'https://center.example.com',
          client: {
            configured: false,
            redirectUri: 'https://center.example.com/api/oauth/google/callback',
          },
          accounts: [],
        };
  let centerError = overrides.centerError ?? null;
  const locks = [];
  const unlocks = [];
  const events = [];
  const bots = new Map([
    ['bot-a', { botId: 'bot-a', deviceId: 'dev-1', archivedAt: null }],
    ['bot-b', { botId: 'bot-b', deviceId: 'dev-1', archivedAt: null }],
    ['bot-archived', { botId: 'bot-archived', deviceId: 'dev-1', archivedAt: 123 }],
  ]);

  const service = createGoogleSetupService({
    dataRoot: dir,
    host: {
      deviceId: 'dev-1',
      getBot: (id) => bots.get(id) ?? null,
      listBots: () => [...bots.values()],
    },
    resolveBotIdentity: async (api) => ({
      deviceId: 'dev-1',
      botId: api.verifiedBotId ?? 'bot-a',
      conversationId: 'conv-1',
      scopeId: null,
      kind: 'primary',
    }),
    getCenterGoogleStatus: async () => {
      if (centerError) throw centerError;
      return centerStatus;
    },
    platformCapabilities: overrides.platformCapabilities ?? {
      browserAvailable: true,
      canStreamInteract: true,
      canIsolateSensitivePages: true,
      isAndroidLocalHost: false,
      isHeadless: false,
    },
    browserLock: async (payload) => {
      locks.push(payload);
      return { locked: true };
    },
    browserUnlock: async (payload) => {
      unlocks.push(payload);
    },
    isBotTurnRunning: overrides.isBotTurnRunning ?? (() => true),
    onEvent: (event) => {
      events.push(event);
    },
    now: () => (clock += 100),
    ...overrides.serviceOptions,
  });

  const [tool] = service.toolsForBot();
  async function callBot(args, verifiedBotId = 'bot-a') {
    const res = await tool.execute(args, { verifiedBotId, conversationId: 1 }, {});
    const body = JSON.parse(res.output[0].text);
    return { isError: res.isError === true, body };
  }

  return {
    dir,
    service,
    callBot,
    locks,
    unlocks,
    events,
    setCenterStatus: (next) => {
      centerError = null;
      centerStatus = next;
    },
    setCenterError: (err) => {
      centerError = err;
    },
    advanceClock: (ms) => {
      clock += ms;
    },
    cleanup: async () => {
      await service.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function readyServices(overrides = {}) {
  return ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'].map((service) => ({
    service,
    state: overrides[service] ?? 'ready',
  }));
}

test('three-mode availability matrix degrades honestly on headless and Android local Host', async () => {
  const desktop = evaluateModeAvailability({
    browserAvailable: true,
    canStreamInteract: true,
    canIsolateSensitivePages: true,
  });
  assert.equal(desktop.modes['do-it-for-me'].available, true);
  assert.equal(desktop.modes['guide-here'].available, true);
  assert.equal(desktop.modes['guide-browser'].available, true);
  assert.equal(desktop.clientStepRequiresSystemBrowser, false);

  const noIsolation = evaluateModeAvailability({
    browserAvailable: true,
    canStreamInteract: true,
    canIsolateSensitivePages: false,
  });
  assert.equal(noIsolation.modes['do-it-for-me'].available, true);
  assert.equal(noIsolation.clientStepRequiresSystemBrowser, true);

  const androidEnv = makeEnv({
    platformCapabilities: {
      browserAvailable: false,
      canStreamInteract: false,
      canIsolateSensitivePages: false,
      isAndroidLocalHost: true,
    },
  });
  try {
    const status = await androidEnv.service.control({ botId: 'bot-a', action: 'status' }, OWNER);
    assert.equal(status.modeAvailability.recommendedMode, 'guide-browser');
    assert.equal(status.modeAvailability.modes['do-it-for-me'].available, false);
    assert.equal(status.modeAvailability.modes['guide-here'].available, false);
    assert.equal(status.modeAvailability.modes['guide-browser'].available, true);

    await assert.rejects(
      () => androidEnv.service.control({ botId: 'bot-a', action: 'start', mode: 'do-it-for-me' }, OWNER),
      (err) => err.code === 'SETUP_MODE_UNAVAILABLE' && err.fallbackMode === 'guide-browser',
    );
    const started = await androidEnv.service.control(
      { botId: 'bot-a', action: 'start', mode: 'guide-browser' },
      OWNER,
    );
    assert.equal(started.mode, 'guide-browser');
  } finally {
    await androidEnv.cleanup();
  }
});

test('confirming services opens one embedded account tab and owner resume restores a closed tab', async () => {
  const openedUrls = [];
  let tabs = [];
  let failOpen = false;
  const env = makeEnv({
    serviceOptions: {
      async browserControl({ action, url }) {
        if (action === 'status') return { available: true, canStreamInteract: true, tabs };
        assert.equal(action, 'open');
        openedUrls.push(url);
        if (failOpen) throw new Error('simulated startup failure');
        const pageId = `page-${openedUrls.length}`;
        tabs = [...tabs, { id: pageId }];
        return { pageId };
      },
    },
  });
  try {
    const control = (input) => env.service.control({ botId: 'bot-a', ...input }, OWNER);
    const started = await control({ action: 'start' });
    const mode = await control({ action: 'answer', card: 'path', values: ['guide-here'], runId: started.id });
    assert.equal(mode.card.card, 'services');
    assert.deepEqual(openedUrls, []);

    const account = await control({ action: 'answer', card: 'services', values: ['gmail'], runId: mode.id });
    assert.equal(account.step, 'account');
    assert.equal(account.browserPageId, 'page-1');
    assert.equal(env.events.find(event => event.type === 'owner-answer' && event.card === 'services').view.browserPageId, 'page-1');
    assert.equal((await control({ action: 'status' })).browserPageId, 'page-1');
    assert.equal((await control({ action: 'resume', runId: account.id })).browserPageId, 'page-1');
    assert.deepEqual(openedUrls, [googleConsoleStepUrl('account')]);

    tabs = [];
    const stale = await control({ action: 'resume', runId: 'older-run' });
    assert.equal(stale.staleReason, 'STALE_RUN');
    assert.equal(openedUrls.length, 1);

    failOpen = true;
    const failed = await control({ action: 'resume', runId: account.id });
    assert.equal(failed.state, 'running');
    assert.equal(failed.browserPageId, undefined);
    failOpen = false;
    const recovered = await control({ action: 'resume', runId: account.id, expectedRevision: failed.revision });
    assert.equal(recovered.browserPageId, 'page-3');
    await control({ botId: 'bot-b', action: 'start', mode: 'guide-browser', choices: ['gmail'] });
    assert.deepEqual(openedUrls, Array(3).fill(googleConsoleStepUrl('account')));
  } finally {
    await env.cleanup();
  }
});

test('embedded project confirmation reads the Cloud welcome page and tolerates a concurrent progress update', async () => {
  const projectId = 'project-12345678-1234-5678-abc';
  let setupUrl = `https://console.cloud.google.com/projectcreate?project=${projectId}`;
  const env = makeEnv({
    serviceOptions: {
      async browserControl({ action }) {
        assert.equal(action, 'status');
        return {
          available: true,
          canStreamInteract: true,
          pageId: 'other-tab',
          tabs: [
            { id: 'setup-tab', url: setupUrl },
            { id: 'other-tab', url: 'https://console.cloud.google.com/home/dashboard?project=other-project' },
          ],
        };
      },
    },
  });
  try {
    const control = (input) => env.service.control({ botId: 'bot-a', ...input }, OWNER);
    const started = await control({
      action: 'start', mode: 'guide-here', choices: ['gmail'], browserPageId: 'setup-tab',
    });
    const project = await control({ action: 'advance', step: 'account', account: 'owner@gmail.com' });
    const confirm = {
      action: 'advance', step: 'project', runId: started.id, expectedRevision: project.revision,
    };

    await assert.rejects(() => control(confirm), { code: 'SETUP_PROJECT_ID_REQUIRED' });
    assert.equal((await control({ action: 'status' })).step, 'project');

    const updated = await env.callBot({ action: 'step', step: 'project', status: 'active' });
    assert.equal(updated.isError, false);
    assert.ok(updated.body.view.revision > project.revision);
    setupUrl = `https://console.cloud.google.com/welcome?project=${projectId}`;
    await assert.rejects(() => control({ ...confirm, kind: 'work' }), { code: 'SETUP_REVISION_CONFLICT' });

    const next = await control(confirm);
    assert.equal(next.step, 'apis');
    assert.equal(next.projectId, projectId);
    assert.equal(new URL(next.guidance.consoleUrl).searchParams.get('project'), projectId);
    assert.equal((await control(confirm)).revision, next.revision);
    assert.equal((await control({ ...confirm, runId: 'older-run' })).staleReason, 'STALE_RUN');
  } finally {
    await env.cleanup();
  }
});

test('the external project step needs a supplied ID only when the run has none', async () => {
  const env = makeEnv({
    serviceOptions: {
      async browserControl() {
        return {
          available: true,
          canStreamInteract: true,
          pageId: 'embedded-tab',
          tabs: [{ id: 'embedded-tab', url: 'https://console.cloud.google.com/home/dashboard?project=embedded-project' }],
        };
      },
    },
  });
  try {
    const control = (input) => env.service.control({ botId: 'bot-a', ...input }, OWNER);
    const started = await control({ action: 'start', mode: 'guide-browser', choices: ['gmail'] });
    const project = await control({ action: 'advance', step: 'account', account: 'owner@gmail.com' });
    const confirm = {
      action: 'advance', step: 'project', runId: started.id, expectedRevision: project.revision,
    };
    await assert.rejects(() => control(confirm), { code: 'SETUP_PROJECT_ID_REQUIRED' });

    const next = await control({ ...confirm, projectId: 'pibot-center' });
    assert.equal(next.step, 'apis');
    assert.equal(next.projectId, 'pibot-center');

    const restarted = await control({ action: 'start', restart: true, mode: 'guide-browser', choices: ['gmail'] });
    await control({ action: 'advance', step: 'account', account: 'owner@gmail.com' });
    const saved = await env.callBot({ action: 'set', projectId: 'known-project' });
    assert.equal(saved.isError, false);
    const reused = await control({ ...confirm, runId: restarted.id, expectedRevision: saved.body.view.revision });
    assert.equal(reused.step, 'apis');
    assert.equal(reused.projectId, 'known-project');
  } finally {
    await env.cleanup();
  }
});

test('branding asks for the audience on the same setup card after the Bot stops', async () => {
  const env = makeEnv({ isBotTurnRunning: () => false });
  try {
    const control = (input) => env.service.control({ botId: 'bot-a', ...input }, OWNER);
    const run = await control({ action: 'start', mode: 'do-it-for-me', choices: ['gmail'] });
    await control({ action: 'advance', step: 'account', account: 'owner@example.com' });
    await control({ action: 'advance', step: 'project', projectId: 'existing-cloud-project' });
    const branding = await control({ action: 'advance', step: 'apis' });
    assert.equal(branding.step, 'branding');
    assert.equal(branding.card.card, 'kind');
    assert.deepEqual(new Set(branding.card.options.map(({ id }) => id)), new Set(['personal', 'work']));

    env.advanceClock(GOOGLE_SETUP_PAUSED_AFTER_MS + 100);
    const waiting = await control({ action: 'status' });
    assert.equal(waiting.id, run.id);
    assert.equal(waiting.card.card, 'kind');
    assert.equal(waiting.blocker, null);
    assert.equal(waiting.guidance.phase, 'awaiting-kind');

    const answer = { action: 'answer', card: 'kind', values: ['work'], runId: run.id,
      expectedRevision: waiting.revision, cardCopy: waiting.card.copy };
    const selected = await control(answer);
    assert.equal(selected.kind, 'work');
    assert.equal(selected.id, run.id);
    assert.equal(selected.projectId, 'existing-cloud-project');
    assert.equal(selected.steps.apis.status, 'done');
    assert.equal(selected.step, 'branding');
    assert.equal(selected.steps.links.status, 'skipped');
    assert.equal(selected.steps.publish.status, 'skipped');
    assert.equal(selected.guidance.phase, 'active-step');
    assert.equal((await control(answer)).applied, false);
  } finally {
    await env.cleanup();
  }
});

test('Center Web OAuth links never use Orca domains and preserve People base scopes', () => {
  const valid = deriveCenterBrandingLinks('https://center.acme.example/subpath');
  assert.deepEqual(valid, {
    origin: 'https://center.acme.example',
    isHttps: true,
    homePage: 'https://center.acme.example',
    privacyPolicy: 'https://center.acme.example/privacy',
    authorizedDomain: 'center.acme.example',
    redirectUri: 'https://center.acme.example/api/oauth/google/callback',
  });
  assert.equal(deriveCenterBrandingLinks('https://www.onorca.dev'), null);
  assert.equal(deriveCenterBrandingLinks('https://onorca.dev'), null);
  assert.deepEqual(googleConsoleApiIds(['gmail', 'files']), [
    'people.googleapis.com',
    'gmail.googleapis.com',
    'drive.googleapis.com',
    'docs.googleapis.com',
    'sheets.googleapis.com',
  ]);
  const scopes = googleSignInScopes(['calendar']);
  assert.ok(scopes.includes('https://www.googleapis.com/auth/contacts.readonly'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.ok(!scopes.includes('https://www.googleapis.com/auth/gmail.modify'));

  const url = googleConsoleStepUrl('client', {
    choices: ['gmail'],
    projectId: 'pibot-center-1',
    account: 'admin@acme.example',
  });
  assert.equal(
    url,
    'https://console.cloud.google.com/auth/clients/create?project=pibot-center-1&authuser=admin%40acme.example',
  );
});

test('owner/bot privilege separation and work vs personal step branching', async () => {
  const env = makeEnv();
  try {
    // Missing or bot authority cannot call owner control().
    await assert.rejects(
      () => env.service.control({ botId: 'bot-a', action: 'status' }, { actor: 'bot' }),
      (err) => err.code === 'SETUP_FORBIDDEN',
    );
    await assert.rejects(
      () => env.service.control({ botId: 'bot-a', action: 'status' }, null),
      (err) => err.code === 'SETUP_FORBIDDEN',
    );

    // Bot cannot start directly in do-it-for-me.
    const badStart = await env.callBot({ action: 'start', mode: 'do-it-for-me' });
    assert.equal(badStart.isError, true);
    assert.equal(badStart.body.code, 'SETUP_FORBIDDEN');

    const started = await env.callBot({ action: 'start' });
    assert.equal(started.isError, false);
    assert.equal(started.body.view.mode, 'unchosen');
    assert.equal(started.body.view.card.card, 'path');

    // Bot cannot escalate itself to do-it-for-me via record_typed_answer.
    const escalate = await env.callBot({
      action: 'record_typed_answer',
      card: 'path',
      values: ['do-it-for-me'],
    });
    assert.equal(escalate.isError, true);
    assert.equal(escalate.body.code, 'SETUP_FORBIDDEN');

    // Owner picks do-it-for-me and selects Gmail + Calendar.
    await env.service.control(
      { botId: 'bot-a', action: 'answer', card: 'path', values: ['do-it-for-me'] },
      OWNER,
    );
    await env.service.control(
      { botId: 'bot-a', action: 'answer', card: 'services', values: ['gmail', 'calendar'] },
      OWNER,
    );

    // Custom domain does not auto-assume Workspace Internal; setting kind=work skips links & publish.
    const setAcc = await env.callBot({ action: 'set', account: 'alice@acme.example' });
    assert.equal(setAcc.body.view.kind, undefined);
    const setWork = await env.callBot({ action: 'set', kind: 'work' });
    assert.equal(setWork.body.view.steps.links.status, 'skipped');
    assert.equal(setWork.body.view.steps.publish.status, 'skipped');

    // Switching to personal restores links & publish.
    const setPersonal = await env.callBot({ action: 'set', kind: 'personal' });
    assert.equal(setPersonal.body.view.steps.links, undefined);
    assert.equal(setPersonal.body.view.steps.publish, undefined);
  } finally {
    await env.cleanup();
  }
});

test('sensitive steps lock bot browser before consent/secret and refuse unverified completion', async () => {
  const env = makeEnv();
  try {
    await env.service.control(
      { botId: 'bot-a', action: 'start', mode: 'do-it-for-me', choices: ['gmail', 'files'] },
      OWNER,
    );
    await env.callBot({ action: 'set', account: 'alice@gmail.com', projectId: 'pibot-prod-01', browserPageId: 'page-7' });
    await env.callBot({ action: 'step', step: 'account', status: 'done' });
    await env.callBot({ action: 'step', step: 'project', status: 'done' });
    await env.callBot({ action: 'step', step: 'apis', status: 'done' });

    // Policy checkbox in branding triggers sensitive lock.
    const handed = await env.callBot({
      action: 'need_user',
      step: 'branding',
      note: 'Tick the Google API Services: User Data Policy checkbox and submit.',
    });
    assert.equal(handed.isError, false);
    assert.equal(handed.body.view.browserLock.active, true);
    assert.equal(handed.body.view.browserLock.reason, 'policy-consent');
    assert.equal(env.locks.at(-1).reason, 'policy-consent');

    const policyDuringLock = await env.service.getAgentBrowserPolicy('bot-a');
    assert.equal(policyDuringLock.allowed, false);
    assert.equal(policyDuringLock.mode, 'locked-sensitive');

    // Bot cannot bypass sensitive lock to mark branding done.
    const bypassBranding = await env.callBot({ action: 'step', step: 'branding', status: 'done' });
    assert.equal(bypassBranding.isError, true);
    assert.equal(bypassBranding.body.code, 'SETUP_SENSITIVE_LOCKED');

    // Owner finishes branding -> lock releases.
    const brandingDone = await env.service.control(
      { botId: 'bot-a', action: 'answer', card: 'step', values: ['done', 'branding'] },
      OWNER,
    );
    assert.equal(brandingDone.steps.branding.status, 'done');
    assert.equal(brandingDone.browserLock, undefined);

    await env.callBot({ action: 'step', step: 'links', status: 'done' });
    await env.callBot({ action: 'step', step: 'publish', status: 'done' });

    env.setCenterStatus({
      reachable: true, isAdmin: true,
      client: { configured: false, supportsAutoConfigure: true, redirectUri: 'https://center.example.com/api/oauth/google/callback' },
      accounts: [],
    });
    // Desktop auto-creation still locks the Bot browser before any Client Secret dialog.
    const clientActive = await env.callBot({ action: 'step', step: 'client', status: 'active' });
    assert.equal(clientActive.isError, false);
    assert.equal(clientActive.body.view.browserLock.active, true);
    assert.equal(clientActive.body.view.browserLock.reason, 'oauth-client-secret');
    assert.match(clientActive.body.view.guidance.nextAction, /creates the Web OAuth client and imports it into Center automatically/);
    assert.equal((await env.service.getAgentBrowserPolicy('bot-a')).allowed, false);

    // Sensitive URL classifier blocks accounts.google.com and /auth/clients.
    assert.equal(
      classifyGoogleSetupPageSensitivity('https://accounts.google.com/v3/signin').sensitive,
      true,
    );
    assert.equal(
      classifyGoogleSetupPageSensitivity('https://console.cloud.google.com/auth/clients/create').sensitive,
      true,
    );

    // Bot cannot mark client done until Center confirms client.configured === true.
    const prematureClient = await env.callBot({ action: 'step', step: 'client', status: 'done' });
    assert.equal(prematureClient.isError, true);
    assert.equal(prematureClient.body.code, 'SETUP_NOT_READY');

    // Center confirms Web OAuth client configured for this project.
    env.setCenterStatus({
      reachable: true,
      isAdmin: true,
      publicUrl: 'https://center.example.com',
      client: {
        configured: true,
        clientId: '123.apps.googleusercontent.com',
        projectId: 'pibot-prod-01',
        redirectUri: 'https://center.example.com/api/oauth/google/callback',
      },
      accounts: [],
    });

    const verifiedClient = await env.service.control(
      { botId: 'bot-a', action: 'advance', step: 'client' },
      OWNER,
    );
    assert.equal(verifiedClient.steps.client.status, 'done');
    assert.equal(verifiedClient.step, 'connect');

    // Bot cannot mark connect done from chat text without Center account + readiness.
    const fakeDone = await env.callBot({ action: 'done' });
    assert.equal(fakeDone.isError, true);
    assert.equal(fakeDone.body.code, 'SETUP_NOT_READY');

    // Center shows partial consent: Gmail ready, Drive needs-permission.
    env.setCenterStatus({
      reachable: true,
      isAdmin: true,
      publicUrl: 'https://center.example.com',
      client: {
        configured: true,
        clientId: '123.apps.googleusercontent.com',
        projectId: 'pibot-prod-01',
        redirectUri: 'https://center.example.com/api/oauth/google/callback',
      },
      accounts: [
        {
          id: 'acc-1',
          email: 'alice@gmail.com',
          status: 'connected',
          connectedAt: 50_000,
          choices: ['gmail'],
          services: readyServices({ drive: 'needs-permission' }),
        },
      ],
    });

    const partial = await env.callBot({ action: 'done' });
    assert.equal(partial.isError, true);
    assert.equal(partial.body.code, 'SETUP_NOT_READY');

    const statusPartial = await env.service.control({ botId: 'bot-a', action: 'status' }, OWNER);
    assert.equal(statusPartial.blocker.kind, 'needs-permission');
    assert.deepEqual(statusPartial.blocker.services, ['files']);
    assert.equal(
      googleSetupActionsLine(statusPartial.blocker),
      'Allow Drive, Docs and Sheets · Continue without them',
    );

    // Owner clicks Continue without them -> drops files -> Center confirms Gmail ready -> setup done!
    const finished = await env.service.control(
      { botId: 'bot-a', action: 'answer', card: 'step', values: ['continue-without', 'files'] },
      OWNER,
    );
    assert.equal(finished.state, 'done');
    assert.deepEqual(finished.choices, ['gmail']);
    assert.equal(finished.card.card, 'connected');
  } finally {
    await env.cleanup();
  }
});

test('transient Center outage surfaces center-unreachable instead of signed-out, and paused/recovery flows work', async () => {
  const env = makeEnv({ isBotTurnRunning: () => false });
  try {
    await env.service.control(
      { botId: 'bot-a', action: 'start', mode: 'do-it-for-me', choices: ['gmail'] },
      OWNER,
    );
    const initial = await env.service.getRun('bot-a');
    const pausedBlocker = googleSetupBlocker({
      run: initial,
      google: { reachable: true, isAdmin: true, client: { configured: false }, accounts: [] },
      botTurnRunning: false,
      now: initial.updatedAt + GOOGLE_SETUP_PAUSED_AFTER_MS,
    });
    assert.equal(pausedBlocker.kind, 'paused');
    assert.equal(googleSetupActionsLine(pausedBlocker), 'Continue · Let me do this one');

    // Transient Center outage reports center-unreachable rather than signed-out.
    env.setCenterError(new Error('ECONNREFUSED'));
    const offlineStatus = await env.service.control(
      { botId: 'bot-a', action: 'status', fresh: true },
      OWNER,
    );
    assert.equal(offlineStatus.center.reachable, false);

    // Fail -> Resume preserves completed steps; Start over creates new run keeping choices.
    env.setCenterStatus({
      reachable: true,
      isAdmin: true,
      client: { configured: false },
      accounts: [],
    });
    await env.callBot({ action: 'step', step: 'account', status: 'done' });
    await env.callBot({ action: 'fail', error: 'Project quota reached' });
    const resumed = await env.service.control({ botId: 'bot-a', action: 'resume' }, OWNER);
    assert.equal(resumed.state, 'running');
    assert.equal(resumed.steps.account.status, 'done');
    assert.equal(resumed.lastError, undefined);

    const prevId = resumed.id;
    const restarted = await env.service.control(
      { botId: 'bot-a', action: 'answer', card: 'step', values: ['start-over'] },
      OWNER,
    );
    assert.notEqual(restarted.id, prevId);
    assert.equal(restarted.mode, 'do-it-for-me');
    assert.deepEqual(restarted.choices, ['gmail']);
    assert.deepEqual(restarted.steps, {});
  } finally {
    await env.cleanup();
  }
});

test('old-card revision and copy idempotency, persistence hygiene, and secret rejection', async () => {
  const env = makeEnv();
  try {
    const s1 = await env.service.control({ botId: 'bot-a', action: 'start' }, OWNER);
    const path1 = await env.service.control(
      {
        botId: 'bot-a',
        action: 'answer',
        card: 'path',
        values: ['guide-browser'],
        expectedRevision: s1.revision,
      },
      OWNER,
    );
    assert.equal(path1.applied, true);

    // Duplicate answer is idempotent without bumping revision.
    const dup = await env.service.control(
      {
        botId: 'bot-a',
        action: 'answer',
        card: 'path',
        values: ['guide-browser'],
        expectedRevision: s1.revision,
      },
      OWNER,
    );
    assert.equal(dup.applied, false);
    assert.equal(dup.idempotent, true);
    assert.equal(dup.revision, path1.revision);

    // Stale runId does not mutate current run.
    const staleRun = await env.service.control(
      {
        botId: 'bot-a',
        action: 'answer',
        card: 'services',
        values: ['gmail'],
        runId: 'old-run-id',
      },
      OWNER,
    );
    assert.equal(staleRun.stale, true);
    assert.equal(staleRun.applied, false);

    // Mismatched expectedRevision on a different mutation throws SETUP_REVISION_CONFLICT.
    await assert.rejects(
      () =>
        env.service.control(
          {
            botId: 'bot-a',
            action: 'answer',
            card: 'services',
            values: ['gmail'],
            expectedRevision: 0,
          },
          OWNER,
        ),
      (err) => err.code === 'SETUP_REVISION_CONFLICT',
    );

    // Secret-like inputs are strictly rejected and never written to disk.
    const secretAttempt = await env.callBot({
      action: 'need_user',
      step: 'client',
      note: 'Client secret is GOCSPX-superSecretValue12345',
    });
    assert.equal(secretAttempt.isError, true);
    assert.equal(secretAttempt.body.code, 'SETUP_SECRET_REJECTED');

    const rawFile = readFileSync(join(env.dir, 'google-setup', 'runs.json'), 'utf8');
    assert.ok(!rawFile.includes('GOCSPX-'));
    assert.ok(!rawFile.includes('clientSecret'));

    // Sanitizer strips unknown/sensitive keys if injected into persisted JSON.
    const sanitized = sanitizePersistedRun({
      id: 'run-9',
      botId: 'bot-a',
      state: 'running',
      mode: 'guide-browser',
      steps: {},
      answers: {},
      startedAt: 1,
      updatedAt: 2,
      revision: 3,
      clientSecret: 'should-be-stripped',
      lease: 'secret-lease-token',
      pageBody: '<html>secret</html>',
    });
    assert.equal(sanitized.clientSecret, undefined);
    assert.equal(sanitized.lease, undefined);
    assert.equal(sanitized.pageBody, undefined);

    // Persists across restart and forgetBot cleans up.
    await env.service.close();
    const reopened = createGoogleSetupService({ dataRoot: env.dir });
    try {
      const reloaded = await reopened.getRun('bot-a');
      assert.equal(reloaded.id, path1.id);
      assert.equal(reloaded.mode, 'guide-browser');
      await reopened.forgetBot('bot-a');
      assert.equal(await reopened.getRun('bot-a'), null);
    } finally {
      await reopened.close();
    }
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('non-admin user is blocked when Center is unconfigured', async () => {
  const env = makeEnv({
    centerStatus: {
      reachable: true,
      isAdmin: false,
      client: { configured: false },
      accounts: [],
    },
  });
  try {
    const status = await env.service.control({ botId: 'bot-a', action: 'status' }, OWNER);
    assert.equal(status.blocker.kind, 'admin-required');
    await assert.rejects(
      () => env.service.control({ botId: 'bot-a', action: 'start' }, OWNER),
      (err) => err.code === 'SETUP_ADMIN_REQUIRED',
    );
    const botStart = await env.callBot({ action: 'start' });
    assert.equal(botStart.isError, false);
    assert.equal(botStart.body.routed, 'admin-required');
  } finally {
    await env.cleanup();
  }
});
