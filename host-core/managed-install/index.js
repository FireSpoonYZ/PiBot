import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { digest, extractArtifact, readJson } from './archive.js';

const key = (value) => Buffer.from(value).toString('base64url');
const STATE_SUFFIX = '.state.json';

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

async function readJsonOrNull(file) {
  try { return await readJson(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function runNpm(npmPath, args, cwd) {
  if (!npmPath) throw Object.assign(new Error('npm CLI is unavailable'), { code: 'NPM_UNAVAILABLE' });
  try { await access(npmPath); }
  catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('npm CLI is unavailable'), { code: 'NPM_UNAVAILABLE' });
    throw error;
  }
  const script = /\.[cm]?js$/i.test(npmPath);
  return new Promise((resolve, reject) => {
    const child = spawn(script ? process.execPath : npmPath, script ? [npmPath, ...args] : args, {
      cwd, stdio: 'ignore', shell: false,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') error.code = 'NPM_UNAVAILABLE';
      reject(error);
    });
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('npm preparation failed')));
  });
}

export function openManagedInstaller({ dataRoot, npmPath, fetchArtifact, report, withActivation }) {
  const root = path.join(dataRoot, 'managed-install');
  let queue = Promise.resolve();
  let closed = false;
  const instance = (id) => path.join(root, key(id));
  const currentFile = (id) => path.join(instance(id), 'current.json');
  const versionsDir = (id) => path.join(instance(id), 'versions');
  const dataDir = (id) => path.join(instance(id), 'data');

  const normalizeDigest = (value) => value ?? null;

  function capability(id, packageRoot, { version, manifest = null, planId = null, digest: artifactDigest = null, artifactRef = null }) {
    return { installationId: id, version, packageRoot, dataDir: dataDir(id), manifest, planId, digest: artifactDigest, artifactRef };
  }

  /** 按精确版本/digest 查找已就绪版本目录；目录名与查找键解耦，旧 planId 命名目录仍可命中。 */
  async function findReadyVersion(id, { version, digest: wantedDigest }) {
    let names = [];
    try { names = await readdir(versionsDir(id)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      if (!name.endsWith(STATE_SUFFIX)) continue;
      const file = path.join(versionsDir(id), name);
      const state = await readJsonOrNull(file);
      if (!state || state.status !== 'ready' || state.version !== version) continue;
      if (wantedDigest && normalizeDigest(state.digest) !== normalizeDigest(wantedDigest)) continue;
      const dir = path.join(versionsDir(id), name.slice(0, -STATE_SUFFIX.length));
      try { await access(dir); }
      catch { continue; }
      return { dir, file, state };
    }
    return null;
  }

  /** 旧版缓存命中时补齐缺失元数据：只写 manifest/artifactRef/planId 等缺失字段，
      版本/digest 匹配已由调用方校验，绝不重写包内容或放宽摘要校验。 */
  async function backfillState(file, state, plan) {
    const merged = {
      ...state,
      manifest: state.manifest ?? plan.manifest ?? null,
      artifactRef: state.artifactRef ?? plan.artifactRef ?? null,
      planId: state.planId ?? plan.planId ?? null,
    };
    if (merged.manifest !== state.manifest || merged.artifactRef !== state.artifactRef ||
        merged.planId !== state.planId) {
      await writeJson(file, merged);
    }
    return merged;
  }

  async function getInstalled(id, selector) {
    if (selector?.version) {
      const found = await findReadyVersion(id, selector);
      if (!found) return null;
      // 旧版 state 未存 manifest：current 指针精确同一版本时借用其 manifest。
      let manifest = found.state.manifest ?? null;
      if (!manifest) {
        const current = await readJsonOrNull(currentFile(id));
        if (current && !current.removed && current.version === found.state.version &&
            (!current.digest || !found.state.digest || normalizeDigest(current.digest) === normalizeDigest(found.state.digest))) {
          manifest = current.manifest ?? null;
        }
      }
      return capability(id, found.dir, { version: found.state.version, manifest,
        planId: found.state.planId ?? null, digest: found.state.digest ?? null,
        artifactRef: found.state.artifactRef ?? null });
    }
    const current = await readJsonOrNull(currentFile(id));
    if (!current || current.removed) return null;
    return capability(id, current.packageRoot, { version: current.version, manifest: current.manifest ?? null,
      planId: current.planId ?? null, digest: current.digest ?? null, artifactRef: current.artifactRef ?? null });
  }

  /**
   * 把 plan 的不可变内容准备到 versions/<key(planId)>：
   * 同版本同 digest 已就绪（含其他 planId 目录）直接复用；中断/失败遗留用全新
   * 暂存目录重试，就绪后经 rename 原子发布，不破坏仍被引用的旧版本目录。
   */
  async function stagePlan(plan, { admissionId, onPhase } = {}) {
    const platform = process.env.ANDROID_ROOT ? 'android' : process.platform === 'win32' ? 'windows' : process.platform;
    if (plan.action !== 'disable' && plan.action !== 'uninstall' && plan.kind === 'plugin' &&
        !plan.manifest.platforms.includes(platform)) {
      throw Object.assign(new Error('Package does not support this platform'), { code: 'PLATFORM_UNSUPPORTED' });
    }
    const wantedDigest = normalizeDigest(plan.digest);
    if (wantedDigest) {
      const existing = await findReadyVersion(plan.installationId, { version: plan.targetVersion, digest: wantedDigest });
      if (existing) {
        const state = await backfillState(existing.file, existing.state, plan);
        return { dir: existing.dir, state };
      }
    }
    const versionDir = path.join(versionsDir(plan.installationId), key(plan.planId));
    const prepared = versionDir + STATE_SUFFIX;
    const prior = await readJsonOrNull(prepared);
    if (prior?.status === 'ready' && prior.version === plan.targetVersion &&
        normalizeDigest(prior.digest) === wantedDigest) {
      try {
        await access(versionDir);
        const state = await backfillState(prepared, prior, plan);
        return { dir: versionDir, state };
      } catch { /* 目录丢失时按重新准备处理 */ }
    }
    // 清理由中断准备遗留的暂存目录；不就绪的旧目录在 rename 前一刻才移除。
    let siblings = [];
    try { siblings = await readdir(versionsDir(plan.installationId)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of siblings) {
      if (name.includes('.stage-')) await rm(path.join(versionsDir(plan.installationId), name), { recursive: true, force: true });
    }
    const staging = versionDir + '.stage-' + randomUUID();
    try {
      if (plan.artifactRef) {
        await onPhase?.('downloading');
        const bytes = await fetchArtifact(plan.artifactRef, admissionId ? { admissionId } : undefined);
        if (digest(bytes) !== plan.digest) throw new Error('Artifact digest mismatch');
        await extractArtifact(bytes, staging);
      } else {
        await mkdir(staging, { recursive: true });
      }
      if (plan.lockfile) {
        await onPhase?.('preparing');
        await writeFile(path.join(staging, 'package-lock.json'), JSON.stringify(plan.lockfile));
        // plugin 锁由中心 --legacy-peer-deps 生成，安装用同模式保持一致；
        // mcp/其他 kind 沿用默认解析。
        const ciArgs = plan.kind === 'plugin'
          ? ['ci', '--omit=peer', '--no-audit', '--no-fund', '--legacy-peer-deps']
          : ['ci', '--omit=peer', '--no-audit', '--no-fund'];
        await runNpm(npmPath, ciArgs, staging);
      }
      await rm(versionDir, { recursive: true, force: true });
      await rename(staging, versionDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    const state = { status: 'ready', digest: wantedDigest, version: plan.targetVersion,
      planId: plan.planId ?? null, artifactRef: plan.artifactRef ?? null, manifest: plan.manifest ?? null };
    await writeJson(prepared, state);
    return { dir: versionDir, state };
  }

  /**
   * 仅准备不可变版本内容并返回能力描述；不静默 registry、不激活插件代码，
   * 供回合准入按 admissionId 授权取回旧版本 artifact。
   */
  async function preparePlan(plan, options = {}) {
    const staged = await stagePlan(plan, options);
    await mkdir(dataDir(plan.installationId), { recursive: true });
    return capability(plan.installationId, staged.dir, { version: plan.targetVersion,
      manifest: plan.manifest ?? staged.state.manifest ?? null,
      planId: plan.planId ?? staged.state.planId ?? null,
      digest: normalizeDigest(plan.digest) ?? staged.state.digest ?? null,
      artifactRef: plan.artifactRef ?? staged.state.artifactRef ?? null });
  }

  async function applyPlan(plan) {
    const prior = await getInstalled(plan.installationId);
    let actual = prior?.version ?? null;
    const receipt = (phase, error = null) => ({
      deviceId: plan.deviceId, installationId: plan.installationId, operationId: plan.operationId, planId: plan.planId,
      desiredRevision: plan.desiredRevision, appliedRevision: phase === 'applied' || phase === 'removed' ? plan.desiredRevision : null,
      actualVersion: actual, phase, health: error ? 'unsupported' : phase === 'removed' || (phase === 'applied' && plan.action === 'disable') ? 'disabled' : 'ready', error,
    });
    const emit = async (phase) => { const result = receipt(phase); await report(result); return result; };
    try {
      const appliedPlan = await readJsonOrNull(currentFile(plan.installationId));
      if (appliedPlan?.planId === plan.planId) return await emit(plan.action === 'uninstall' ? 'removed' : 'applied');
      if (plan.action === 'disable' || plan.action === 'uninstall') {
        await emit('waiting-idle');
        const applied = await withActivation(plan.installationId, async () => {
          const current = plan.action === 'disable' && prior
            ? { ...appliedPlan, planId: plan.planId, disabled: true }
            : { planId: plan.planId, removed: true, disabled: plan.action === 'disable' };
          await writeJson(currentFile(plan.installationId), current);
        });
        if (!applied) return receipt('waiting-idle');
        if (plan.action === 'uninstall') actual = null;
        return await emit(plan.action === 'uninstall' ? 'removed' : 'applied');
      }
      const staged = await stagePlan(plan, { onPhase: emit });
      await mkdir(dataDir(plan.installationId), { recursive: true });
      const publish = () => writeJson(currentFile(plan.installationId), {
        planId: plan.planId, removed: false, version: plan.targetVersion, packageRoot: staged.dir,
        manifest: plan.manifest ?? null, digest: normalizeDigest(plan.digest) ?? staged.state.digest ?? null,
        artifactRef: plan.artifactRef ?? staged.state.artifactRef ?? null,
      });
      if (plan.kind === 'plugin') {
        // 原生插件版本目录不可变：直接发布可用性指针，不全局静默；
        // 运行中实例继续持有旧根目录，回合准入在安全边界内再切换。
        await emit('activating');
        await publish();
      } else {
        await emit('waiting-idle');
        const applied = await withActivation(plan.installationId, async () => {
          await emit('activating');
          await publish();
        });
        if (!applied) return receipt('waiting-idle');
      }
      actual = plan.targetVersion;
      return await emit('applied');
    } catch (error) {
      const code = ['NPM_UNAVAILABLE', 'PLATFORM_UNSUPPORTED'].includes(error.code) ? error.code : 'INSTALL_FAILED';
      const message = code === 'NPM_UNAVAILABLE' ? 'npm CLI is unavailable' : code === 'PLATFORM_UNSUPPORTED' ? 'Package does not support this platform' : 'Package deployment failed';
      const result = receipt('failed', { code, message });
      await report(result);
      return result;
    }
  }

  const enqueue = (work) => {
    if (closed) return Promise.reject(new Error('Installer is closed'));
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };

  return {
    apply(plan) { return enqueue(() => applyPlan(plan)); },
    prepare(plan, options) { return enqueue(() => preparePlan(plan, options)); },
    getInstalled,
    async close() { closed = true; await queue; },
  };
}
