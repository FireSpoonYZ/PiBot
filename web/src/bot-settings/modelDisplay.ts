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
  t?: (zh: string, en: string) => string;
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
  const t = ctx.t ?? ((zh: string) => zh);
  const rm = bot.resolvedModel;
  const fallbackRef = typeof bot.modelRef === 'string' && bot.modelRef.trim() ? bot.modelRef.trim() : null;

  if (rm?.effectiveModelRef) {
    const name = rm.effectiveModelName || friendlyModelName(rm.effectiveModelRef) || rm.effectiveModelRef;
    if (rm.available === false) {
      return {
        primaryText: t(`${name}（不可用 · 去更换）`, `${name} (unavailable · change)`),
        headerText: t(`${name}（不可用）`, `${name} (unavailable)`),
        tone: 'warn',
        needsCenterBind: false,
      };
    }
    if (rm.source === 'center_default' || rm.source === 'local_default') {
      return {
        primaryText: name,
        badgeText: t('默认', 'Default'),
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
      primaryText: t('未配置 · 扫码绑定中心后可用', 'Not configured · bind Center via QR'),
      headerText: t('未配置模型', 'No model configured'),
      tone: 'muted',
      needsCenterBind: true,
    };
  }

  return {
    primaryText: t('未配置 · 去选择', 'Not configured · select'),
    headerText: t('未配置模型', 'No model configured'),
    tone: 'warn',
    needsCenterBind: false,
  };
}
