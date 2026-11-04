// gbot-ui lane：群聊组合头像。
// 布局复制自 lenML/gbot-ui（MIT，仓库 licenses/gbot-ui-MIT.txt）：
// 上游 src/components/grok-bot/AgentAvatar.tsx 的 group 分支（超 4 人取前三 + 剩余数量），
// 成员位格 CSS 见 gbot-ui.css（对应上游 src/styles/avatar.css 的 __group 规则）。
// 差异：成员徽标用本仓库 GrokBotAvatar 与既有 resolveBotAvatarPreset 种子约定，
// 不复用上游 GrokBotAvatarMark。
import type { MessageMember } from '../../../host-core/index.js';
import type { BotRecord } from '../../../host-core/index.js';
import { GrokBotAvatar, resolveBotAvatarPreset } from '../GrokBotAvatar';

export interface ConversationGroupAvatarProps {
  members: MessageMember[];
  /** 已知 Bot 目录（用于成员定制头像）；成员缺席时退回稳定种子预设。 */
  bots?: readonly Pick<BotRecord, 'deviceId' | 'botId' | 'role' | 'isPrimary'>[];
  size?: number;
}

/** 与 Scopes.tsx memberAvatar 同一匹配约定：命中定制/角色预设，否则 deviceId:botId 种子。 */
function memberPreset(
  member: MessageMember,
  bots: readonly Pick<BotRecord, 'deviceId' | 'botId' | 'role' | 'isPrimary'>[],
) {
  const known = bots.find(
    (b) => b.deviceId === member.deviceId && b.botId === member.botId,
  );
  return known
    ? resolveBotAvatarPreset(known.deviceId + ':' + known.botId, known.role, known.isPrimary)
    : resolveBotAvatarPreset(member.deviceId + ':' + member.botId, member.botId, false);
}

export function ConversationGroupAvatar({
  members,
  bots = [],
  size = 40,
}: ConversationGroupAvatarProps) {
  // 超 4 成员：前三位头像 + 剩余数量徽标（数量 = members.length - 3，覆盖第 4 格）。
  const showMore = members.length > 4;
  const slots = showMore ? members.slice(0, 3) : members.slice(0, 4);
  const moreCount = members.length - 3;
  const cellSize = Math.max(16, Math.round(size * 0.42));

  return (
    <span
      aria-hidden="true"
      className="gbot-group-avatar"
      style={{ width: size, height: size }}
    >
      <span
        className="gbot-group-avatar__surface"
        data-count={slots.length + (showMore ? 1 : 0)}
      >
        {slots.map((member, index) => (
          <span
            className="gbot-group-avatar__cell"
            data-slot={index}
            key={member.deviceId + ':' + member.botId}
          >
            <GrokBotAvatar preset={memberPreset(member, bots)} size={cellSize} />
          </span>
        ))}
        {showMore ? (
          <span
            className="gbot-group-avatar__more"
            style={{ fontSize: Math.max(8, Math.round(size * 0.22)) }}
          >
            +{moreCount}
          </span>
        ) : null}
      </span>
    </span>
  );
}
