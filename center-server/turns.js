import { createHash } from 'node:crypto';

const error = (code, message) => Object.assign(new Error(message), { code });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// Immediate re-resolution attempts when concurrent configuration changes are detected mid-preparation.
const MAX_ATTEMPTS = 3;

const grant = (record) => ({ admissionId: record.admissionId, setId: record.setId, admittedAt: record.admittedAt });

export function openTurnAdmission({ store, packages }) {
  /**
   * Exact desired installation plans for this Bot: enabled host-target capabilities only.
   * An intended capability that is authorized but not yet rollout-enabled must refuse the whole
   * new turn — granting a partial set would silently omit an intended plugin (contract §2).
   */
  async function botPlans(deviceId, bot) {
    const plans = [];
    for (const capability of bot.capabilities) {
      if (capability.target !== 'host') continue;
      if (!capability.enabled) {
        if (capability.authorized === true) {
          throw error('TURN_SYNC_FAILED', 'An authorized capability is not ready for this turn');
        }
        continue;
      }
      plans.push(await packages.turnPlan(deviceId, capability.installationId));
    }
    plans.sort((a, b) => a.installationId < b.installationId ? -1 : a.installationId > b.installationId ? 1 : 0);
    return plans;
  }

  /**
   * Resolves the current authoritative per-Bot set; retries when the content changed under async
   * plan resolution. Plans carry immutable artifact/digest/lock identity, so a plan identity
   * comparison covers artifact drift that the semantic checksum cannot see.
   */
  async function resolveSet(deviceId, botId) {
    for (let attempt = 0; ; attempt += 1) {
      const context = store.getBotTurnContext(deviceId, botId);
      const plans = await botPlans(deviceId, context.bot);
      const verify = store.getBotTurnContext(deviceId, botId);
      if (verify.checksum === context.checksum) {
        const fingerprint = sha256(JSON.stringify({ content: verify.checksum, plans: planIdentity(plans) }));
        return { context: verify, plans, fingerprint, setId: 'set-' + fingerprint };
      }
      if (attempt + 1 >= MAX_ATTEMPTS) throw error('TURN_SET_CHANGED', 'Desired set changed during preparation');
    }
  }

  /** Plan identity covers the immutable install content, not cosmetic planId/receipt fields. */
  function planIdentity(plans) {
    return plans.map((plan) => ({
      installationId: plan.installationId, packageId: plan.packageId, kind: plan.kind,
      targetVersion: plan.targetVersion, artifactRef: plan.artifactRef ?? null,
      digest: plan.digest ?? null, lockfile: plan.lockfile ?? null, manifest: plan.manifest ?? null,
    }));
  }

  /** Post-await confirmation that resolved plans still match the persisted authoritative plans. */
  function assertPlansCurrent(resolved, deviceId, botId) {
    const current = store.getBotTurnContext(deviceId, botId);
    if (current.checksum !== resolved.context.checksum) {
      throw error('TURN_SET_CHANGED', 'Desired set changed during admission');
    }
  }

  function setSnapshot(context) {
    const { bot } = context;
    return {
      protocol: 1, deviceId: context.deviceId, revision: context.revision,
      providers: context.providers, models: context.models,
      bots: [{ botId: bot.botId, model: bot.model, capabilities: bot.capabilities }],
    };
  }

  /** Records (or reuses) the deduplicated nonsecret set; snapshot/plans retain refs and revisions, never credential values. */
  function saveSet(deviceId, botId, resolved) {
    return store.putTurnSet({
      setId: resolved.setId, deviceId, botId, fingerprint: resolved.fingerprint,
      snapshot: setSnapshot(resolved.context), plans: resolved.plans,
      refs: resolved.context.refs, credentialRevisions: resolved.context.credentialRevisions,
    });
  }

  /** Desired artifacts must be present before a grant; missing preparation is a typed sync failure, never a silent skip. */
  async function assertReady(plans) {
    for (const plan of plans) {
      if (!plan.manifest || !plan.targetVersion) throw error('TURN_SYNC_FAILED', 'Desired package version is not prepared');
      if (plan.artifactRef) {
        try { await packages.readArtifact(plan.artifactRef); }
        catch { throw error('TURN_SYNC_FAILED', 'Desired artifact is not ready'); }
      }
    }
  }

  const emit = (set, credentials, admission) => ({
    protocol: 1, botId: set.botId, setId: set.setId,
    snapshot: { ...set.snapshot, credentials },
    plans: set.plans,
    ...(admission ? { admission } : {}),
  });

  async function prepareTurn(deviceId, input) {
    const { botId, requestId, scopeKey, inputDigest, knownSetId } = input;
    const requestFingerprint = sha256(inputDigest);
    const existing = store.findTurnAdmission({ deviceId, botId, scopeKey, requestId });
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) throw error('REQUEST_CONFLICT', 'Turn request conflicts');
      const set = store.getTurnSet(existing.setId);
      if (!set) throw error('TURN_SYNC_FAILED', 'Pinned set is unavailable');
      // Idempotent prepare is a restore: recheck present authorization, referenced credential
      // revisions and artifact availability before returning the same grant. Never re-issue
      // credentials under a pin whose authorization was revoked or rotated.
      await assertRestorable(deviceId, set);
      store.assertTurnAuthorization(deviceId, botId, set);
      const credentials = Object.fromEntries((set.refs ?? []).map((ref) => [ref, store.resolveCredential(ref)]));
      return emit(set, credentials, grant(existing));
    }
    const resolved = await resolveSet(deviceId, botId);
    const set = saveSet(deviceId, botId, resolved);
    let admission = null;
    if (knownSetId === set.setId) {
      await assertReady(resolved.plans);
      assertPlansCurrent(resolved, deviceId, botId);
      admission = grant(store.confirmTurnAdmission({
        deviceId, botId, scopeKey, requestId, setId: set.setId,
        checksum: resolved.context.checksum, requestFingerprint,
        planFingerprint: sha256(JSON.stringify(planIdentity(resolved.plans))),
      }));
    }
    return emit(set, resolved.context.credentials, admission);
  }

  async function confirmTurn(deviceId, input) {
    const { botId, requestId, scopeKey, inputDigest, setId } = input;
    const requestFingerprint = sha256(inputDigest);
    const resolved = await resolveSet(deviceId, botId);
    const set = saveSet(deviceId, botId, resolved);
    if (setId !== set.setId) throw error('TURN_SET_CHANGED', 'Desired set changed since preparation');
    await assertReady(resolved.plans);
    // Post-await: persisted authoritative identity may have drifted while artifacts were checked;
    // re-verify the semantic checksum before recording the admission.
    assertPlansCurrent(resolved, deviceId, botId);
    return grant(store.confirmTurnAdmission({
      deviceId, botId, scopeKey, requestId, setId,
      checksum: resolved.context.checksum, requestFingerprint,
      planFingerprint: sha256(JSON.stringify(planIdentity(resolved.plans))),
    }));
  }

  async function restoreTurn(deviceId, input) {
    const { botId, admissionId } = input;
    const admission = store.getTurnAdmission(admissionId);
    if (!admission || admission.deviceId !== deviceId || admission.botId !== botId) {
      throw error('NOT_FOUND', 'Turn admission not found');
    }
    const set = store.getTurnSet(admission.setId);
    if (!set) throw error('TURN_SYNC_FAILED', 'Pinned set is unavailable');
    await assertRestorable(deviceId, set);
    const credentials = Object.fromEntries((set.refs ?? []).map((ref) => [ref, store.resolveCredential(ref)]));
    return emit(set, credentials, grant(admission));
  }

  /** Present authorization, referenced credential revisions and artifact availability for a stored set. */
  async function assertRestorable(deviceId, set) {
    store.assertTurnAuthorization(deviceId, set.botId, set);
    for (const plan of set.plans ?? []) {
      if (!plan.artifactRef) continue;
      try { await packages.readArtifact(plan.artifactRef); }
      catch { throw error('TURN_SYNC_FAILED', 'Pinned artifact is unavailable'); }
    }
    // Recheck authorization after the awaited artifact validation: revocation/rotation during the
    // await must not return the old grant with current credentials.
    store.assertTurnAuthorization(deviceId, set.botId, set);
  }

  /** Scoped historical artifact access: only refs pinned by this device's admission, with current authorization. */
  async function isArtifactAuthorized(deviceId, artifactRef, admissionId) {
    const admission = store.getTurnAdmission(admissionId);
    if (!admission || admission.deviceId !== deviceId) return false;
    const set = store.getTurnSet(admission.setId);
    if (!set || !(set.plans ?? []).some((plan) => plan.artifactRef === artifactRef)) return false;
    try {
      await assertRestorable(deviceId, set);
    } catch {
      return false;
    }
    return true;
  }

  return { prepareTurn, confirmTurn, restoreTurn, isArtifactAuthorized };
}
