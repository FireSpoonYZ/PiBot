import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openBotManagement } from '../../center-server/bot-management.js';
import { openCenterStore } from '../../center-server/data/index.js';
import { runLearningJob } from '../../center-server/learning-engine/index.js';
import { openLearningService } from '../../center-server/learning/index.js';
import { openPackageManager } from '../../center-server/packages/index.js';
import { openSkillManager } from '../../center-server/skills/index.js';
import { createBotLearning } from '../../host-core/bot-learning.js';
import { normalizeLiveSnapshot } from '../../host-core/remote-live-protocol.js';
import { normalizeSkillReviewInput } from '../../host-core/skill-review-protocol.js';

const require = createRequire(new URL('../../center-server/package.json', import.meta.url));
const NPM_CLI = path.join(path.dirname(require.resolve('npm/package.json')), 'bin', 'npm-cli.js');
const ENCRYPTION_KEY = new Uint8Array(32).fill(11);

function makeSkillMd(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
}

async function withSkillHarness(run, { runLearningJob } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'el-bot-learning-lifecycle-'));
  const store = openCenterStore({ dataRoot, encryptionKey: ENCRYPTION_KEY });
  const notifications = [];
  const packages = await openPackageManager({
    dataRoot,
    store,
    npmPath: NPM_CLI,
    onChange: () => {},
    withActivation: async (_id, publish) => {
      await publish();
      return true;
    },
    probeCenterMcp: async () => ({ tools: [] }),
  });
  let skills = await openSkillManager({
    dataRoot,
    store,
    packages,
    notify: (deviceId) => notifications.push(deviceId),
  });
  const botManagement = openBotManagement({
    store,
    packages,
    notify: (deviceId) => notifications.push(deviceId),
  });
  const learning = runLearningJob
    ? await openLearningService({ dataRoot, store, skills, runLearningJob })
    : null;

  store.replaceDeviceBots('dev-1', [
    { deviceId: 'dev-1', botId: 'bot-a', name: 'Bot A', isPrimary: true },
    { deviceId: 'dev-1', botId: 'bot-b', name: 'Bot B', isPrimary: false },
  ]);
  store.replaceDeviceBots('dev-2', [
    { deviceId: 'dev-2', botId: 'bot-c', name: 'Bot C', isPrimary: true },
  ]);

  const reopenSkills = async () => {
    await skills.close();
    skills = await openSkillManager({
      dataRoot,
      store,
      packages,
      notify: (deviceId) => notifications.push(deviceId),
    });
    return skills;
  };

  try {
    await run({
      dataRoot,
      store,
      packages,
      getSkills: () => skills,
      reopenSkills,
      botManagement,
      learning,
      notifications,
    });
  } finally {
    await learning?.close();
    await skills?.close();
    await packages?.close();
    store.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
}

