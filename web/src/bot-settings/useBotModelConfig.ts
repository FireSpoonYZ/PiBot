// Bot 模型配置（模型 / 思考强度 / 工具调用方式）的数据层：读取、乐观即时保存、CAS 串行提交。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CenterBotModelConfig, CenterModelSelection, CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { errorText } from '../ui';
import { isCenterAuthOrBindError } from './centerAdminBroker';

/** undefined = 跟随全局默认；null = 旧版遗留清空态；其它为本 Bot 覆盖值。 */
export type Override<T> = T | null | undefined;

export type ToolMode = 'inherit' | 'standard' | 'codemode' | 'codemode_only';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const SELECTION_KEYS: (keyof CenterModelSelection)[] = ['modelRef', 'thinkingLevel', 'codemode', 'codemodeOnly'];

const valueOf = <K extends keyof CenterModelSelection>(selection: CenterModelSelection, key: K): CenterModelSelection[K] | undefined =>
  Object.prototype.hasOwnProperty.call(selection, key) ? selection[key] : undefined;

export function toolModeFromSelection(selection?: CenterModelSelection | null): ToolMode {
  if (!selection) return 'inherit';
  if (selection.codemodeOnly === true) return 'codemode_only';
  if (selection.codemode === true) return 'codemode';
  if (selection.codemode === false) return 'standard';
  return 'inherit';
}

export interface BotModelConfigState {
  /** 首次读取进行中（尚无 config）。 */
  loading: boolean;
  /** 任一读写进行中。 */
  busy: boolean;
  /** 即时保存进行中。 */
  saving: boolean;
  /** 兼容保留：已移除管理员密码登录拦截墙，恒为 false。 */
  needsLogin: boolean;
  /** 中心 OAuth / 设备令牌失效或未授权。 */
  oauthRevoked: boolean;
  /** 设备尚未绑定/连接中心。 */
  notConnected: boolean;
  config?: CenterBotModelConfig;
  catalog?: CenterModelPicker;
  /** 当前草稿 / 乐观状态（本 Bot overrides）。 */
  draft: CenterModelSelection;
  /** 草稿与已保存 overrides 不同。 */
  dirty: boolean;
  error: string;
  notice: string;
  setError(message: string): void;
  dismissError(): void;
  dismissNotice(): void;
  setStarredModels(starredModels: string[]): void;
  setModelRef(value: Override<string>): void;
  setThinkingLevel(value: Override<string>): void;
  /** 关闭 Code Mode 时若“仅 Code Mode”为开，会一并关闭。 */
  setCodemode(value: Override<boolean>): void;
  /** 开启“仅 Code Mode”时会一并开启 Code Mode。 */
  setCodemodeOnly(value: Override<boolean>): void;
  /** 二态点击即存：选择模型（undefined 表示跟随全局默认）。 */
  selectModelRef(value: string | undefined): Promise<void>;
  /** 二态点击即存：选择思考强度（undefined 表示跟随全局默认）。 */
  selectThinkingLevel(value: string | undefined): Promise<void>;
  /** 二态点击即存：选择工具调用方式（inherit / standard / codemode / codemode_only）。 */
  selectToolMode(mode: ToolMode): Promise<void>;
  /** 重新加载配置与模型目录。 */
  reload(): Promise<void>;
  /** 丢弃草稿，回到已保存 overrides。 */
  reset(): void;
  save(successNotice: string): Promise<void>;
  /** 兼容保留（不再弹出密码墙）。 */
  login(password: string): Promise<void>;
}

const assignSelectionKey = <K extends keyof CenterModelSelection>(
  next: CenterModelSelection,
  key: K,
  value: CenterModelSelection[K] | undefined,
) => {
  if (value === undefined) delete next[key];
  else next[key] = value;
};

const applyToolMode = (next: CenterModelSelection, mode: ToolMode) => {
  if (mode === 'inherit') {
    delete next.codemode;
    delete next.codemodeOnly;
    return;
  }
  if (mode === 'standard') {
    next.codemode = false;
    next.codemodeOnly = false;
    return;
  }
  if (mode === 'codemode') {
    next.codemode = true;
    next.codemodeOnly = false;
    return;
  }
  next.codemode = true;
  next.codemodeOnly = true;
};

