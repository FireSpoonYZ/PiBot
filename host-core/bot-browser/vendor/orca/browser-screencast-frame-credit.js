// From stablyai/orca v1.4.267. Copyright (c) 2026 Lovecast Inc. See ./LICENSE.
const BASE_WINDOW_FRAMES = 2;
const MAX_WINDOW_FRAMES = 16;
const QUEUE_DELAY_ALLOWANCE_MS = 100;
const STALL_PROBE_MS = 2e3;
const STALL_PROBE_MAX_MS = 8e3;
function createBrowserScreencastFrameCredit(options) {
  const inFlight = [];
  let minRttMs = null;
  let probeDelayMs = STALL_PROBE_MS;
  let probeTimer = null;
  let probeReady = false;
  const clearProbe = () => {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  };
  const armProbe = () => {
    if (probeTimer) {
      return;
    }
    probeTimer = setTimeout(() => {
      probeTimer = null;
      probeReady = true;
      probeDelayMs = Math.min(probeDelayMs * 2, STALL_PROBE_MAX_MS);
      options.onCreditAvailable();
    }, probeDelayMs);
  };
  const hasCredit = () => {
    if (probeReady || inFlight.length < BASE_WINDOW_FRAMES) {
      return true;
    }
    if (inFlight.length >= MAX_WINDOW_FRAMES || minRttMs === null) {
      return false;
    }
    return Date.now() - inFlight[0].sentAt < minRttMs + QUEUE_DELAY_ALLOWANCE_MS;
  };
  return {
    canSend() {
      if (hasCredit()) {
        return true;
      }
      armProbe();
      return false;
    },
    recordSent(seq) {
      probeReady = false;
      inFlight.push({ seq, sentAt: Date.now() });
      if (inFlight.length > MAX_WINDOW_FRAMES) {
        inFlight.shift();
      }
    },
    acknowledge(seq) {
      let count = 0;
      while (count < inFlight.length && inFlight[count].seq <= seq) {
        count += 1;
      }
      if (count === 0) {
        return;
      }
      const newest = inFlight[count - 1];
      if (newest.seq === seq) {
        const rtt = Date.now() - newest.sentAt;
        minRttMs = minRttMs === null ? rtt : Math.min(minRttMs, rtt);
      }
      inFlight.splice(0, count);
      clearProbe();
      probeDelayMs = STALL_PROBE_MS;
      options.onCreditAvailable();
    },
    dispose: clearProbe
  };
}
const creditedSubscriptions = /* @__PURE__ */ new Map();
function registerBrowserScreencastFrameCredit(subscriptionId, pairedDeviceId, credit) {
  const entry = { pairedDeviceId, credit };
  creditedSubscriptions.set(subscriptionId, entry);
  return () => {
    if (creditedSubscriptions.get(subscriptionId) === entry) {
      creditedSubscriptions.delete(subscriptionId);
    }
    credit.dispose();
  };
}
function acknowledgeBrowserScreencastFrame(subscriptionId, pairedDeviceId, seq) {
  const entry = creditedSubscriptions.get(subscriptionId);
  if (!entry || entry.pairedDeviceId !== pairedDeviceId) {
    return false;
  }
  entry.credit.acknowledge(seq);
  return true;
}
export {
  acknowledgeBrowserScreencastFrame,
  createBrowserScreencastFrameCredit,
  registerBrowserScreencastFrameCredit
};
