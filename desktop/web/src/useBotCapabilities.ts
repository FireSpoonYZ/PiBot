// Bot 能力（插件/MCP/技能）数据逻辑：桌面 BotCapabilities 与手机 CapabilitiesPage 共用。
// 只经中心管理接口（owner 会话 + CAS 写入）读写，不经过目标 Host、不启用旧本地 getBotExtensions；
// 目标离线仍可在中心保存，但只有中心回执 applied 才显示“已生效”，不伪报。
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  CenterBotCapabilityEntry,
  CenterDeviceRuntimeStatus,
  CenterRuntimeBotReceipt,
  CenterRuntimeCapabilityError,
  JsonObject,
  JsonSchema,
  JsonValue,
} from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from './types';
import { toError } from './api';

/** 无法逐项渲染的 schema 用整段 JSON 覆写。 */
export type FieldKind = 'string' | 'number' | 'boolean' | 'enum';

export interface Field {
  key: string;
  kind: FieldKind;
  title?: string;
  description?: string;
  hasDefault: boolean;
  defaultValue?: JsonValue;
  options?: string[];
  optionNames?: string[];
}

export interface Editor {
  installationId: string;
  /** 打开编辑器时的 CAS 基线；自动拉取不会替换它。 */
  revision: number;
  enabled: boolean;
  overrides: JsonObject;
  /** schema 不是扁平标量时的 JSON 覆写文本。 */
  text: string | null;
}

const REFRESH_MS = 2500;
export const formatRemoteError = (err: { code: string; message: string }): string =>
  err.message.startsWith(`${err.code}:`) ? err.message : `${err.code}: ${err.message}`;

export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** 扁平标量属性可逐项“继承/覆盖”；嵌套、数组、未知类型返回 null（改用 JSON 覆写）。
    uiSchema 顶层字段标记 ui:widget=hidden 的旧键不展示。 */
export function flatFields(schema: JsonSchema | undefined, uiSchema?: JsonObject): Field[] | null {
  if (!isObject(schema)) return null;
  const properties = schema.properties;
  if (properties === undefined) return Object.keys(schema).length === 0 ? [] : null;
  if (!isObject(properties)) return null;
  const fields: Field[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    if (!isObject(raw)) return null;
    const fieldUi = uiSchema?.[key];
    if (isObject(fieldUi) && fieldUi['ui:widget'] === 'hidden') continue;
    const values = raw.enum;
    const names = raw.enumNames;
    const base: Field = {
      key,
      kind: 'string',
      ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
      ...(typeof raw.description === 'string' && raw.description ? { description: raw.description } : {}),
      hasDefault: 'default' in raw,
      ...('default' in raw ? { defaultValue: raw.default } : {}),
    };
    if (raw.type === 'string' && Array.isArray(values) && values.every((value) => typeof value === 'string')) {
      fields.push({
        ...base,
        kind: 'enum',
        options: values as string[],
        ...(Array.isArray(names) && names.length === values.length && names.every((name) => typeof name === 'string')
          ? { optionNames: names as string[] }
          : {}),
      });
    } else if (raw.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean' });
    } else if (raw.type === 'string') {
      fields.push(base);
    } else if (raw.type === 'number' || raw.type === 'integer') {
      fields.push({ ...base, kind: 'number' });
    } else {
      return null;
    }
  }
  return fields;
}

/** 勾选覆写时的初值：优先全局值，其次 schema default；保留显式 false/0，都不存在才写 null。 */
export function initialOverride(field: Field, globalValue: JsonValue | undefined): JsonValue {
  return globalValue ?? (field.hasDefault ? (field.defaultValue as JsonValue) : null);
}

