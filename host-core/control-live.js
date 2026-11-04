// 模块 6：Bot 主会话/远端工作上下文实时预览。GET /v1/bots/:botId/live 与 work live
// 经已认证本机 SSE 推送快照/更新/结束帧；观察生命周期只绑定 res close 与 req aborted，
// 绝不误停正常 GET。反压只在 drain 复位时补发最新完整快照，不积压中间更新，也不阻塞
// 运行时监听器。work live 帧由 watch.value 生成（含 scopeId，绑定前 conversationId 可为 null）。

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};
const HEARTBEAT_MS = 15000;
const END_REASONS = new Set(['stopped', 'cancelled', 'session_closed', 'retired', 'listener_error', 'session_failed']);

/**
 * SSE 处理器：在 watch 成功后才写 SSE 头，因此 bot/auth 错误仍由
 * dispatch 输出 JSON 错误。返回的 promise 在连接结束时才 resolve，宿主现有
 * inflight 跟踪与 server.closeAllConnections 因此能完整接管订阅释放。
 */
function serveLive(req, res, getWatch) {
  return new Promise((resolve, reject) => {
    (async () => {
      const watch = await getWatch();
      try {
        if (req.readableAborted || req.socket.destroyed || res.destroyed) {
          // early exit：尚未开始观察就断连，停止观察后必须 settle，避免挂起。
          await watch.stop().catch(() => {});
          resolve();
          return;
        }

        res.writeHead(200, SSE_HEADERS);
        res.flushHeaders();
        // SSE 长驻连接：仅本响应/本 socket 关闭超时，不改服务器级默认超时。
        res.setTimeout(0);
        req.socket.setTimeout(0);

        let settled = false;
        let blocked = false;
        let needReset = false;
        let receivedFrame = false;
        let pendingEnd = null;
        let heartbeat = null;

        const writeFrame = (frame) => {
          if (res.destroyed || res.writableEnded) return true;
          try {
            return res.write('event: bot-live\ndata: ' + JSON.stringify(frame) + '\n\n');
          } catch {
            finish();
            return true;
          }
        };

        const snapshotFrame = () => ({
          type: 'snapshot',
          botId: watch.value.botId,
          scopeId: watch.value.scopeId,
          conversationId: watch.value.conversationId,
          sequence: watch.value.sequence,
          state: watch.value.state,
        });

        const finish = (endFrame) => {
          if (settled) return;
          settled = true;
          clearInterval(heartbeat);
          req.removeListener('aborted', onAborted);
          res.removeListener('close', onClosed);
          res.removeListener('drain', onDrain);
          res.removeListener('error', onError);
          // end 帧由 closed.reason 生成，仅 best effort；写失败即忽略。
          if (endFrame) writeFrame(endFrame);
          // 只停止观察者，绝不动 runtime/提交工作；跟踪释放但不等待用户回调。
          watch.stop().catch(() => {});
          try { res.end(); } catch { res.destroy(); }
          resolve();
        };

        const maybeFinishEnded = () => {
          if (pendingEnd === null || settled) return;
          if (!receivedFrame) {
            // 会话先于 start 回调结束：start 可能永不回调，不能一直等首帧。
            // 用 watch.value 补一帧快照再 best-effort end，保证 initial snapshot 必达。
            receivedFrame = true;
            blocked = !writeFrame(snapshotFrame());
          }
          const end = pendingEnd;
          pendingEnd = null;
          finish(end);
        };

        const onFrame = (frame) => {
          if (settled) return;
          receivedFrame = true;
          // 不等待 drain：监听器立即返回；合并期间的中间更新由复位快照覆盖。
          if (blocked) { needReset = true; return; }
          blocked = !writeFrame(frame);
          maybeFinishEnded();
        };

        const onDrain = () => {
          if (settled) return;
          blocked = false;
          if (!needReset) return;
          needReset = false;
          blocked = !writeFrame(snapshotFrame());
        };

        const onClosed = () => finish();
        const onAborted = () => finish();
        const onError = () => finish();

        heartbeat = setInterval(() => {
          // 反压期间跳过 heartbeat，不再向已积压 socket 追加字节。
          if (settled || blocked) return;
          try {
            if (!res.destroyed && !res.writableEnded) {
              blocked = !res.write(': heartbeat\n\n');
            }
          } catch { finish(); }
        }, HEARTBEAT_MS);
        heartbeat.unref();

        res.on('drain', onDrain);
        res.on('close', onClosed);
        res.on('error', onError);
        req.on('aborted', onAborted);

        const endFrame = (reason) => ({
          type: 'end',
          botId: watch.value.botId,
          scopeId: watch.value.scopeId,
          conversationId: watch.value.conversationId,
          sequence: watch.value.sequence,
          reason,
        });

        watch.closed.then(
          (end) => {
            if (settled) return;
            pendingEnd = endFrame(END_REASONS.has(end?.reason) ? end.reason : 'session_failed');
            maybeFinishEnded();
          },
          () => {
            if (settled) return;
            pendingEnd = endFrame('session_failed');
            maybeFinishEnded();
          },
        );

        if (!settled) {
          try {
            watch.start(onFrame);
          } catch {
            // 头已发送：启动失败不能回退 JSON 错误，只停止观察并关闭连接。
            finish();
          }
        }
      } catch (err) {
        // await watch 之后的任何异常都先释放观察：未发头时回退 JSON 错误，
        // 已发头则直接关闭，绝不头后再退 JSON。
        await watch.stop().catch(() => {});
        if (res.headersSent) {
          res.destroy();
          resolve();
        } else {
          throw err;
        }
      }
    })().catch(reject);
  });
}

export function serveBotLive(req, res, runtime, botId) {
  return serveLive(req, res, () => runtime.watch(botId, {}));
}

export function serveWorkLive(req, res, runtime, botId, scopeId) {
  return serveLive(req, res, () => runtime.watchWork(botId, scopeId, {}));
}
