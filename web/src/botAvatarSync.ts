import type { BotAvatarConfig } from '../../center-contract/index.js';
import type { BotDirectoryEntry } from '../../host-core/index.js';
import type { DesktopPanelApi } from '../../desktop/web/src/types';
import {
  getSavedAvatarConfigMap,
  resetBotAvatarConfig,
  saveBotAvatarConfig,
  type GrokAvatarPreset,
} from './GrokBotAvatar';

export function botAvatarKey(bot: { deviceId: string; botId: string }): string {
  return `${bot.deviceId}:${bot.botId}`;
}

const cached = new Map<string, BotAvatarConfig>();

function cacheAvatar(key: string, config: BotAvatarConfig): BotAvatarConfig {
  const previous = cached.get(key);
  if (previous && previous.revision >= config.revision) return previous;
  if (config.value) saveBotAvatarConfig(key, config.value);
  else resetBotAvatarConfig(key);
  cached.set(key, config);
  return config;
}

export async function saveCentralBotAvatar(
  api: DesktopPanelApi,
  bot: { deviceId: string; botId: string },
  value: GrokAvatarPreset | null,
): Promise<void> {
  const identity = api.identity;
  if (!identity) throw new Error('请先连接中心，再保存头像');
  const key = botAvatarKey(bot);
  const config = await api.broker(identity, 'center_bot_avatar_set', {
    deviceId: bot.deviceId, botId: bot.botId,
    expectedRevision: cached.get(key)?.revision ?? 0,
    value,
  });
  cacheAvatar(key, config);
}

/** Import old client-only overrides once; any center revision, including a reset, wins. */
export async function syncBotAvatarConfigs(
  api: DesktopPanelApi,
  bots: BotDirectoryEntry[],
  currentDeviceId: string,
): Promise<void> {
  const identity = api.identity;
  if (!identity) return;
  const saved = getSavedAvatarConfigMap();
  for (const bot of bots) {
    if (bot.avatarRevision === undefined) continue;
    const key = botAvatarKey(bot);
    let config: BotAvatarConfig = { value: bot.avatar ?? null, revision: bot.avatarRevision };
    if (config.revision === 0 && !cached.get(key)?.revision) {
      const legacyKeys = [
        key,
        ...(bot.deviceId === currentDeviceId ? [`local:local:${bot.botId}`] : []),
        `remote:${identity.profileId}:${bot.deviceId}:${bot.botId}`,
        ...Object.keys(saved).filter(oldKey => oldKey.startsWith('remote:') && oldKey.endsWith(`:${key}`)),
        ...(bots.filter(item => item.botId === bot.botId).length === 1
          ? [`remote:${identity.profileId}:${bot.botId}`] : []),
      ];
      const legacy = legacyKeys.map(oldKey => saved[oldKey]).find(Boolean);
      if (legacy) {
        try {
          config = await api.broker(identity, 'center_bot_avatar_set', {
            deviceId: bot.deviceId, botId: bot.botId, expectedRevision: 0, value: legacy,
          });
        } catch (error) {
          if ((error as { code?: string }).code !== 'REQUEST_CONFLICT') throw error;
          config = await api.broker(identity, 'center_bot_avatar_get', {
            deviceId: bot.deviceId, botId: bot.botId,
          });
        }
      }
    }
    config = cacheAvatar(key, config);
    bot.avatar = config.value;
    bot.avatarRevision = config.revision;
  }
}
