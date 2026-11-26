import type { BotAvatar } from '../../../../center-contract/index.js';
import type { DesktopPetSnapshot } from './protocol.ts';

export interface ResolvedPetAvatarState {
  avatar: BotAvatar | null;
  seedKey: string;
}

export interface PetAvatarResolver {
  resolvePreset: (botKey: string, roleName?: string, isPrimary?: boolean) => BotAvatar;
  getDefaultPreset: (botKey: string, roleName?: string, isPrimary?: boolean) => BotAvatar;
}

export const INITIAL_RESOLVED_PET_AVATAR_STATE: ResolvedPetAvatarState = {
  avatar: null,
  seedKey: '',
};

export function sameBotAvatar(a: BotAvatar | null, b: BotAvatar | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.shape === b.shape &&
    a.color === b.color &&
    a.rotation === b.rotation &&
    a.expressionIndex === b.expressionIndex
  );
}

/**
 * Resolves the pet's display avatar without falling back to the default blue circle
 * before the primary bot's authoritative avatar has been loaded.
 * Once a real avatar has been resolved, transient reconnect/reload snapshots with
 * `avatarReady: false` retain the previous avatar instead of flashing a placeholder.
 */
export function resolvePetAvatarState(
  snapshot: Pick<
    DesktopPetSnapshot,
    'deviceId' | 'botId' | 'botName' | 'avatar' | 'avatarReady' | 'avatarRevision'
  >,
  previous: ResolvedPetAvatarState,
  resolver: PetAvatarResolver,
): ResolvedPetAvatarState {
  if (!snapshot.avatarReady) {
    return previous;
  }

  const key = snapshot.deviceId && snapshot.botId ? `${snapshot.deviceId}:${snapshot.botId}` : '';
  const seedKey = key || 'desktop-pet';
  let nextAvatar: BotAvatar;
  if (snapshot.avatar && snapshot.avatar.shape && snapshot.avatar.color) {
    nextAvatar = snapshot.avatar;
  } else if (typeof snapshot.avatarRevision === 'number' && snapshot.avatarRevision > 0) {
    // Center explicitly reset the avatar to default (revision > 0, value === null);
    // do not revive a stale localStorage entry before BotChats syncs.
    nextAvatar = resolver.getDefaultPreset(key, snapshot.botName, true);
  } else {
    nextAvatar = resolver.resolvePreset(key, snapshot.botName, true);
  }

  if (previous.seedKey === seedKey && sameBotAvatar(previous.avatar, nextAvatar)) {
    return previous;
  }
  return { avatar: nextAvatar, seedKey };
}
