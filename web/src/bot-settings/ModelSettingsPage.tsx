// Bot 模型页：当前生效摘要 + 模型单选 + 思考强度 + 服务商入口，底部统一保存栏。
// 数据与草稿由 useBotModelConfig 提供；“显式清空”只在高级设置页切换，本页仅提示并允许恢复。
import { ExternalLink } from 'lucide-react';
import type { ModelCatalogEntry } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ModelPicker } from './ModelPicker';
import { openCenterManagement } from '../native';
import { ErrorNotice, errorText, useText } from '../ui';
import { Badge, Chips, LoadingState, LoginCard, Row, SaveBar, Section, SettingsSheet, type ChoiceOption } from './primitives';
import { THINKING_LEVELS, type BotModelConfigState } from './useBotModelConfig';
import './model-settings.css';

const INHERIT = '__inherit';
const CLEARED = '__null';

export function ModelSettingsPage({ state, api, identity, onClose }: { state: BotModelConfigState; api: DesktopPanelApi; identity: DesktopIdentity; onClose(): void }) {
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
  const modelName = (ref: string | null | undefined) => {
    if (!ref) return undefined;
    return models.find(model => model.modelRef === ref)?.name ?? ref;
  };

  const thinkingOptions: ChoiceOption<string>[] = [
    { value: INHERIT, label: t('跟随默认', 'Default'), hint: config?.global.thinkingLevel ? levelLabel(config.global.thinkingLevel) : undefined },
    ...(typeof draft.thinkingLevel === 'string' && !(THINKING_LEVELS as readonly string[]).includes(draft.thinkingLevel)
      ? [{ value: draft.thinkingLevel, label: draft.thinkingLevel }]
      : []),
    ...THINKING_LEVELS.map(level => ({ value: level as string, label: levelLabel(level) })),
  ];
  const thinkingValue = draft.thinkingLevel === undefined ? INHERIT : draft.thinkingLevel === null ? CLEARED : draft.thinkingLevel;

  const renderSummary = () => {
    if (!config) return null;
    const effectiveRef = config.effective.modelRef;
    const name = modelName(effectiveRef);
    const level = config.effective.thinkingLevel;
    const codemodeLabel = config.effective.codemodeOnly === true
      ? t('仅 Code Mode', 'Code Mode only')
      : config.effective.codemode === true ? 'Code Mode' : undefined;
    const custom = config.overrides.modelRef !== undefined;
    return (
      <div className={`bs-model-summary${name ? '' : ' is-unset'}`}>
        <span className="bs-model-summary-label">{t('当前生效', 'In effect')}</span>
        <span className="bs-model-summary-name">{name ?? t('未设置', 'Not set')}</span>
        {effectiveRef && effectiveRef !== name ? <span className="bs-model-ref">{effectiveRef}</span> : null}
        <div className="bs-model-summary-badges">
          <Badge tone={custom ? 'accent' : 'neutral'}>{custom ? t('单独指定', 'Custom') : t('跟随默认', 'Default')}</Badge>
          {level ? <Badge>{t('思考', 'Thinking')} · {levelLabel(level)}</Badge> : null}
          {codemodeLabel ? <Badge>{codemodeLabel}</Badge> : null}
        </div>
      </div>
    );
  };

  const renderModels = () => {
    if (!config) return null;
    const globalName = modelName(config.global.modelRef);
    const cleared = draft.modelRef === null;
    return (
      <Section
        title={t('模型', 'Model')}
        bare
        hint={cleared ? t('已在高级设置中清空模型覆盖；选择任一项即可恢复。', 'Model override is explicitly cleared in Advanced; pick any option to restore.') : undefined}
      >
        <div className="bs-card">
          <Row
            radio
            selected={draft.modelRef === undefined}
            disabled={busy}
            title={t('跟随中心默认', 'Use center default')}
            subtitle={`${t('当前默认：', 'Current default: ')}${globalName ?? t('未设置', 'Not set')}`}
            onClick={() => state.setModelRef(undefined)}
          />
        </div>
        {catalog ? (
          <ModelPicker catalog={catalog} api={api} identity={identity} value={draft.modelRef} onChange={state.setModelRef} onStarsChange={state.setStarredModels} disabled={busy} />
        ) : null}
      </Section>
    );
  };

  const renderThinking = () => {
    if (!config) return null;
    return (
      <Section
        title={t('思考强度', 'Thinking level')}
        bare
        hint={draft.thinkingLevel === null
          ? t('已在高级设置中清空思考强度覆盖', 'Thinking level override is cleared in Advanced')
          : t('越高越慎重、越慢；仅对支持推理的模型生效。', 'Higher is more deliberate but slower; only applies to reasoning models.')}
      >
        <Chips
          label={t('思考强度', 'Thinking level')}
          value={thinkingValue}
          options={thinkingOptions}
          disabled={busy}
          onChange={value => state.setThinkingLevel(value === INHERIT ? undefined : value)}
        />
      </Section>
    );
  };

  return (
    <SettingsSheet
      title={t('模型', 'Model')}
      onClose={onClose}
      footer={config ? (
        <SaveBar
          dirty={state.dirty}
          busy={busy}
          onSave={() => void state.save(t('模型设置已保存', 'Model settings saved'))}
          onReset={state.reset}
        />
      ) : undefined}
    >
      {state.loading ? <LoadingState /> : null}
      {state.needsLogin ? (
        <LoginCard
          busy={busy}
          onSubmit={password => void state.login(password)}
          message={t('读取 Bot 模型设置需要管理员身份', 'Reading bot model settings requires administrator sign-in')}
        />
      ) : null}
      {renderSummary()}
      <ErrorNotice error={state.error} onDismiss={state.dismissError} />
      {state.notice ? <ErrorNotice error={state.notice} tone="success" compact onDismiss={state.dismissNotice} /> : null}
      {renderThinking()}
      {renderModels()}
      {config ? (
        <button
          type="button"
          className="bs-link bs-model-link"
          onClick={() => void openCenterManagement().catch(failure => state.setError(errorText(failure)))}
        >
          {t('管理模型服务商', 'Manage model providers')}
          <ExternalLink aria-hidden="true" />
        </button>
      ) : null}
    </SettingsSheet>
  );
}
