// Bot 模型配置（模型 / 思考强度 / Code Mode）的数据层：读取、草稿、CAS 保存、管理员登录回退。
// 模型页与高级设置页共用；两页各自持有一份草稿，保存时整体提交 overrides。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CenterBotModelConfig, CenterModelSelection } from '../../../host-core/desktop-client.js';
import type { ModelCatalog } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { errorText } from '../ui';

/** undefined = 继承中心全局；null = 显式清空；其它为本 Bot 覆盖值。 */
export type Override<T> = T | null | undefined;

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const SELECTION_KEYS: (keyof CenterModelSelection)[] = ['modelRef', 'thinkingLevel', 'codemode', 'codemodeOnly'];

const valueOf = <K extends keyof CenterModelSelection>(selection: CenterModelSelection, key: K): CenterModelSelection[K] | undefined =>
  Object.prototype.hasOwnProperty.call(selection, key) ? selection[key] : undefined;

export interface BotModelConfigState {
  /** 首次读取进行中（尚无 config）。 */
  loading: boolean;
  /** 任一读写进行中。 */
  busy: boolean;
  /** 需要中心管理员登录后才能读写。 */
  needsLogin: boolean;
  config?: CenterBotModelConfig;
  catalog?: ModelCatalog;
  /** 当前草稿（本 Bot overrides）。 */
  draft: CenterModelSelection;
  /** 草稿与已保存 overrides 不同。 */
  dirty: boolean;
  error: string;
  notice: string;
  setError(message: string): void;
  dismissError(): void;
  dismissNotice(): void;
  setModelRef(value: Override<string>): void;
  setThinkingLevel(value: Override<string>): void;
  /** 关闭 Code Mode 时若“仅 Code Mode”为开，会一并关闭。 */
  setCodemode(value: Override<boolean>): void;
  /** 开启“仅 Code Mode”时会一并开启 Code Mode。 */
  setCodemodeOnly(value: Override<boolean>): void;
  /** 丢弃草稿，回到已保存 overrides。 */
  reset(): void;
  save(successNotice: string): Promise<void>;
  login(password: string): Promise<void>;
}

const isAuthError = (failure: unknown) =>
  typeof failure === 'object' && failure !== null && (failure as { code?: unknown }).code === 'CONTROL_UNAUTHORIZED';

export function useBotModelConfig(api: DesktopPanelApi, identity: DesktopIdentity, deviceId: string, botId: string): BotModelConfigState {
  const alive = useRef(false);
  const [authenticated, setAuthenticated] = useState(true);
  const [config, setConfig] = useState<CenterBotModelConfig>();
  const [draft, setDraft] = useState<CenterModelSelection>({});
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadConfig = useCallback(async () => {
    const next = await api.broker(identity, 'center_bot_model_get', { deviceId, botId });
    if (alive.current) { setConfig(next); setDraft({ ...next.overrides }); setAuthenticated(true); }
  }, [api, identity, deviceId, botId]);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const models = await api.call(identity, 'getModelCatalog', {});
        if (!alive.current) return;
        setCatalog(models);
        // 模型配置读写优先走 host 设备令牌路径；仅当旧中心要求 owner 会话时才回退弹出密码登录。
        await loadConfig();
      } catch (failure) {
        if (!alive.current) return;
        if (isAuthError(failure)) setAuthenticated(false);
        else setError(errorText(failure));
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
    return () => { alive.current = false; };
  }, [api, identity, loadConfig]);

  const login = useCallback(async (password: string) => {
    setBusy(true); setError('');
    try {
      await api.broker(identity, 'center_owner_login', { password });
      if (!alive.current) return;
      setAuthenticated(true);
      await loadConfig();
    } catch (failure) {
      if (alive.current) setError(errorText(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [api, identity, loadConfig]);

  const save = useCallback(async (successNotice: string) => {
    if (!config) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api.broker(identity, 'center_bot_model_set', {
        deviceId, botId, expectedRevision: config.revision, value: draft,
      });
      if (alive.current) { setConfig(next); setDraft({ ...next.overrides }); setAuthenticated(true); setNotice(successNotice); }
    } catch (failure) {
      if (!alive.current) return;
      if (isAuthError(failure)) setAuthenticated(false);
      setError(errorText(failure));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [api, identity, deviceId, botId, config, draft]);

  const patch = useCallback((apply: (next: CenterModelSelection) => void) => {
    setDraft(previous => {
      const next = { ...previous };
      apply(next);
      return next;
    });
    setNotice('');
  }, []);

  const assign = <K extends keyof CenterModelSelection>(next: CenterModelSelection, key: K, value: CenterModelSelection[K] | undefined) => {
    if (value === undefined) delete next[key]; else next[key] = value;
  };

  const setModelRef = useCallback((value: Override<string>) => patch(next => assign(next, 'modelRef', value)), [patch]);
  const setThinkingLevel = useCallback((value: Override<string>) => patch(next => assign(next, 'thinkingLevel', value)), [patch]);
  const setCodemode = useCallback((value: Override<boolean>) => patch(next => {
    assign(next, 'codemode', value);
    if (value === false && next.codemodeOnly === true) next.codemodeOnly = false;
  }), [patch]);
  const setCodemodeOnly = useCallback((value: Override<boolean>) => patch(next => {
    assign(next, 'codemodeOnly', value);
    if (value === true) next.codemode = true;
  }), [patch]);

  const reset = useCallback(() => {
    if (config) setDraft({ ...config.overrides });
    setNotice('');
  }, [config]);

  const dirty = useMemo(
    () => !!config && SELECTION_KEYS.some(key => valueOf(draft, key) !== valueOf(config.overrides, key)),
    [config, draft],
  );

  return {
    loading: busy && !config,
    busy,
    needsLogin: !busy && !authenticated && !!catalog,
    config,
    catalog,
    draft,
    dirty,
    error,
    notice,
    setError,
    dismissError: () => setError(''),
    dismissNotice: () => setNotice(''),
    setModelRef,
    setThinkingLevel,
    setCodemode,
    setCodemodeOnly,
    reset,
    save,
    login,
  };
}
