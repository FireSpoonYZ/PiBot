// 单 Bot 模型配置页：模型选择（默认全量 + 收藏置顶）-> 智能联动思考强度 -> 默认折叠的工具调用方式。
// 所有修改点击即存（乐观更新 + CAS 串行提交），无保存草稿栏与密码墙。
import { ExternalLink } from 'lucide-react';
import type { ModelCatalogEntry } from '../../../host-core/index.js';
import { ANTIGRAVITY_PROVIDER_ID } from '../../../center-contract/antigravity.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ActionBar } from '../components/ui';
import { openCenterManagement } from '../native';
import { ErrorNotice, errorText, useText } from '../ui';
import { ModelPicker } from './ModelPicker';
import { Badge, Chips, Disclosure, LoadingState, Row, Section, SettingsSheet, StatusLine, type ChoiceOption } from './primitives';
import { toolModeFromSelection, type BotModelConfigState, type ToolMode } from './useBotModelConfig';
import './model-settings.css';

const INHERIT = '__inherit';
const STANDARD_THINKING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const;

export interface ModelSettingsPageProps {
  state: BotModelConfigState;
  api?: DesktopPanelApi;
  identity?: DesktopIdentity;
  onClose?: () => void;
  onOpenCenterAdmin?: () => void;
}

export function ModelSettingsPage({
  state,
  api,
  identity,
  onClose,
  onOpenCenterAdmin,
}: ModelSettingsPageProps) {
  const t = useText();
  const { config, catalog, draft, busy } = state;
  const models: ModelCatalogEntry[] = catalog?.models ?? [];

  const levelLabel = (level: string) => {
    switch (level) {
      case 'off': return t('关闭', 'Off');
      case 'minimal': return t('极低', 'Minimal');
      case 'low': return t('低', 'Low');
      case 'medium': return t('中', 'Medium');
      case 'high': return t('高', 'High');
      case 'xhigh': return t('很高', 'X-High');
      case 'max': return t('最高', 'Max');
      default: return level;
    }
  };

  const toolModeLabel = (mode: Exclude<ToolMode, 'inherit'>) => {
    switch (mode) {
      case 'standard': return t('标准工具调用', 'Standard tool calling');
      case 'codemode': return t('代码编排 (Code Mode)', 'Code Mode');
      case 'codemode_only': return t('仅代码编排（省上下文）', 'Code Mode only (compact context)');
    }
  };

  const openCenterProviders = () => {
    if (onOpenCenterAdmin) {
      onOpenCenterAdmin();
      return;
    }
    void openCenterManagement().catch(failure => state.setError(errorText(failure)));
  };

  const effectiveModelRef =
    typeof draft.modelRef === 'string' && draft.modelRef.trim()
      ? draft.modelRef
      : (config?.global.modelRef ?? config?.effective.modelRef ?? null);

  const effectiveModelEntry = effectiveModelRef
    ? (models.find(model => model.modelRef === effectiveModelRef) as (ModelCatalogEntry & { providerName?: string; available?: boolean }) | undefined)
    : undefined;

  const effectiveProvider = effectiveModelEntry?.providerName?.trim()
    || (effectiveModelRef && effectiveModelRef.includes('/') ? effectiveModelRef.slice(0, effectiveModelRef.indexOf('/')) : '');
  const effectiveModelName = effectiveModelEntry?.name
    ?? (effectiveModelRef ? (effectiveModelRef.split('/').pop() ?? effectiveModelRef) : '');
  const effectiveUnavailable = effectiveModelEntry?.available === false;
  const isCustomModel = typeof draft.modelRef === 'string' && draft.modelRef.trim().length > 0;

  const showThinking = Boolean(
    config
    && effectiveModelRef
    && (effectiveModelEntry ? effectiveModelEntry.reasoning !== false : true),
  );

  const thinkingOptions: ChoiceOption<string>[] = config
    ? [
        {
          value: INHERIT,
          label: t('默认', 'Default'),
          hint: config.global.thinkingLevel ? levelLabel(config.global.thinkingLevel) : undefined,
        },
        ...(typeof draft.thinkingLevel === 'string'
          && !(STANDARD_THINKING_LEVELS as readonly string[]).includes(draft.thinkingLevel)
          ? [{ value: draft.thinkingLevel, label: levelLabel(draft.thinkingLevel) }]
          : []),
        ...STANDARD_THINKING_LEVELS.map(level => ({
          value: level,
          label: levelLabel(level),
        })),
      ]
    : [];

  const thinkingValue =
    typeof draft.thinkingLevel === 'string' && draft.thinkingLevel.trim()
      ? draft.thinkingLevel
      : INHERIT;

  const isAntigravity = effectiveModelRef?.startsWith(ANTIGRAVITY_PROVIDER_ID + '/') === true;
  const currentToolMode = isAntigravity ? 'codemode_only' : toolModeFromSelection(draft);
  const globalToolMode = toolModeFromSelection(config?.global);
  const resolvedGlobalToolMode: Exclude<ToolMode, 'inherit'> =
    globalToolMode === 'inherit' ? 'standard' : globalToolMode;

  const toolModeSummary =
    currentToolMode === 'inherit'
      ? `${t('跟随全局默认', 'Default')}（${toolModeLabel(resolvedGlobalToolMode)}）`
      : toolModeLabel(currentToolMode);

  const renderReadinessSummary = () => {
    if (!config) return null;
    const tone = state.saving
      ? 'accent'
      : !effectiveModelRef || effectiveUnavailable
        ? 'warning'
        : 'success';
    const summaryText = effectiveModelName
      ? effectiveProvider
        ? `${t('当前生效模型：', 'Active model: ')}${effectiveModelName} · ${effectiveProvider}`
        : `${t('当前生效模型：', 'Active model: ')}${effectiveModelName}`
      : t('尚未设置生效模型，请在下方选择或前往中心配置。', 'No active model configured. Select one below or configure in Center.');
    const trailing = state.saving ? (
      <span className="bs-save-status" aria-live="polite">{t('保存中...', 'Saving...')}</span>
    ) : state.notice ? (
      <span className="bs-save-status" aria-live="polite">✓ {state.notice}</span>
    ) : effectiveUnavailable ? (
      <Badge tone="warning">{t('不可用', 'Unavailable')}</Badge>
    ) : effectiveModelRef ? (
      <Badge tone={isCustomModel ? 'accent' : 'neutral'}>
        {isCustomModel ? t('本 Bot 覆盖', 'Custom') : t('全局默认', 'Global default')}
      </Badge>
    ) : (
      <Badge tone="warning">{t('未配置', 'Unconfigured')}</Badge>
    );

    return (
      <StatusLine tone={tone} trailing={trailing}>
        {summaryText}
      </StatusLine>
    );
  };

  const renderAuthGuidance = () => {
    if (state.oauthRevoked) {
      return (
        <div className="bs-auth-note">
          <span>{t('当前中心授权已失效，请在设备设置中重新扫码绑定中心后重试。', 'Center authorization expired. Please re-bind with the center QR code and retry.')}</span>
          <ActionBar align="start" className="bs-auth-note-actions">
            <button type="button" className="bs-btn is-small" disabled={busy} onClick={() => void state.reload()}>
              {t('重新读取配置', 'Reload settings')}
            </button>
          </ActionBar>
        </div>
      );
    }
    if (state.notConnected) {
      return (
        <div className="bs-auth-note">
          <span>{t('当前设备尚未绑定或连接中心，扫码绑定后即可为 Bot 分配模型。', 'Device is not connected to a center yet. Bind to a center to configure models.')}</span>
        </div>
      );
    }
    return null;
  };

  const renderModelSection = () => {
    if (!config) return null;
    const selectedValue = typeof draft.modelRef === 'string' ? draft.modelRef : undefined;
    const globalName = config.global.modelRef
      ? (models.find(m => m.modelRef === config.global.modelRef)?.name
        ?? config.global.modelRef.split('/').pop()
        ?? config.global.modelRef)
      : undefined;

    return (
      <Section title={t('模型选择', 'Model')} bare>
        {catalog && api && identity ? (
          <ModelPicker
            catalog={catalog}
            api={api}
            identity={identity}
            value={selectedValue}
            onChange={modelRef => void state.selectModelRef(modelRef)}
            onStarsChange={state.setStarredModels}
            disabled={busy}
            allowInherit
            globalDefaultModelRef={config.global.modelRef}
            onSelectInherit={() => void state.selectModelRef(undefined)}
            onOpenCenterAdmin={openCenterProviders}
          />
        ) : (
          <div className="bs-card">
            <Row
              radio
              selected={selectedValue === undefined}
              disabled={busy}
              title={t('跟随全局默认', 'Follow global default')}
              subtitle={
                globalName
                  ? `${t('当前默认：', 'Current default: ')}${globalName}`
                  : t('当前全局未设置默认模型', 'No global default model configured')
              }
              onClick={() => void state.selectModelRef(undefined)}
            />
            {models.map(model => (
              <Row
                key={model.modelRef}
                radio
                selected={selectedValue === model.modelRef}
                disabled={busy}
                title={model.name}
                subtitle={model.modelRef}
                onClick={() => void state.selectModelRef(model.modelRef)}
              />
            ))}
          </div>
        )}

        {models.length > 0 ? (
          <ActionBar align="start">
            <button
              type="button"
              className="bs-link bs-model-link"
              onClick={openCenterProviders}
            >
              {t('管理模型与服务商', 'Manage models & providers')}
              <ExternalLink aria-hidden="true" />
            </button>
          </ActionBar>
        ) : null}
      </Section>
    );
  };

  const renderThinkingSection = () => {
    if (!showThinking) return null;
    return (
      <Section
        title={t('思考强度', 'Thinking level')}
        bare
        hint={t('越高越慎重、耗时越长；点击立即生效。', 'Higher is more deliberate; applies immediately on click.')}
      >
        <Chips
          label={t('思考强度', 'Thinking level')}
          value={thinkingValue}
          options={thinkingOptions}
          disabled={busy}
          onChange={value => void state.selectThinkingLevel(value === INHERIT ? undefined : value)}
        />
      </Section>
    );
  };

  const renderToolModeSection = () => {
    if (!config) return null;
    const options: Array<{ mode: ToolMode; title: string; subtitle: string }> = [
      {
        mode: 'inherit',
        title: t('跟随全局默认', 'Follow global default'),
        subtitle: `${t('当前默认：', 'Current default: ')}${toolModeLabel(resolvedGlobalToolMode)}`,
      },
      {
        mode: 'standard',
        title: t('标准工具调用', 'Standard tool calling'),
        subtitle: t('常规单步/多步工具声明与调用', 'Standard structured tool calls'),
      },
      {
        mode: 'codemode',
        title: t('代码编排 (Code Mode)', 'Code Mode'),
        subtitle: t('允许生成脚本批量编排工具，同时保留标准工具', 'Allows code orchestration alongside standard tools'),
      },
      {
        mode: 'codemode_only',
        title: t('仅代码编排（省上下文）', 'Code Mode only (compact context)'),
        subtitle: t('仅暴露代码执行入口，显著降低工具定义占用', 'Exposes only code execution to save context tokens'),
      },
    ];

    return (
      <Disclosure
        title={t('高级工具调用方式', 'Advanced tool calling')}
        summary={toolModeSummary}
        defaultOpen={false}
      >
        <div className="bs-card">
          {options.map(option => (
            <Row
              key={option.mode}
              radio
              selected={currentToolMode === option.mode}
              disabled={busy || isAntigravity}
              title={option.title}
              subtitle={option.subtitle}
              onClick={() => void state.selectToolMode(option.mode)}
            />
          ))}
        </div>
      </Disclosure>
    );
  };

  const content = (
    <>
      {state.loading ? <LoadingState /> : null}
      {renderAuthGuidance()}
      <ErrorNotice error={state.error} onDismiss={state.dismissError} />
      {renderReadinessSummary()}
      {renderModelSection()}
      {isAntigravity ? <p className="bs-muted">{t('Antigravity 会话内可直接切换其他 Antigravity 模型；跨服务商切换模型后无法继续原对话，需先 /clear 开启新会话。工具调用固定使用代码编排，历史不能编辑。',
        'You can switch between Antigravity models within the same session. After switching across providers, continuing the previous conversation will fail until you run /clear. Tool calling uses Code Mode and history cannot be edited.')}</p> : null}
      {renderThinkingSection()}
      {renderToolModeSection()}
    </>
  );

  if (onClose) {
    return (
      <SettingsSheet title={t('模型设置', 'Model')} onClose={onClose}>
        {content}
      </SettingsSheet>
    );
  }

  return <div className="bs-inline-panel">{content}</div>;
}