export function useBotModelConfig(api: DesktopPanelApi, identity: DesktopIdentity, deviceId: string, botId: string): BotModelConfigState {
  const alive = useRef(false);
  const configRef = useRef<CenterBotModelConfig | undefined>(undefined);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMutationsRef = useRef(0);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [config, setConfig] = useState<CenterBotModelConfig>();
  const [draft, setDraft] = useState<CenterModelSelection>({});
  const [catalog, setCatalog] = useState<CenterModelPicker>();
  const [loadingBusy, setLoadingBusy] = useState(true);
  const [savingCount, setSavingCount] = useState(0);
  const [oauthRevoked, setOauthRevoked] = useState(false);
  const [notConnected, setNotConnected] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const updateConfigState = useCallback((next: CenterBotModelConfig, syncDraft: boolean) => {
    configRef.current = next;
    setConfig(next);
    if (syncDraft) setDraft({ ...next.overrides });
    setOauthRevoked(false);
    setNotConnected(false);
  }, []);

  const flashNotice = useCallback((text: string) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    setNotice(text);
    if (text) {
      noticeTimerRef.current = setTimeout(() => {
        if (alive.current) setNotice('');
      }, 2400);
    }
  }, []);

  const handleFailure = useCallback((failure: unknown) => {
    const authState = isCenterAuthOrBindError(failure);
    if (authState.oauthRevoked || authState.unauthorized) {
      setOauthRevoked(true);
      setNotConnected(false);
      setError('');
      return;
    }
    if (authState.notConnected) {
      setNotConnected(true);
      setOauthRevoked(false);
      setError('');
      return;
    }
    setError(errorText(failure));
  }, []);

  const reload = useCallback(async () => {
    setLoadingBusy(true);
    setError('');
    try {
      const [models, next] = await Promise.all([
        api.broker(identity, 'center_model_picker_get', {}),
        api.broker(identity, 'center_bot_model_get', { deviceId, botId }),
      ]);
      if (!alive.current) return;
      setCatalog(models);
      updateConfigState(next, pendingMutationsRef.current === 0);
    } catch (failure) {
      if (!alive.current) return;
      handleFailure(failure);
    } finally {
      if (alive.current) setLoadingBusy(false);
    }
  }, [api, identity, deviceId, botId, handleFailure, updateConfigState]);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [reload]);

  const commitMutation = useCallback((mutate: (next: CenterModelSelection) => void, successText = '已保存'): Promise<void> => {
    pendingMutationsRef.current += 1;
    setSavingCount(c => c + 1);
    setError('');

    setDraft(previous => {
      const next = { ...previous };
      mutate(next);
      return next;
    });

    const task = saveQueueRef.current.then(async () => {
      try {
        let base = configRef.current;
        if (!base) {
          base = await api.broker(identity, 'center_bot_model_get', { deviceId, botId });
        }
        const value = { ...base.overrides };
        mutate(value);

        const next = await api.broker(identity, 'center_bot_model_set', {
          deviceId,
          botId,
          expectedRevision: base.revision,
          value,
        });
        if (!alive.current) return;
        pendingMutationsRef.current = Math.max(0, pendingMutationsRef.current - 1);
        updateConfigState(next, pendingMutationsRef.current === 0);
        flashNotice(successText);
      } catch (failure) {
        if (!alive.current) return;
        pendingMutationsRef.current = Math.max(0, pendingMutationsRef.current - 1);
        if (configRef.current && pendingMutationsRef.current === 0) {
          setDraft({ ...configRef.current.overrides });
        }
        handleFailure(failure);
      } finally {
        if (alive.current) setSavingCount(c => Math.max(0, c - 1));
      }
    });

    saveQueueRef.current = task.catch(() => {});
    return task;
  }, [api, identity, deviceId, botId, flashNotice, handleFailure, updateConfigState]);

  const selectModelRef = useCallback(
    (value: string | undefined) => commitMutation(next => assignSelectionKey(next, 'modelRef', value)),
    [commitMutation],
  );

  const selectThinkingLevel = useCallback(
    (value: string | undefined) => commitMutation(next => assignSelectionKey(next, 'thinkingLevel', value)),
    [commitMutation],
  );

  const selectToolMode = useCallback(
    (mode: ToolMode) => commitMutation(next => applyToolMode(next, mode)),
    [commitMutation],
  );

  const save = useCallback(async (successNotice: string) => {
    if (!configRef.current) return;
    setSavingCount(c => c + 1);
    setError('');
    try {
      const next = await api.broker(identity, 'center_bot_model_set', {
        deviceId,
        botId,
        expectedRevision: configRef.current.revision,
        value: draft,
      });
      if (!alive.current) return;
      updateConfigState(next, true);
      flashNotice(successNotice || '已保存');
    } catch (failure) {
      if (!alive.current) return;
      handleFailure(failure);
    } finally {
      if (alive.current) setSavingCount(c => Math.max(0, c - 1));
    }
  }, [api, identity, deviceId, botId, draft, flashNotice, handleFailure, updateConfigState]);

  const login = useCallback(async (_password: string) => {
    await reload();
  }, [reload]);

  const patch = useCallback((apply: (next: CenterModelSelection) => void) => {
    setDraft(previous => {
      const next = { ...previous };
      apply(next);
      return next;
    });
    setNotice('');
  }, []);

  const setModelRef = useCallback((value: Override<string>) => patch(next => assignSelectionKey(next, 'modelRef', value)), [patch]);
  const setThinkingLevel = useCallback((value: Override<string>) => patch(next => assignSelectionKey(next, 'thinkingLevel', value)), [patch]);
  const setCodemode = useCallback((value: Override<boolean>) => patch(next => {
    assignSelectionKey(next, 'codemode', value);
    if (value === false && next.codemodeOnly === true) next.codemodeOnly = false;
  }), [patch]);
  const setCodemodeOnly = useCallback((value: Override<boolean>) => patch(next => {
    assignSelectionKey(next, 'codemodeOnly', value);
    if (value === true) next.codemode = true;
  }), [patch]);

  const reset = useCallback(() => {
    if (configRef.current) setDraft({ ...configRef.current.overrides });
    setNotice('');
  }, []);

  const dirty = useMemo(
    () => !!config && SELECTION_KEYS.some(key => valueOf(draft, key) !== valueOf(config.overrides, key)),
    [config, draft],
  );

  const busy = loadingBusy || savingCount > 0;

  return {
    loading: loadingBusy && !config && !oauthRevoked && !notConnected,
    busy,
    saving: savingCount > 0,
    needsLogin: false,
    oauthRevoked,
    notConnected,
    config,
    catalog,
    draft,
    dirty,
    error,
    notice,
    setError,
    dismissError: () => setError(''),
    dismissNotice: () => setNotice(''),
    setStarredModels: starredModels => setCatalog(previous => previous ? { ...previous, starredModels } : previous),
    setModelRef,
    setThinkingLevel,
    setCodemode,
    setCodemodeOnly,
    selectModelRef,
    selectThinkingLevel,
    selectToolMode,
    reload,
    reset,
    save,
    login,
  };
}