export function timeText(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** 只有全局启用且已生效才可为本 Bot 开启；disabled/unknown/读取失败一律不算 ready。 */
export function globallyReady(entry: CenterBotCapabilityEntry): boolean {
  return entry.installation.enabled === true && entry.installation.activation?.status === 'enabled';
}

export interface UseBotCapabilitiesOptions {
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  deviceId: string;
  botId: string;
  t: (zh: string, en: string) => string;
  /** 中心管理员登录成功后通知外层，同一弹窗内的其它视图可同步会话状态。 */
  onAuthenticated?: () => void;
}

export interface BotCapabilitiesState {
  entries: CenterBotCapabilityEntry[];
  runtime: CenterDeviceRuntimeStatus | null;
  loaded: boolean;
  needLogin: boolean;
  editor: Editor | null;
  setEditor: Dispatch<SetStateAction<Editor | null>>;
  busy: string;
  error: string;
  setError: Dispatch<SetStateAction<string>>;
  notice: string;
  setNotice: Dispatch<SetStateAction<string>>;
  /** 调用方先清空自己的密码输入框，再把密码作为参数传入。 */
  login(password: string): Promise<void>;
  save(entry: CenterBotCapabilityEntry, enabled: boolean, overrides: JsonObject, expectedRevision: number): Promise<void>;
  openEditor(entry: CenterBotCapabilityEntry): void;
  setOverride(key: string, value: JsonValue | undefined): void;
  saveEditor(entry: CenterBotCapabilityEntry): Promise<void>;
  /** 显式采用远端（丢弃草稿）。 */
  adoptRemote(entry: CenterBotCapabilityEntry): void;
  receipt: CenterRuntimeBotReceipt | undefined;
  capabilityErrors: CenterRuntimeCapabilityError[];
}

export function useBotCapabilities({ api, identity, deviceId, botId, t, onAuthenticated }: UseBotCapabilitiesOptions): BotCapabilitiesState {
  const [entries, setEntries] = useState<CenterBotCapabilityEntry[]>([]);
  const [runtime, setRuntime] = useState<CenterDeviceRuntimeStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const seq = useRef(0);
  const busyRef = useRef('');
  const needLoginRef = useRef(false);
  // t 每次渲染都是新闭包：放进 ref，避免把 load 的 useCallback 依赖打穿成每帧重跑。
  const textRef = useRef(t);
  textRef.current = t;
  busyRef.current = busy;
  needLoginRef.current = needLogin;

  const load = useCallback(async (probeSession = true): Promise<void> => {
    const current = ++seq.current;
    try {
      const [list, status] = await Promise.all([
        api.broker(identity, 'center_bot_capabilities_get', { deviceId, botId }),
        api.broker(identity, 'center_runtime_status', { deviceId }).catch(() => null),
      ]);
      if (!alive.current || current !== seq.current) return;
      if (!Array.isArray(list)) throw new Error('invalid capability list');
      // 只替换基线与运行态；未保存的编辑器草稿不受影响。
      setEntries(list);
      setRuntime(status);
      setNeedLogin(false);
      setError('');
    } catch (failure) {
      if (!alive.current || current !== seq.current) return;
      const err = toError(failure);
      if (err.code === 'CONTROL_UNAUTHORIZED') {
        setNeedLogin(true);
        setError(probeSession ? '' : textRef.current('需要先在中心以管理员身份登录。', 'Center administrator login required.'));
        return;
      }
      setError(formatRemoteError(err));
    } finally {
      if (alive.current && current === seq.current) setLoaded(true);
    }
  }, [api, identity, deviceId, botId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      seq.current += 1;
    };
  }, [load]);

  // 显示时 2.5s 轮询（不重复探测会话）；页面隐藏/后台时暂停，回到前台补读一次。
  useEffect(() => {
    const tick = (): void => {
      if (document.hidden || busyRef.current !== '' || needLoginRef.current) return;
      void load(false);
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);

  async function login(secret: string): Promise<void> {
    setBusy('login');
    setError('');
    try {
      await api.broker(identity, 'center_owner_login', { password: secret });
      if (!alive.current) return;
      setNeedLogin(false);
      setBusy('');
      onAuthenticated?.();
      await load();
    } catch (failure) {
      if (!alive.current) return;
      const err = toError(failure);
      setError(formatRemoteError(err));
    } finally {
      if (alive.current) setBusy('');
    }
  }

  async function save(
    entry: CenterBotCapabilityEntry,
    enabled: boolean,
    overrides: JsonObject,
    expectedRevision: number,
  ): Promise<void> {
    if (enabled && !entry.config.enabled && !globallyReady(entry)) {
      setError(textRef.current('该能力全局未启用（或启用未完成），不能为本 Bot 开启；请先在中心启用并等待生效。', 'The capability is not enabled globally yet; enable it in the center first.'));
      return;
    }
    setBusy(entry.installation.installationId);
    setError('');
    setNotice('');
    try {
      const config = await api.broker(identity, 'center_bot_capability_set', {
        deviceId,
        botId,
        installationId: entry.installation.installationId,
        expectedRevision,
        enabled,
        overrides,
      });
      if (!alive.current) return;
      setEntries((previous) =>
        previous.map((item) => (item.installation.installationId === config.installationId ? { ...item, config } : item)),
      );
      setEditor(null);
      setNotice(runtime && !runtime.online
        ? textRef.current('已保存到中心；目标设备离线，待其上线后再同步应用。', 'Saved to the center; the target is offline and will sync when it reconnects.')
        : textRef.current('已保存到中心；目标应用完成后状态才会变为已生效。', 'Saved to the center; effective only after the target applies it.'));
      // 保存后立即重拉，尽快显示中心运行态与全局激活结果。
      void load(false);
    } catch (failure) {
      if (!alive.current) return;
      const err = toError(failure);
      if (err.code === 'CONTROL_UNAUTHORIZED') setNeedLogin(true);
      const message = err.code === 'REQUEST_CONFLICT'
        ? textRef.current('保存冲突（REQUEST_CONFLICT）：远端已变化，本次写入未生效。已重新读取；草稿保留，可用“采用远端（丢弃草稿）”核对后再保存。', 'Conflict (REQUEST_CONFLICT): the remote changed, nothing was written. Reloaded; your draft is kept.')
        : formatRemoteError(err);
      if (err.code === 'REQUEST_CONFLICT') {
        // 先重读基线再提示，避免读取清掉冲突说明。
        await load(false);
        if (alive.current) setError(message);
      } else {
        setError(message);
      }
    } finally {
      if (alive.current) setBusy('');
    }
  }

  function openEditor(entry: CenterBotCapabilityEntry): void {
    setEditor({
      installationId: entry.installation.installationId,
      revision: entry.config.revision,
      enabled: entry.config.enabled,
      overrides: entry.config.overrides,
      text: flatFields(entry.config.configSchema, entry.uiSchema) === null ? JSON.stringify(entry.config.overrides, null, 2) : null,
    });
    setError('');
    setNotice('');
  }

  function setOverride(key: string, value: JsonValue | undefined): void {
    setEditor((current) => {
      if (!current) return current;
      const overrides = { ...current.overrides };
      if (value === undefined) delete overrides[key];
      else overrides[key] = value;
      return { ...current, overrides };
    });
  }

  async function saveEditor(entry: CenterBotCapabilityEntry): Promise<void> {
    if (!editor) return;
    let overrides = editor.overrides;
    if (editor.text !== null) {
      if (editor.text.trim() === '') {
        setError(textRef.current('覆盖配置不能为空；不需要覆写请点“取消”（草稿已保留）。', 'Overrides JSON is empty; press Cancel to keep the saved config (your draft is kept).'));
        return;
      }
      try {
        const parsed: unknown = JSON.parse(editor.text);
        if (!isObject(parsed)) throw new Error('overrides must be an object');
        overrides = parsed;
      } catch {
        setError(textRef.current('覆盖配置必须是合法 JSON 对象（草稿已保留，可修正后重试）。', 'Overrides must be a valid JSON object (draft kept; fix and retry).'));
        return;
      }
    }
    await save(entry, editor.enabled, overrides, editor.revision);
  }

  function adoptRemote(entry: CenterBotCapabilityEntry): void {
    const { installation, config } = entry;
    // 显式采用远端：只有这个动作会替换草稿内容与 CAS 基线。
    setEditor({
      installationId: installation.installationId,
      revision: config.revision,
      enabled: config.enabled,
      overrides: config.overrides,
      text: flatFields(config.configSchema, entry.uiSchema) === null ? JSON.stringify(config.overrides, null, 2) : null,
    });
    setError('');
  }

  const receipt = runtime?.bots?.find((item) => item.botId === botId);
  const capabilityErrors = runtime?.capabilityErrors?.filter((item) => item.botId === botId) ?? [];

  return {
    entries,
    runtime,
    loaded,
    needLogin,
    editor,
    setEditor,
    busy,
    error,
    setError,
    notice,
    setNotice,
    login,
    save,
    openEditor,
    setOverride,
    saveEditor,
    adoptRemote,
    receipt,
    capabilityErrors,
  };
}
