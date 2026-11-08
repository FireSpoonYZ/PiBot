// center-server/vault-routes.js
//
// HTTP surface for the center vault service: one owner admin route and the
// paired-device management/find/resolve routes share the same fixed contract.
// The device identity always comes from the authenticated principal — the
// request body can never set it — and resolve stays a device-only endpoint so
// item plaintext never touches the owner API, model tools or generic actions.

export function registerVaultRoutes(app, { route, host, vault }) {
  const control = async (req, reply) => {
    const controller = new AbortController();
    // 'aborted' is a real client abort; a response stream closing before its
    // content finished writing is a disconnect. The request stream's own
    // 'close' fires on every fully-read body — wiring that would cancel
    // every normal request. Both listeners die with this handler, so a
    // keepalive socket never accumulates them across requests.
    const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
    req.raw.on('aborted', cancel);
    reply.raw.on('close', cancel);
    try {
      return await vault.control(req.body, { signal: controller.signal });
    } finally {
      req.raw.off('aborted', cancel);
      reply.raw.off('close', cancel);
    }
  };
  route('POST', '/api/vault/control', control, true);
  host('POST', '/api/host/vault/control', control);
  host('POST', '/api/host/vault/find', req => vault.find({
    ...(req.body && typeof req.body === 'object' ? req.body : {}),
    deviceId: req.centerDevice.deviceId,
  }));
  host('POST', '/api/host/vault/resolve', req => vault.resolve({
    ...(req.body && typeof req.body === 'object' ? req.body : {}),
    deviceId: req.centerDevice.deviceId,
  }));
}
