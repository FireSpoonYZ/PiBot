// Bot 高级设置页：Code Mode 三态、清空模型/思考强度覆盖、配置来源（折叠）。
// 数据与草稿来自 useBotModelConfig；Code Mode 联动规则由 setCodemode/setCodemodeOnly 实现。
import type { ReactNode } from 'react';
import type { CenterModelSelection } from '../../../host-core/desktop-client.js';
import { ErrorNotice, useText } from '../ui';
import { Disclosure, KeyValueList, LoadingState, LoginCard, Row, SaveBar, Section, Segmented, SettingsSheet, Switch } from './primitives';
import type { BotModelConfigState, Override } from './useBotModelConfig';
import './advanced-settings.css';

type TriState = 'inherit' | 'on' | 'off';

/** undefined → 跟随默认；true/false → 开/关；null（显式清空）→ 不选中任何选项。 */
const toTriState = (value: Override<boolean>): TriState | undefined =>
  value === undefined ? 'inherit' : value === null ? undefined : value ? 'on' : 'off';

const fromTriState = (value: TriState): boolean | undefined =>
  value === 'inherit' ? undefined : value === 'on';

function CodeModeBlock({ title, description, value, globalValue, disabled, onChange }: {
  title: string;
  description: string;
  value: Override<boolean>;
  globalValue: Override<boolean>;
  disabled: boolean;
  onChange(value: boolean | undefined): void;
}) {
  const t = useText();
  return (
    <div className="bs-adv-block">
      <div className="bs-adv-text">
        <div className="bs-adv-title-line">
          <span className="bs-adv-title">{title}</span>
          {value === null ? <span className="bs-adv-note">{t('已显式清空', 'Explicitly cleared')}</span> : null}
        </div>
        <p className="bs-adv-desc">{description}</p>
      </div>
      <Segmented<TriState>
        label={title}
        value={toTriState(value)}
        disabled={disabled}
        onChange={next => onChange(fromTriState(next))}
        options={[
          { value: 'inherit', label: t('跟随默认', 'Default'), hint: globalValue === true ? t('开', 'On') : t('关', 'Off') },
          { value: 'on', label: t('开启', 'On') },
          { value: 'off', label: t('关闭', 'Off') },
        ]}
      />
    </div>
  );
}

export function AdvancedSettingsPage({ state, onClose }: { state: BotModelConfigState; onClose(): void }) {
  const t = useText();
  const { config, draft, busy } = state;

  const describe = (value: string | null | undefined): ReactNode =>
    value === undefined ? t('继承', 'Inherit') : value === null ? t('已清空', 'Cleared') : value;

  const describeCodemode = (selection: CenterModelSelection, fallback: string): ReactNode => {
    if (selection.codemodeOnly === true) return t('仅 Code Mode', 'Code Mode only');
    if (selection.codemode === true) return t('开启', 'On');
    if (selection.codemode === false) return t('关闭', 'Off');
    if (selection.codemode === null || selection.codemodeOnly === null) return t('已清空', 'Cleared');
    return fallback;
  };

  const sourceItems = (selection: CenterModelSelection, codemodeFallback: string) => [
    { key: 'model', label: t('模型', 'Model'), value: describe(selection.modelRef) },
    { key: 'thinking', label: t('思考强度', 'Thinking level'), value: describe(selection.thinkingLevel) },
    { key: 'codemode', label: 'Code Mode', value: describeCodemode(selection, codemodeFallback) },
  ];

  let body: ReactNode;
  if (state.loading) {
    body = <LoadingState />;
  } else if (state.needsLogin) {
    body = (
      <LoginCard
        busy={busy}
        onSubmit={password => void state.login(password)}
        message={t('修改高级设置需要管理员身份', 'Changing advanced settings requires administrator sign-in')}
      />
    );
  } else if (config) {
    body = (
      <>
        <Section title="Code Mode" hint={t('开启「仅 Code Mode」会同时开启 Code Mode。', 'Turning on "Code Mode only" also turns on Code Mode.')}>
          <CodeModeBlock
            title={t('Code Mode', 'Code Mode')}
            description={t('允许模型在沙盒中编写脚本，批量编排工具调用。', 'Lets the model write sandboxed scripts to orchestrate tool calls in bulk.')}
            value={draft.codemode}
            globalValue={config.global.codemode}
            disabled={busy}
            onChange={state.setCodemode}
          />
          <CodeModeBlock
            title={t('仅 Code Mode', 'Code Mode only')}
            description={t('只向模型暴露 codemode，其它工具与 MCP 按需搜索加载，节省上下文。', 'Expose only codemode; other tools and MCPs load on demand to save context.')}
            value={draft.codemodeOnly}
            globalValue={config.global.codemodeOnly}
            disabled={busy}
            onChange={state.setCodemodeOnly}
          />
        </Section>

        <Section
          title={t('清空覆盖', 'Clear overrides')}
          hint={t('开启后本 Bot 不使用该项，也不继承中心默认。一般无需开启。', 'When on, this bot neither sets nor inherits the value. Usually leave off.')}
        >
          <Row
            title={t('清空模型', 'Clear model')}
            disabled={busy}
            trailing={
              <Switch
                label={t('清空模型', 'Clear model')}
                checked={draft.modelRef === null}
                disabled={busy}
                onChange={next => state.setModelRef(next ? null : undefined)}
              />
            }
          />
          <Row
            title={t('清空思考强度', 'Clear thinking level')}
            disabled={busy}
            trailing={
              <Switch
                label={t('清空思考强度', 'Clear thinking level')}
                checked={draft.thinkingLevel === null}
                disabled={busy}
                onChange={next => state.setThinkingLevel(next ? null : undefined)}
              />
            }
          />
        </Section>

        <Disclosure title={t('查看配置来源', 'Show configuration sources')}>
          <div className="bs-adv-sources">
            <div className="bs-adv-group">
              <h4 className="bs-adv-group-title">{t('中心默认', 'Global')}</h4>
              <KeyValueList items={sourceItems(config.global, t('默认', 'Default'))} />
            </div>
            <div className="bs-adv-group">
              <h4 className="bs-adv-group-title">{t('本 Bot 覆盖', 'Override')}</h4>
              <KeyValueList items={sourceItems(config.overrides, t('继承', 'Inherit'))} />
            </div>
            <div className="bs-adv-group">
              <h4 className="bs-adv-group-title">{t('当前生效', 'Effective')}</h4>
              <KeyValueList items={sourceItems(config.effective, t('默认', 'Default'))} />
            </div>
            <p className="bs-adv-revision">{t('配置版本', 'Revision')} {config.revision}</p>
          </div>
        </Disclosure>
      </>
    );
  }

  return (
    <SettingsSheet
      title={t('高级设置', 'Advanced')}
      onClose={onClose}
      footer={config && !state.needsLogin ? (
        <SaveBar
          dirty={state.dirty}
          busy={busy}
          onSave={() => void state.save(t('高级设置已保存', 'Advanced settings saved'))}
          onReset={state.reset}
        />
      ) : undefined}
    >
      {state.error ? <ErrorNotice error={state.error} onDismiss={state.dismissError} /> : null}
      {state.notice ? <ErrorNotice error={state.notice} tone="success" compact onDismiss={state.dismissNotice} /> : null}
      {body}
    </SettingsSheet>
  );
}