test('learned skills auto-publish to owner Bot without approval gate and support rollback, pin/lock, archive/restore, and legacy draft migration', async () => {
  await withSkillHarness(async ({ dataRoot, store, getSkills, reopenSkills }) => {
    const skills = getSkills();
    const botA = { deviceId: 'dev-1', botId: 'bot-a' };

    const createRaw = await skills.learningTool(
      {
        ...botA,
        origin: 'background_review',
        sessionId: 'job-review-1',
        learningSource: { mode: 'review', jobId: 'job-review-1', conversationId: 'conv-1', afterEntryId: 1, throughEntryId: 4 },
      },
      'skill_manage',
      {
        action: 'create',
        name: 'deploy-helper',
        content: makeSkillMd('deploy-helper', 'Automate release checks', 'Step 1: Run release checks.'),
      },
    );
    const created = JSON.parse(createRaw);
    assert.equal(created.success, true);
    assert.equal(created.published, true);
    assert.equal(created.reviewRequired, undefined);
    assert.deepEqual(created.updatedSkills, ['deploy-helper']);

    // Learned skills panel listing shows active auto-published skill immediately.
    const listed = await skills.review(botA, { action: 'list' });
    assert.equal(listed.items.length, 1);
    const item = listed.items[0];
    assert.equal(item.name, 'deploy-helper');
    assert.equal(item.state, 'active');
    assert.equal(item.visibilityScope, 'private');
    assert.ok(item.installationId, 'expected auto-published installationId');

    const inst = store.getInstallation(item.installationId);
    assert.ok(inst);
    assert.equal(inst.visibilityScope, 'private');
    assert.deepEqual(inst.ownerBot, {
      deviceId: 'dev-1',
      botId: 'bot-a',
      skillId: inst.ownerBot.skillId,
      skillName: 'deploy-helper',
    });
    assert.equal(store.getBotCapability('dev-1', 'bot-a', item.installationId).enabled, true);

    // Edit in a second review job -> rev 2 auto-published.
    await skills.learningTool({ ...botA, origin: 'background_review', sessionId: 'job-review-2' }, 'skill_view', {
      name: 'deploy-helper',
    });
    const editedRaw = await skills.learningTool(
      { ...botA, origin: 'background_review', sessionId: 'job-review-2' },
      'skill_manage',
      {
        action: 'edit',
        name: 'deploy-helper',
        content: makeSkillMd('deploy-helper', 'Automate release checks v2', 'Step 1: Run v2 checks.'),
      },
    );
    const edited = JSON.parse(editedRaw);
    assert.equal(edited.success, true);
    assert.equal(edited.published, true);
    const updatedInst = store.getInstallation(item.installationId);
    assert.match(updatedInst.targetVersion, /^0\.0\.0-h[a-f0-9]{12}$/);
    assert.notEqual(updatedInst.targetVersion, inst.targetVersion);

    // Read detail, then pin, lock, archive, restore via review endpoint.
    const detail = await skills.review(botA, { action: 'read', skillId: item.skillId });
    assert.match(detail.files['SKILL.md'], /Step 1: Run v2 checks\./);

    const pinned = await skills.review(botA, {
      action: 'pin',
      skillId: item.skillId,
      pinned: true,
      expectedRevision: detail.stateRevision,
      requestId: 'req-pin-1',
    });
    assert.equal(pinned.pinned, true);

    const locked = await skills.review(botA, {
      action: 'lock',
      skillId: item.skillId,
      locked: true,
      expectedRevision: pinned.stateRevision,
      requestId: 'req-lock-1',
    });
    assert.equal(locked.locked, true);

    const archived = await skills.review(botA, {
      action: 'archive',
      skillId: item.skillId,
      expectedRevision: locked.stateRevision,
      requestId: 'req-archive-1',
    });
    assert.equal(archived.state, 'archived');
    assert.equal(store.getBotCapability('dev-1', 'bot-a', item.installationId).enabled, false);
    assert.equal((await skills.review(botA, { action: 'list', includeArchived: false })).items.length, 0);
    assert.equal((await skills.review(botA, { action: 'list' })).items.length, 1);

    const restored = await skills.review(botA, {
      action: 'restore',
      skillId: item.skillId,
      expectedRevision: archived.stateRevision,
      requestId: 'req-restore-1',
    });
    assert.equal(restored.state, 'active');
    assert.equal(store.getBotCapability('dev-1', 'bot-a', item.installationId).enabled, true);

    // Simulate a legacy unpublished draft row before upgrade and verify migrateExistingSkills auto-publishes on reopen.
    const dbPath = path.join(dataRoot, 'skills', 'skills.sqlite');
    const rawDb = new DatabaseSync(dbPath);
    const nowIso = new Date().toISOString();
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS skill_revisions (
        skill_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        files TEXT NOT NULL,
        description TEXT,
        origin TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL,
        learning_source TEXT,
        PRIMARY KEY (skill_id, rev)
      );
    `);
    rawDb.prepare(
      'INSERT INTO skills (id, device_id, bot_id, name, fm_name, category, revision, head_rev, installation_id, package_id, source, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('legacy-skill-1', 'dev-1', 'bot-a', 'legacy-draft', 'legacy-draft', null, 1, 1, null, null, 'managed', '{}', nowIso, nowIso);
    rawDb.prepare(
      'INSERT INTO skill_revisions (skill_id, rev, files, description, origin, request_id, created_at, learning_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      'legacy-skill-1',
      1,
      JSON.stringify({ 'SKILL.md': makeSkillMd('legacy-draft', 'Legacy draft skill', 'Recovered automatically.') }),
      'Legacy draft skill',
      'background_review',
      null,
      nowIso,
      JSON.stringify({ mode: 'review', jobId: 'legacy-job' }),
    );
    rawDb.close();

    const reopened = await reopenSkills();
    const afterMigration = await reopened.review(botA, { action: 'list' });
    const migrated = afterMigration.items.find((entry) => entry.skillId === 'legacy-skill-1');
    assert.ok(migrated, 'expected legacy draft to appear in learned skills');
    assert.ok(migrated.installationId, 'expected legacy draft to auto-publish on startup');
    assert.equal(store.getInstallation(migrated.installationId)?.visibilityScope, 'private');
    const migratedDetail = await reopened.review(botA, { action: 'read', skillId: 'legacy-skill-1' });
    assert.match(migratedDetail.files['SKILL.md'], /Recovered automatically\./);
  });
});

test('3-tier visibility scope (private, assigned, global) isolates private skills, enables cross-Bot sharing & usage rollup, and protects shared skills from auto-archival', async () => {
  await withSkillHarness(async ({ store, packages, getSkills, botManagement }) => {
    const skills = getSkills();
    const botA = { deviceId: 'dev-1', botId: 'bot-a' };
    const botB = { deviceId: 'dev-1', botId: 'bot-b' };
    const botC = { deviceId: 'dev-2', botId: 'bot-c' };

    const created = JSON.parse(
      await skills.learningTool(
        { ...botA, origin: 'background_review', sessionId: 'job-vis-1' },
        'skill_manage',
        {
          action: 'create',
          name: 'sql-tuning',
          content: makeSkillMd('sql-tuning', 'PostgreSQL query tuning checklist', 'Inspect EXPLAIN ANALYZE.'),
        },
      ),
    );
    assert.equal(created.success, true);
    const ownerSkillItem = (await skills.review(botA, { action: 'list' })).items.find((x) => x.name === 'sql-tuning');
    const installationId = ownerSkillItem?.installationId;
    assert.ok(installationId);

    // 1. Private scope: hidden from Bot B capabilities & catalog; binding Bot B fails FORBIDDEN.
    assert.equal(
      store.listBotCapabilities('dev-1', 'bot-b').some((entry) => entry.installation.installationId === installationId),
      false,
    );
    const catalogBPrivate = await botManagement.execute(botB, { action: 'catalog' });
    assert.equal(catalogBPrivate.installations.some((entry) => entry.installationId === installationId), false);
    assert.throws(
      () => store.putBotCapability('dev-1', 'bot-b', installationId, { expectedRevision: 0, enabled: true, overrides: {} }),
      (err) => err?.code === 'FORBIDDEN',
    );

    // 2. Switch to 'assigned': visible to Bot B, bindable on Bot B, read-only installed skill on Bot B.
    const currentInst = store.getInstallation(installationId);
    const assignedInst = store.renameInstallation(installationId, {
      expectedRevision: currentInst.revision,
      visibilityScope: 'assigned',
    });
    assert.equal(assignedInst.visibilityScope, 'assigned');
    assert.equal(
      store.listBotCapabilities('dev-1', 'bot-b').some((entry) => entry.installation.installationId === installationId),
      true,
    );

    store.putBotCapability('dev-1', 'bot-b', installationId, {
      expectedRevision: 0,
      enabled: true,
      overrides: {},
    });
    await packages.reconcileDevice('dev-1');

    const bSkillList = await skills.execute(botB, { action: 'list' });
    assert.equal(bSkillList.installed.some((entry) => entry.installationId === installationId && entry.enabled), true);

    // Cross-Bot usage observation from Bot B credits owner Bot A's skill_usage!
    await skills.reportUse(botB, {
      requestId: 'a'.repeat(64),
      installationId,
      version: assignedInst.targetVersion,
      skillName: 'sql-tuning',
      skillPath: '.',
      path: 'SKILL.md',
    });

    const curatedReport = await skills.learningTool({ ...botA, origin: 'curator' }, 'skill_usage.curated_report', {});
    const reportEntry = curatedReport.find((entry) => entry.name === 'sql-tuning');
    assert.ok(reportEntry);
    assert.equal(reportEntry.use_count, 1, 'expected Bot B usage to roll up to owner Bot A');
    assert.equal(reportEntry.pinned, true, 'expected shared skill to carry pinned immunity in curated_report');
    assert.equal(reportEntry.shared, true);

    // Autonomous single-Bot archival and Curator consolidation delete must refuse shared skills!
    const [archivedOk, archivedMsg] = await skills.learningTool({ ...botA, origin: 'curator' }, 'skill_usage.archive_skill', {
      name: 'sql-tuning',
    });
    assert.equal(archivedOk, false);
    assert.match(archivedMsg, /shared across Bots/i);

    // Create a target skill so we can attempt curator consolidation delete on sql-tuning.
    await skills.learningTool({ ...botA, origin: 'curator' }, 'skill_manage', {
      action: 'create',
      name: 'db-playbook',
      content: makeSkillMd('db-playbook', 'Unified database playbook', 'Covers SQL tuning.'),
    });
    await skills.learningTool({ ...botA, origin: 'curator' }, 'skill_view', { name: 'sql-tuning' });
    await skills.learningTool({ ...botA, origin: 'curator' }, 'skill_view', { name: 'db-playbook' });
    const deleteShared = JSON.parse(
      await skills.learningTool({ ...botA, origin: 'curator' }, 'skill_manage', {
        action: 'delete',
        name: 'sql-tuning',
        absorbed_into: 'db-playbook',
      }),
    );
    assert.equal(deleteShared.success, false);
    assert.match(deleteShared.error, /shared across Bots/i);

    // 3. Switch to 'global': respects explicit opt-out (revision > 0) while auto-enabling untouched & future Bots.
    const bCurrentCap = store.getBotCapability('dev-1', 'bot-b', installationId);
    store.putBotCapability('dev-1', 'bot-b', installationId, {
      expectedRevision: bCurrentCap.revision,
      enabled: false,
      overrides: {},
    });
    assert.equal(store.getBotCapability('dev-2', 'bot-c', installationId).enabled, false);

    const globalInst = store.renameInstallation(installationId, {
      expectedRevision: store.getInstallation(installationId).revision,
      visibilityScope: 'global',
    });
    assert.equal(globalInst.visibilityScope, 'global');
    assert.equal(store.getBotCapability('dev-2', 'bot-c', installationId).enabled, true, 'untouched Bot C auto-enabled');
    assert.equal(store.getBotCapability('dev-1', 'bot-b', installationId).enabled, false, 'explicit opt-out on Bot B preserved');

    // Future newly created Bot D on dev-2 also gets global skill enabled automatically!
    store.replaceDeviceBots('dev-2', [
      { deviceId: 'dev-2', botId: 'bot-c', name: 'Bot C', isPrimary: true },
      { deviceId: 'dev-2', botId: 'bot-d', name: 'Bot D', isPrimary: false },
    ]);
    assert.equal(store.getBotCapability('dev-2', 'bot-d', installationId).enabled, true, 'new Bot D auto-enabled');
  });
});

test('curator lifecycle transitions (mark_stale, archive_skill) and optional consolidation delete archive private skills while keeping history', async () => {
  await withSkillHarness(async ({ store, getSkills }) => {
    const skills = getSkills();
    const botA = { deviceId: 'dev-1', botId: 'bot-a' };
    const curator = { ...botA, origin: 'curator', sessionId: 'job-curate-1' };

    const s1 = JSON.parse(
      await skills.learningTool(curator, 'skill_manage', {
        action: 'create',
        name: 'old-helper',
        content: makeSkillMd('old-helper', 'Rarely used helper', 'Legacy steps.'),
      }),
    );
    const s2 = JSON.parse(
      await skills.learningTool(curator, 'skill_manage', {
        action: 'create',
        name: 'dup-helper',
        content: makeSkillMd('dup-helper', 'Duplicate helper', 'Duplicate steps.'),
      }),
    );
    const s3 = JSON.parse(
      await skills.learningTool(curator, 'skill_manage', {
        action: 'create',
        name: 'canonical-helper',
        content: makeSkillMd('canonical-helper', 'Canonical helper', 'Merged canonical steps.'),
      }),
    );
    assert.equal(s1.success && s2.success && s3.success, true);
    const initialItems = (await skills.review(botA, { action: 'list' })).items;
    const s1InstId = initialItems.find((x) => x.name === 'old-helper')?.installationId;
    const s2InstId = initialItems.find((x) => x.name === 'dup-helper')?.installationId;
    assert.ok(s1InstId && s2InstId);

    // 14-day stale mark -> 30-day archive_skill disables Bot capability binding while keeping skill recoverable.
    await skills.learningTool(curator, 'skill_usage.set_state', { name: 'old-helper', state: 'stale' });
    assert.equal((await skills.review(botA, { action: 'list' })).items.find((x) => x.name === 'old-helper')?.state, 'stale');

    const [archivedOk] = await skills.learningTool(curator, 'skill_usage.archive_skill', { name: 'old-helper' });
    assert.equal(archivedOk, true);
    assert.equal(store.getBotCapability('dev-1', 'bot-a', s1InstId).enabled, false);

    // Curator consolidation delete(absorbed_into=...) archives dup-helper instead of hard-deleting revisions.
    await skills.learningTool(curator, 'skill_view', { name: 'dup-helper' });
    await skills.learningTool(curator, 'skill_view', { name: 'canonical-helper' });
    const consolidated = JSON.parse(
      await skills.learningTool(curator, 'skill_manage', {
        action: 'delete',
        name: 'dup-helper',
        absorbed_into: 'canonical-helper',
      }),
    );
    assert.equal(consolidated.success, true);
    assert.equal(consolidated.archived, true);
    assert.equal(consolidated.absorbed_into ?? consolidated.absorbedInto, 'canonical-helper');
    assert.equal(store.getBotCapability('dev-1', 'bot-a', s2InstId).enabled, false);

    const allWithArchived = await skills.review(botA, { action: 'list', includeArchived: true });
    assert.equal(allWithArchived.items.find((x) => x.name === 'dup-helper')?.state, 'archived');
    assert.equal(allWithArchived.items.find((x) => x.name === 'canonical-helper')?.state, 'active');
  });
});

test('batch skill_manage rollback preserves center.sqlite binding, global->assigned shrinks auto-seeded capabilities while keeping explicit ones, and review archive rejects shared skills', async () => {
  await withSkillHarness(async ({ store, getSkills }) => {
    const skills = getSkills();
    const botA = { deviceId: 'dev-1', botId: 'bot-a' };
    const curator = { ...botA, origin: 'curator', sessionId: 'job-batch-rollback-1' };

    // 1. Batch skill_manage cross-DB rollback safety (skills.sqlite + center.sqlite)
    for (const name of ['rollback-victim', 'surviving-skill', 'scope-shrink-skill']) {
      const created = JSON.parse(
        await skills.learningTool(curator, 'skill_manage', {
          action: 'create',
          name,
          content: makeSkillMd(name, `Skill ${name}`, `Steps for ${name}.`),
        }),
      );
      assert.equal(created.success, true);
    }

    const listedBefore = (await skills.review(botA, { action: 'list' })).items;
    const victimItem = listedBefore.find((x) => x.name === 'rollback-victim');
    const shrinkItem = listedBefore.find((x) => x.name === 'scope-shrink-skill');
    assert.ok(victimItem?.installationId);
    assert.ok(shrinkItem?.installationId);
    assert.equal(store.getBotCapability('dev-1', 'bot-a', victimItem.installationId).enabled, true);

    await skills.learningTool(curator, 'skill_view', { name: 'rollback-victim' });
    await skills.learningTool(curator, 'skill_view', { name: 'surviving-skill' });

    const batchRolledBack = JSON.parse(
      await skills.learningTool(curator, 'skill_manage', {
        operations: [
          {
            action: 'delete',
            name: 'rollback-victim',
            absorbed_into: 'surviving-skill',
          },
          {
            action: 'intentional_invalid_op',
            name: 'surviving-skill',
          },
        ],
      }),
    );
    assert.equal(batchRolledBack.success, false);
    assert.equal(batchRolledBack.rolled_back, true);
    assert.equal(batchRolledBack.operations_applied, 0);
    assert.equal(batchRolledBack.results?.[0]?.success, true);
    assert.equal(batchRolledBack.results?.[1]?.success, false);

    const listedAfterRollback = (await skills.review(botA, { action: 'list' })).items;
    assert.equal(
      listedAfterRollback.find((x) => x.name === 'rollback-victim')?.state,
      'active',
      'skills.sqlite state must remain active after batch rollback',
    );
    assert.equal(
      store.getBotCapability('dev-1', 'bot-a', victimItem.installationId).enabled,
      true,
      'center.sqlite capability binding must remain enabled: true after batch rollback',
    );

    // 2. visibilityScope 'global' -> 'assigned' permission shrinkage
    // First set to 'assigned' and explicitly grant Bot C via putBotCapability, leaving Bot B untouched.
    const instId = shrinkItem.installationId;
    const assignedFirst = store.renameInstallation(instId, {
      expectedRevision: store.getInstallation(instId).revision,
      visibilityScope: 'assigned',
    });
    assert.equal(assignedFirst.visibilityScope, 'assigned');

    const explicitBotC = store.putBotCapability('dev-2', 'bot-c', instId, {
      expectedRevision: store.getBotCapability('dev-2', 'bot-c', instId).revision,
      enabled: true,
      overrides: {},
    });
    assert.equal(explicitBotC.enabled, true);
    assert.equal('explicitAssigned' in explicitBotC, false);
    assert.equal(store.getBotCapability('dev-1', 'bot-b', instId).enabled, false);

    // Promote to 'global' -> untouched non-owner Bot B automatically receives enabled: true.
    const promotedGlobal = store.renameInstallation(instId, {
      expectedRevision: store.getInstallation(instId).revision,
      visibilityScope: 'global',
    });
    assert.equal(promotedGlobal.visibilityScope, 'global');
    const autoBotBCap = store.getBotCapability('dev-1', 'bot-b', instId);
    assert.equal(autoBotBCap.enabled, true, 'non-owner Bot B auto-enabled under global scope');
    assert.equal('autoSeeded' in autoBotBCap, false);
    assert.equal(store.getBotCapability('dev-2', 'bot-c', instId).enabled, true);

    // 3a. Manual archive via foreground review() must reject while 'global' with INVALID_STATE + 'shared'
    const currentShrinkGlobal = (await skills.review(botA, { action: 'list' })).items.find(
      (x) => x.skillId === shrinkItem.skillId,
    );
    await assert.rejects(
      skills.review(botA, {
        action: 'archive',
        skillId: shrinkItem.skillId,
        expectedRevision: currentShrinkGlobal.stateRevision,
        requestId: 'req-manual-archive-global',
      }),
      (err) => err?.code === 'INVALID_STATE' && String(err?.message ?? '').toLowerCase().includes('shared'),
    );

    // Downgrade 'global' -> 'assigned': auto-seeded Bot B shrinks to enabled: false, while explicit Bot C stays enabled: true!
    const downgradedAssigned = store.renameInstallation(instId, {
      expectedRevision: store.getInstallation(instId).revision,
      visibilityScope: 'assigned',
    });
    assert.equal(downgradedAssigned.visibilityScope, 'assigned');
    assert.equal(
      store.getBotCapability('dev-1', 'bot-b', instId).enabled,
      false,
      'auto-seeded non-owner Bot B binding must shrink to enabled: false when downgraded to assigned',
    );
    assert.equal(
      store.getBotCapability('dev-2', 'bot-c', instId).enabled,
      true,
      'explicitly assigned Bot C binding must remain enabled: true when downgraded to assigned',
    );
    assert.equal(store.getBotCapability('dev-1', 'bot-a', instId).enabled, true);

    // 3b. Manual archive via foreground review() must also reject while 'assigned' with INVALID_STATE + 'shared'
    const currentShrinkAssigned = (await skills.review(botA, { action: 'list' })).items.find(
      (x) => x.skillId === shrinkItem.skillId,
    );
    await assert.rejects(
      skills.review(botA, {
        action: 'archive',
        skillId: shrinkItem.skillId,
        expectedRevision: currentShrinkAssigned.stateRevision,
        requestId: 'req-manual-archive-assigned',
      }),
      (err) => err?.code === 'INVALID_STATE' && String(err?.message ?? '').toLowerCase().includes('shared'),
    );
  });
});

test('center learning defaults consolidate=false and restores automatic review counters when preempted before mutation', async () => {
  const activeSignals = [];
  await withSkillHarness(
    async ({ learning }) => {
      const botA = { deviceId: 'dev-1', botId: 'bot-a' };
      const initial = await learning.execute(botA, { action: 'status' });
      assert.equal(initial.settings.curator.consolidate, false);
      assert.equal(initial.settings.curator.staleAfterDays, 14);
      assert.equal(initial.settings.curator.archiveAfterDays, 30);
      assert.equal(initial.settings.review.memoryEvery, 10);
      assert.equal(initial.settings.review.skillEvery, 10);

      // Configure lower thresholds and toggle consolidate on/off.
      const configured = await learning.execute(botA, {
        action: 'configure',
        expectedRevision: initial.settings.revision,
        config: {
          review: { memoryEvery: 2, skillEvery: 4 },
          curator: { consolidate: true },
        },
      });
      assert.equal(configured.settings.curator.consolidate, true);
      assert.equal(configured.settings.review.memoryEvery, 2);
      assert.equal(configured.settings.review.skillEvery, 4);

      const snapshot = {
        messages: [
          { role: 'user', content: 'Run deployment checks' },
          { role: 'assistant', content: 'Done.' },
        ],
        model: 'gpt-test',
        provider: 'openai',
        sessionId: 'conv-1',
        memoryEnabled: true,
        memory: { enabled: true, canRead: true, canWrite: true, mode: 'read-write' },
      };

      // Start an automatic review job that consumes turns=2, iterations=4, then cancel it before any mutation.
      const started = await learning.execute(botA, {
        action: 'start',
        mode: 'review',
        automatic: true,
        requestId: 'auto-review-1',
        turns: 2,
        iterations: 4,
        snapshot,
      });
      assert.ok(started.jobId);
      assert.equal(started.status, 'queued');

      await learning.execute(botA, { action: 'cancel', jobId: started.jobId });
      await new Promise((r) => setTimeout(r, 20));

      const afterCancel = await learning.execute(botA, { action: 'status' });
      assert.equal(afterCancel.lastJob?.status, 'cancelled');
      assert.equal(afterCancel.counters.turnsSinceMemoryReview, 2, 'unmutated cancelled job must restore memory counter');
      assert.equal(afterCancel.counters.itersSinceSkillReview, 4, 'unmutated cancelled job must restore skill counter');

      // Because counters were restored, the next idle automatic start (even with turns=0, iterations=0) launches immediately!
      const retried = await learning.execute(botA, {
        action: 'start',
        mode: 'review',
        automatic: true,
        requestId: 'auto-review-2',
        turns: 0,
        iterations: 0,
        snapshot,
      });
      assert.ok(retried.jobId, 'expected restored counters to trigger review on next idle window');
      activeSignals.at(-1)?.resolveNow({ status: 'completed', summary: 'Nothing to save.' });
      await new Promise((r) => setTimeout(r, 30));

      const afterFinish = await learning.execute(botA, { action: 'status' });
      assert.equal(afterFinish.counters.turnsSinceMemoryReview, 0);
      assert.equal(afterFinish.counters.itersSinceSkillReview, 0);
    },
    {
      runLearningJob: (_payload, { signal }) =>
        new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          activeSignals.push({
            resolveNow(value) {
              signal?.removeEventListener('abort', onAbort);
              resolve(value);
            },
          });
        }),
    },
  );
});

test('host bot-learning waits for idle settle, preempts on foreground activity, includes delegated Scope work turns, and emits live mascot states', async () => {
  let botIdle = true;
  const liveStates = [];
  const centerCalls = [];
  const entries = [
    {
      id: 1,
      kind: 'input',
      data: { turn: { sender: { kind: 'user' } } },
      model: [{ role: 'user', content: 'First task' }],
    },
    {
      id: 2,
      kind: 'answer',
      model: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'tc1', name: 'bash', arguments: { cmd: 'ls' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'tc1',
          content: [{ type: 'text', text: 'ok' }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Completed first task.' }],
        },
      ],
    },
    {
      id: 3,
      kind: 'input',
      data: { turn: { sender: { kind: 'user' } } },
      model: [{ role: 'user', content: 'Second task' }],
    },
    {
      id: 4,
      kind: 'answer',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Completed second task.' }] }],
    },
    {
      id: 5,
      kind: 'host.work-trigger',
      data: { attribution: { kind: 'bot', channel: 'room' } },
      model: [{ role: 'user', content: 'Delegated room work' }],
    },
    {
      id: 6,
      kind: 'answer',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'Completed delegated work.' }] }],
    },
  ];
  const submissions = new Map([
    ['sub-1', { type: 'input', entry: 1, answer: 2 }],
    ['sub-2', { type: 'input', entry: 3, answer: 4 }],
    ['sub-work-1', { type: 'input', entry: 5, answer: 6 }],
  ]);

  let resolveNextPoll = null;
  let activeJobCounter = 0;
  let jobsCancelled = 0;

  const botObj = {
    botId: 'bot-a',
    deviceId: 'dev-1',
    name: 'Bot A',
    cwd: process.cwd(),
    primaryConversationId: 'conv-1',
    archivedAt: null,
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
  };

  const botLearning = createBotLearning({
    host: {
      deviceId: 'dev-1',
      getBot: (id) => (id === 'bot-a' ? botObj : null),
      listBots: () => [botObj],
      getBotSoul: () => ({ text: 'You are Bot A.' }),
    },
    getHarness: () => ({
      submission: async (subId) =>
        submissions.has(subId) ? { status: async () => submissions.get(subId) } : null,
      commit: async (fn) =>
        fn({
          entry: (entryId) => entries.find((e) => e.id === entryId) ?? null,
        }),
    }),
    models: { getModel: () => ({ id: 'test-model' }) },
    getBotModels: () => ({ 'bot-a': { modelRef: 'openai/gpt-test' } }),
    getCenterClient: () => ({
      botLearning: async (_deviceId, _botId, payload, signal) => {
        centerCalls.push(payload);
        if (payload.action === 'status') {
          return {
            settings: { reviewModelRef: null, curatorModelRef: null, curator: { minIdleHours: 2 } },
            counters: {
              reviewCursor: activeJobCounter > 0 ? { sessionId: 'conv-1', throughEntryId: 6 } : null,
              jobsCancelled,
              jobsInterrupted: 0,
            },
            activeJob: null,
          };
        }
        if (payload.action === 'start') {
          const jobId = `job-${++activeJobCounter}`;
          return { jobId, status: 'running' };
        }
        if (payload.action === 'next') {
          return await new Promise((resolve, reject) => {
            const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            if (signal?.aborted) return onAbort();
            signal?.addEventListener('abort', onAbort, { once: true });
            resolveNextPoll = (val) => {
              signal?.removeEventListener('abort', onAbort);
              resolve(val);
            };
          });
        }
        if (payload.action === 'cancel') {
          jobsCancelled += 1;
          return { jobId: payload.jobId, status: 'cancelled' };
        }
        return { status: 'ok' };
      },
    }),
    plugins: {
      actionByName: async () => {
        throw Object.assign(new Error('disabled'), { code: 'EXTENSION_DISABLED' });
      },
    },
    schedules: { listTasks: () => [] },
    getUsableModelRefs: () => new Set(['openai/gpt-test']),
    registry: { install: () => {}, uninstall: () => {} },
    context: {},
    openPrimaryConversation: async () => ({
      entries: async () => ({ items: [...entries].reverse(), next: null }),
    }),
    dropEnvFor: () => {},
    isBotIdle: async () => botIdle,
    onLearningStateChange: (botId, state) => {
      liveStates.push({ botId, state: structuredClone(state) });
    },
    idleSettleMs: 40,
  });

  try {
    // 1. Trigger submission, then immediately preempt before the 40ms settle window expires.
    botLearning.noteCompletedSubmission('bot-a', { status: 'done', submissionId: 'sub-1' });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(centerCalls.filter((c) => c.action === 'start').length, 0, 'must not start learning before idle settle window');

    botIdle = false;
    botLearning.preemptForForeground('bot-a');
    await new Promise((r) => setTimeout(r, 55));
    assert.equal(centerCalls.filter((c) => c.action === 'start').length, 0, 'must not start learning while preempted / foreground busy');

    // 2. Complete second submission + a delegated Scope work turn, then return to idle.
    botIdle = true;
    botLearning.noteCompletedSubmission('bot-a', { status: 'done', submissionId: 'sub-2' });
    botLearning.noteCompletedWorkTurn('bot-a', { unified: true, submissionId: 'sub-work-1' });

    await new Promise((r) => setTimeout(r, 80));
    const startCall = centerCalls.find((c) => c.action === 'start');
    assert.ok(startCall, 'expected settled idle window to send coalesced start');
    assert.equal(startCall.turns, 3, '2 primary user turns + 1 delegated Scope work turn');
    assert.equal(startCall.iterations, 4, '4 assistant iterations across primary + Scope work turns');
    assert.equal(startCall.snapshot.messages.length, 8, 'full multi-turn trajectory preserved');

    // Active mascot reflection state was emitted!
    assert.equal(liveStates.some((s) => s.state?.active === true && s.state?.phase === 'reviewing'), true);

    // 3. Preempt an actively running automatic review job when user speaks again -> aborts & cancels remote job!
    botLearning.preemptForForeground('bot-a');
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(centerCalls.some((c) => c.action === 'cancel' && c.jobId === 'job-1'), true);
    assert.equal(liveStates.at(-1)?.state?.active, false);
    assert.equal(liveStates.at(-1)?.state?.lastOutcome?.status, 'cancelled');

    // 4. Schedule idle check again -> retries preempted check even with unchanged cursor and completes cleanly!
    const retryPromise = new Promise((resolve) => {
      const check = setInterval(() => {
        if (centerCalls.filter((c) => c.action === 'next').length >= 2 && resolveNextPoll) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    botLearning.scheduleIdleCheck('bot-a');
    await retryPromise;
    resolveNextPoll({
      status: 'completed',
      result: { summary: 'Created skill `release-check`.', updatedSkills: ['release-check'] },
    });
    await new Promise((r) => setTimeout(r, 35));

    const finalState = liveStates.at(-1)?.state;
    assert.equal(finalState?.active, false);
    assert.equal(finalState?.lastOutcome?.status, 'completed');
    assert.equal(finalState?.lastOutcome?.summary, 'Created skill `release-check`.');
    assert.deepEqual(finalState?.lastOutcome?.updatedSkills, ['release-check']);
  } finally {
    await botLearning.close();
  }
});

test('skill-review-protocol and remote-live-protocol preserve learned-skills actions and live learning state', () => {
  assert.deepEqual(normalizeSkillReviewInput({ action: 'list', includeArchived: true }), {
    action: 'list',
    includeArchived: true,
  });
  assert.equal(
    normalizeSkillReviewInput({
      action: 'pin',
      skillId: 's1',
      pinned: true,
      expectedRevision: 1,
      requestId: 'r2',
    }).pinned,
    true,
  );

  const normalized = normalizeLiveSnapshot({
    type: 'snapshot',
    botId: 'bot-a',
    conversationId: 'conv-1',
    sequence: 7,
    state: {
      history: [],
      historyTruncated: false,
      lastEntryId: null,
      generation: null,
      tools: [],
      toolsTruncated: false,
      busy: false,
      queuedCount: 0,
      activity: { phase: 'idle', source: null, scopeId: null, requestId: null, startedAt: null },
      learning: {
        active: true,
        jobId: 'job-9',
        mode: 'review',
        automatic: true,
        phase: 'writing',
        toolName: 'skill_manage',
        startedAt: '2026-11-12T10:00:00.000Z',
        lastOutcome: {
          seq: 2,
          jobId: 'job-8',
          mode: 'review',
          status: 'completed',
          finishedAt: '2026-11-12T09:59:00.000Z',
          updatedSkills: ['deploy-helper'],
          archivedSkills: [],
          memoryUpdated: false,
          summary: 'Updated deploy-helper',
        },
      },
    },
  });
  assert.equal(normalized.state.learning?.active, true);
  assert.equal(normalized.state.learning?.phase, 'writing');
  assert.equal(normalized.state.learning?.toolName, 'skill_manage');
  assert.deepEqual(normalized.state.learning?.lastOutcome?.updatedSkills, ['deploy-helper']);
});

function detectPythonCommand() {
  for (const candidate of [process.env.PIBOT_LEARNING_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const res = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'], {
      stdio: 'ignore',
    });
    if (res.status === 0) return candidate;
  }
  return null;
}

test('real Python learning-engine executes upstream Hermes curator deterministic 14d stale and 30d archive transitions while exempting shared skills', async (t) => {
  const pyCmd = detectPythonCommand();
  if (!pyCmd) {
    t.skip('Python 3.10+ not available in PATH');
    return;
  }
  const prevPy = process.env.PIBOT_LEARNING_PYTHON;
  process.env.PIBOT_LEARNING_PYTHON = pyCmd;
  try {
    await withSkillHarness(
      async ({ dataRoot, store, getSkills, learning }) => {
        const skills = getSkills();
        const botA = { deviceId: 'dev-1', botId: 'bot-a' };
        const creator = { ...botA, origin: 'background_review', sessionId: 'seed-job' };

        for (const name of ['stale-target', 'archive-target', 'shared-protected']) {
          const out = JSON.parse(
            await skills.learningTool(creator, 'skill_manage', {
              action: 'create',
              name,
              content: makeSkillMd(name, `Skill ${name}`, `Instructions for ${name}.`),
            }),
          );
          assert.equal(out.success, true);
        }

        // Share 'shared-protected' with Bot B ('assigned' scope) so it must resist 30-day single-Bot auto-archival!
        const itemsBefore = (await skills.review(botA, { action: 'list' })).items;
        const sharedInstId = itemsBefore.find((x) => x.name === 'shared-protected').installationId;
        const archiveInstId = itemsBefore.find((x) => x.name === 'archive-target').installationId;
        store.renameInstallation(sharedInstId, {
          expectedRevision: store.getInstallation(sharedInstId).revision,
          visibilityScope: 'assigned',
        });

        // Backdate last activity timestamps in skill_usage SQLite:
        // - stale-target: 20 days ago (> 14d, < 30d) -> becomes 'stale'
        // - archive-target: 35 days ago (> 30d) -> becomes 'archived' and disables Bot capability
        // - shared-protected: 45 days ago (> 30d, but shared!) -> stays 'active' and enabled!
        const dbPath = path.join(dataRoot, 'skills', 'skills.sqlite');
        const rawDb = new DatabaseSync(dbPath);
        const setAgeDays = (skillName, daysAgo) => {
          const row = rawDb.prepare('SELECT revision, json FROM skill_usage WHERE device_id = ? AND bot_id = ? AND name = ?').get(
            'dev-1',
            'bot-a',
            skillName,
          );
          const rec = JSON.parse(row.json);
          const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
          rec.first_seen_at = ts;
          rec.last_used_at = ts;
          rec.last_patched_at = ts;
          rec.last_viewed_at = ts;
          rawDb.prepare('UPDATE skill_usage SET json = ? WHERE device_id = ? AND bot_id = ? AND name = ?').run(
            JSON.stringify(rec),
            'dev-1',
            'bot-a',
            skillName,
          );
        };
        setAgeDays('stale-target', 20);
        setAgeDays('archive-target', 35);
        setAgeDays('shared-protected', 45);
        rawDb.close();

        // Manual curate run (consolidate=false by default -> zero LLM calls needed, pure deterministic lifecycle pass!).
        const started = await learning.execute(botA, {
          action: 'start',
          mode: 'curate',
          automatic: false,
          requestId: 'real-py-curate-1',
          snapshot: { messages: [], sessionId: 'conv-1' },
        });
        assert.ok(started.jobId);

        // Drive poll loop until finished (schedule.call may ask for referenced_skill_names).
        let finalPoll = null;
        for (let i = 0; i < 40; i += 1) {
          const poll = await learning.execute(botA, { action: 'next', jobId: started.jobId });
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(poll.status)) {
            finalPoll = poll;
            break;
          }
          if (poll.call) {
            await learning.execute(botA, {
              action: 'respond',
              jobId: started.jobId,
              callId: poll.call.id,
              result: [],
            });
          }
        }
        assert.equal(finalPoll?.status, 'completed', `expected curate completed, got ${JSON.stringify(finalPoll)}`);

        const itemsAfter = (await skills.review(botA, { action: 'list' })).items;
        assert.equal(itemsAfter.find((x) => x.name === 'stale-target')?.state, 'stale');
        assert.equal(itemsAfter.find((x) => x.name === 'archive-target')?.state, 'archived');
        assert.equal(store.getBotCapability('dev-1', 'bot-a', archiveInstId).enabled, false);
        assert.equal(itemsAfter.find((x) => x.name === 'shared-protected')?.state, 'active');
        assert.equal(store.getBotCapability('dev-1', 'bot-a', sharedInstId).enabled, true);
      },
      { runLearningJob },
    );
  } finally {
    if (prevPy === undefined) delete process.env.PIBOT_LEARNING_PYTHON;
    else process.env.PIBOT_LEARNING_PYTHON = prevPy;
  }
});
