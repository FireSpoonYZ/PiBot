export interface BotModelDisplayInput {
  modelRef?: string | null;
  resolvedModel?: {
    effectiveModelRef: string | null;
    effectiveModelName: string | null;
    effectiveProviderName?: string | null;
    source: 'bot' | 'center_default' | 'local_default' | 'unset';
    available: boolean;
  } | null;
}

export interface BotModelDisplayContext {
  connectedToCenter: boolean;
  isLocalOnly?: boolean;
}

export interface FormattedBotModel {
  primaryText: string;
  badgeText?: string;
  headerText: string;
  tone: 'normal' | 'warn' | 'muted';
  needsCenterBind: boolean;
}

function friendlyModelName(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) return trimmed;
  const idx = trimmed.indexOf('/');
  if (idx >= 0 && idx < trimmed.length - 1) {
    return trimmed.slice(idx + 1);
  }
  return trimmed;
}

export function formatBotModelSummary(
  bot: BotModelDisplayInput,
  ctx: BotModelDisplayContext,
): FormattedBotModel {
  const rm = bot.resolvedModel;
  const fallbackRef = typeof bot.modelRef === 'string' && bot.modelRef.trim() ? bot.modelRef.trim() : null;

  if (rm?.effectiveModelRef) {
    const name = rm.effectiveModelName || friendlyModelName(rm.effectiveModelRef) || rm.effectiveModelRef;
    if (rm.available === false) {
      return {
        primaryText: `${name}（不可用 · 去更换）`,
        headerText: `${name}（不可用）`,
        tone: 'warn',
        needsCenterBind: false,
      };
    }
    if (rm.source === 'center_default' || rm.source === 'local_default') {
      return {
        primaryText: name,
        badgeText: '默认',
        headerText: name,
        tone: 'normal',
        needsCenterBind: false,
      };
    }
    return {
      primaryText: name,
      headerText: name,
      tone: 'normal',
      needsCenterBind: false,
    };
  }

  if (!rm && fallbackRef) {
    const name = friendlyModelName(fallbackRef);
    return {
      primaryText: name,
      headerText: name,
      tone: 'normal',
      needsCenterBind: false,
    };
  }

  if (!ctx.connectedToCenter) {
    if (fallbackRef) {
      const name = friendlyModelName(fallbackRef);
      return {
        primaryText: name,
        headerText: name,
        tone: 'normal',
        needsCenterBind: false,
      };
    }
    return {
      primaryText: '未配置 · 扫码绑定中心后可用',
      headerText: '未配置模型',
      tone: 'muted',
      needsCenterBind: true,
    };
  }

  return {
    primaryText: '未配置 · 去选择',
    headerText: '未配置模型',
    tone: 'warn',
    needsCenterBind: false,
  };
}
