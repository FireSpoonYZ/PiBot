import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { yaml } from '../skills/upstream.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'python', 'child.py');
const METHODS = new Set(['agent.run', 'skill.call', 'memory.call', 'schedule.call', 'yaml.parse']);
const MODES = new Set(['review', 'learn', 'curate']);
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;

const err = (code, message) => Object.assign(new Error(message), { code });

/**
 * Run one Bot learning job (review | learn | curate) in a supervised Python
 * child executing the vendored upstream modules. The child drives the real
 * model/tool loop exclusively through onCall callbacks: 'agent.run' (Host),
 * 'skill.call' ({name,args} -> center skill service) and 'memory.call'
 * (optional Hindsight). Protocol is bounded NDJSON on dedicated stdio;
 * signal aborts the job. Always resolves the job result object
 * {summary?, actions?, usage?, result?, error?}; only usage/config contract
 * violations throw before spawn.
 */
export async function runLearningJob({ mode, snapshot, focus, config, stateDir } = {}, { onCall, signal } = {}) {
  if (!MODES.has(mode)) throw err('INVALID_ARGUMENT', 'unknown learning mode: ' + String(mode));
  if (typeof onCall !== 'function') throw err('INVALID_ARGUMENT', 'onCall(method, params) is required');
  if (!stateDir) throw err('INVALID_ARGUMENT', 'stateDir is required');
  if (signal?.aborted) return { error: { code: 'CANCELLED', message: 'cancelled before start' } };
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Keep interpreter overrides from deployments configured before the rename.
  const command = process.env.PIBOT_LEARNING_PYTHON || process.env.HERMES_PYTHON || 'python3';
  const child = spawn(command, ['-B', CHILD], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LEARNING_HOME: stateDir,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  });

  return new Promise((resolve) => {
    let done = false;
    let stdoutBuf = '';
    let stderrTail = '';
    let timer = null;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* gone */ }
      resolve(result);
    };
    const fail = (code, message, extra) => finish({ error: { code, message, ...(extra || {}) } });

    child.stdin.on('error', () => { /* peer gone mid-write */ });
    const writeLine = (obj) => {
      const data = JSON.stringify(obj) + '\n';
      if (Buffer.byteLength(data, 'utf8') > MAX_LINE_BYTES) return false;
      try { child.stdin.write(data); return true; } catch { return false; }
    };
    const send = (obj) => {
      if (!writeLine(obj)) fail('PAYLOAD_TOO_LARGE', 'outbound learning frame exceeded byte bound');
    };
    // A call response that outgrows the bound degrades to an error frame
    // instead of killing the whole job.
    const respond = (id, result, error) => {
      const frame = error ? { type: 'response', id, error } : { type: 'response', id, result };
      if (!writeLine(frame)) {
        writeLine({ type: 'response', id, error: { code: 'PAYLOAD_TOO_LARGE', message: 'response exceeded byte bound' } });
      }
    };
    const onAbort = () => {
      writeLine({ type: 'cancel' });
      fail('CANCELLED', 'learning job cancelled');
    };

    const answerCall = (msg) => {
      const id = msg.id;
      if (!METHODS.has(msg.method)) {
        respond(id, null, { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed: ' + String(msg.method) });
        return;
      }
      Promise.resolve()
        .then(() => {
          if (msg.method !== 'yaml.parse') return onCall(msg.method, msg.params);
          const source = msg.params?.source;
          if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > 256 * 1024) {
            throw err('INVALID_ARGUMENT', 'invalid YAML document');
          }
          const parsed = yaml().parse(source, { maxAliasCount: 100 });
          return parsed === undefined ? null : JSON.parse(JSON.stringify(parsed));
        })
        .then(
          (result) => respond(id, result ?? null),
          (e) => respond(id, null, { code: e?.code || 'CALL_FAILED', message: String(e?.message || e) }),
        );
    };

    const handleLine = (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'call') { answerCall(msg); return; }
      if (msg.type === 'result') { finish(msg.result && typeof msg.result === 'object' ? msg.result : { result: msg.result }); return; }
      // 'log' and unknown frames are protocol noise: ignored by design.
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (done) return;
      stdoutBuf += chunk;
      if (Buffer.byteLength(stdoutBuf, 'utf8') > MAX_LINE_BYTES && !stdoutBuf.includes('\n')) {
        fail('PAYLOAD_TOO_LARGE', 'learning protocol line exceeded ' + MAX_LINE_BYTES + ' bytes');
        return;
      }
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) { fail('PAYLOAD_TOO_LARGE', 'learning protocol line exceeded ' + MAX_LINE_BYTES + ' bytes'); return; }
        if (line.trim()) handleLine(line);
        if (done) return;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (e) => fail('PYTHON_UNAVAILABLE', 'failed to spawn ' + command + ': ' + e.message, { stderr: stderrTail }));
    let exitInfo = null;
    child.on('exit', (code, sig) => { exitInfo = { code, sig }; });
    child.on('close', (code, sig) => {
      if (!done) fail('LEARNING_EXIT', 'python exited before result (code=' + (exitInfo?.code ?? code) + ', signal=' + (exitInfo?.sig ?? sig) + ')', { exitCode: exitInfo?.code ?? code, exitSignal: exitInfo?.sig ?? sig, stderr: stderrTail });
    });

    const timeoutMs = config?.timeoutMs ?? config?.maxDurationMs;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => { send({ type: 'cancel' }); fail('TIMEOUT', 'learning job exceeded ' + timeoutMs + 'ms'); }, timeoutMs);
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();  // aborted inside the mkdir/spawn window
    }

    send({ type: 'init', job: { mode, snapshot: snapshot || {}, focus: focus ?? null, config: config || {}, stateDir } });
  });
}

export default runLearningJob;
