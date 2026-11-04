export async function collectBotDirectory({ listDevices, listBots }) {
  const devices = [];
  let cursor = null;
  do {
    const page = await listDevices({ limit: 200, cursor });
    devices.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  const botsByDevice = new Array(devices.length);
  const errorsByDevice = new Array(devices.length);
  let next = 0;
  async function readDevices() {
    while (next < devices.length) {
      const index = next++;
      const device = devices[index];
      if (!device.online) continue;
      try {
        const bots = await listBots(device.deviceId);
        botsByDevice[index] = bots.map((bot) => ({
          ...bot,
          description: bot.description ?? '',
          isPrimary: Boolean(bot.isPrimary),
          lastActivityAt: bot.lastActivityAt ?? null,
          lastPreview: bot.lastPreview ?? null,
          archivedAt: bot.archivedAt ?? null,
          deviceName: device.displayName || device.deviceId,
          ...(device.platform ? { platform: device.platform } : {}),
          online: true,
        }));
      } catch (err) {
        errorsByDevice[index] = {
          deviceId: device.deviceId,
          code: typeof err?.code === 'string' ? err.code : 'INTERNAL',
          ...(typeof err?.message === 'string' ? { message: err.message } : {}),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, devices.length) }, readDevices));
  const bots = botsByDevice.flatMap((items) => items ?? []);
  bots.sort((a, b) => {
    const aArchived = a.archivedAt !== null && a.archivedAt !== undefined;
    const bArchived = b.archivedAt !== null && b.archivedAt !== undefined;
    if (aArchived !== bArchived) return aArchived ? 1 : -1;
    const aPrimary = a.isPrimary === true;
    const bPrimary = b.isPrimary === true;
    if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
    const aTime = Date.parse(a.lastActivityAt || a.createdAt || '') || 0;
    const bTime = Date.parse(b.lastActivityAt || b.createdAt || '') || 0;
    if (bTime !== aTime) return bTime - aTime;
    return a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0;
  });
  return { devices, bots, errors: errorsByDevice.filter(Boolean) };
}
