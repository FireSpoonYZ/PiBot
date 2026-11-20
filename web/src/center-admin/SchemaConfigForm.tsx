import { useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { useText } from '../ui';
import type { CenterApi } from './transport';
import type { JsonObject, JsonSchema, JsonValue } from './types';

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchemaRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (isJsonObject(schema) && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const parts = schema.$ref
      .slice(2)
      .split('/')
      .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur: unknown = root;
    for (const part of parts) {
      if (!isJsonObject(cur)) return schema;
      cur = cur[part];
    }
    if (typeof cur === 'boolean' || isJsonObject(cur)) return cur;
  }
  return schema;
}

function getAtPath(value: JsonValue | undefined, path: string[]): JsonValue | undefined {
  let cur = value;
  for (const key of path) {
    if (!isJsonObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function setAtPath(obj: JsonObject, path: string[], next: JsonValue | undefined): JsonObject {
  const result: JsonObject = { ...obj };
  const [head, ...rest] = path;
  if (!head) return result;
  if (rest.length === 0) {
    if (next === undefined) delete result[head];
    else result[head] = next;
    return result;
  }
  const existingChild = isJsonObject(result[head]) ? (result[head] as JsonObject) : {};
  const updatedChild = setAtPath(existingChild, rest, next);
  if (Object.keys(updatedChild).length > 0) result[head] = updatedChild;
  else delete result[head];
  return result;
}

function fieldUiObject(uiSchema: JsonObject | undefined, path: string[]): JsonObject | undefined {
  if (!uiSchema) return undefined;
  let cur: JsonValue | undefined = uiSchema;
  for (const key of path) {
    if (!isJsonObject(cur)) return undefined;
    cur = cur[key];
  }
  return isJsonObject(cur) ? cur : undefined;
}

function isHiddenPath(uiSchema: JsonObject | undefined, path: string[]): boolean {
  const ui = fieldUiObject(uiSchema, path);
  return ui?.['ui:widget'] === 'hidden';
}

function CredentialField({
  id,
  value,
  disabled,
  required,
  placeholder,
  api,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  api: CenterApi;
  onChange: (next: string | undefined) => void;
}): React.JSX.Element {
  const t = useText();
  const [status, setStatus] = useState<'empty' | 'loading' | 'configured' | 'unset' | 'error'>('empty');
  const [statusMsg, setStatusMsg] = useState('');
  const [secret, setSecret] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setSecret('');
    setRevision(null);
    if (!value) {
      setStatus('empty');
      setStatusMsg(t('未填写凭证 ID', 'No credential ID'));
      return;
    }
    setStatus('loading');
    setStatusMsg(t('读取凭证状态…', 'Loading credential status…'));
    api
      .getCredential(value)
      .then(info => {
        if (!active) return;
        setRevision(info.revision);
        setStatus(info.configured ? 'configured' : 'unset');
        setStatusMsg(info.configured ? t('已配置密钥', 'Secret configured') : t('未配置密钥', 'Secret not configured'));
      })
      .catch(() => {
        if (!active) return;
        setStatus('error');
        setStatusMsg(t('暂未找到此凭证，可输入密钥直接创建', 'Credential not found yet; enter a secret to create it'));
      });
    return () => {
      active = false;
    };
  }, [api, t, value]);

  const handleSaveSecret = async () => {
    if (!value || !secret || busy) return;
    setBusy(true);
    try {
      const info = await api.putCredential(value, { value: secret, expectedRevision: revision });
      setRevision(info.revision);
      setSecret('');
      setStatus(info.configured ? 'configured' : 'unset');
      setStatusMsg(info.configured ? t('已配置密钥', 'Secret configured') : t('未配置密钥', 'Secret not configured'));
    } catch (err) {
      setStatus('error');
      setStatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ca-cred-box">
      <div className="ca-inline-row">
        <input
          id={id}
          type="text"
          className="ca-input"
          value={value}
          disabled={disabled || busy}
          required={required}
          placeholder={placeholder || t('输入凭证 ID', 'Enter credential ID')}
          onChange={e => onChange(e.target.value || undefined)}
        />
        <span
          className={`ca-pill ${
            status === 'configured' ? 'ca-pill-ok' : status === 'error' ? 'ca-pill-warn' : 'ca-pill-muted'
          }`}
        >
          {statusMsg}
        </span>
      </div>
      {value && !disabled && (
        <div className="ca-inline-row ca-mt-2">
          <input
            type="password"
            className="ca-input"
            autoComplete="new-password"
            placeholder={t('输入新密钥写入（仅保存到中心，不回显）', 'Enter a new secret (stored on center, never shown again)')}
            value={secret}
            disabled={busy}
            onChange={e => setSecret(e.target.value)}
          />
          <button
            type="button"
            className="ca-btn ca-btn-secondary ca-btn-sm"
            disabled={!secret || busy}
            onClick={() => void handleSaveSecret()}
          >
            {busy ? t('保存中…', 'Saving…') : t('保存密钥', 'Save secret')}
          </button>
        </div>
      )}
    </div>
  );
}

function StringArrayField({
  value,
  disabled,
  enumOptions,
  onChange,
}: {
  value: string[];
  disabled?: boolean;
  enumOptions?: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const t = useText();
  const [draft, setDraft] = useState('');

  if (enumOptions && enumOptions.length > 0) {
    const selected = new Set(value);
    return (
      <div className="ca-check-group">
        {enumOptions.map(opt => (
          <label key={opt} className="ca-check-label">
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.has(opt)}
              onChange={e => {
                const next = new Set(selected);
                if (e.target.checked) next.add(opt);
                else next.delete(opt);
                onChange([...next]);
              }}
            />
            <span>{opt}</span>
          </label>
        ))}
      </div>
    );
  }

  return (
    <div className="ca-array-box">
      {value.length > 0 && (
        <div className="ca-tag-list">
          {value.map((item, idx) => (
            <span key={`${item}-${idx}`} className="ca-tag">
              <span>{item}</span>
              {!disabled && (
                <button
                  type="button"
                  className="ca-tag-remove"
                  aria-label={t(`移除 ${item}`, `Remove ${item}`)}
                  onClick={() => onChange(value.filter((_, i) => i !== idx))}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {!disabled && (
        <div className={`ca-inline-row${value.length > 0 ? ' ca-mt-2' : ''}`}>
          <input
            type="text"
            className="ca-input"
            value={draft}
            placeholder={t('输入条目后点击添加', 'Enter an item and click Add')}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                const trimmed = draft.trim();
                if (trimmed) {
                  onChange([...value, trimmed]);
                  setDraft('');
                }
              }
            }}
          />
          <button
            type="button"
            className="ca-btn ca-btn-secondary ca-btn-sm"
            disabled={!draft.trim()}
            onClick={() => {
              const trimmed = draft.trim();
              if (trimmed) {
                onChange([...value, trimmed]);
                setDraft('');
              }
            }}
          >
            {t('添加', 'Add')}
          </button>
        </div>
      )}
    </div>
  );
}

export interface SchemaConfigFormProps {
  schema: JsonSchema;
  uiSchema?: JsonObject;
  formData: JsonObject;
  baseConfig?: JsonObject;
  onChange: (next: JsonObject) => void;
  api: CenterApi;
  disabled?: boolean;
  hideRawJson?: boolean;
  submitLabel?: string;
  submitBusy?: boolean;
  onSubmit?: () => void;
}

export function SchemaConfigForm({
  schema,
  uiSchema,
  formData,
  baseConfig,
  onChange,
  api,
  disabled,
  hideRawJson,
  submitLabel,
  submitBusy,
  onSubmit,
}: SchemaConfigFormProps): React.JSX.Element {
  const t = useText();
  const overrideMode = baseConfig !== undefined;
  const [rawOpen, setRawOpen] = useState(false);
  const [rawText, setRawText] = useState(() => JSON.stringify(formData ?? {}, null, 2));
  const [rawError, setRawError] = useState('');

  useEffect(() => {
    setRawText(JSON.stringify(formData ?? {}, null, 2));
    setRawError('');
  }, [formData]);

  const resolvedRoot = useMemo(() => resolveSchemaRef(schema, schema), [schema]);

  const renderNode = (
    nodeSchema: JsonSchema,
    path: string[],
    required: boolean,
  ): React.ReactNode => {
    if (path.length > 0 && isHiddenPath(uiSchema, path)) return null;
    const node = resolveSchemaRef(nodeSchema, schema);
    if (typeof node === 'boolean') return null;

    const fieldKey = path[path.length - 1] ?? '';
    const ui = fieldUiObject(uiSchema, path);
    const title = (typeof ui?.['ui:title'] === 'string' && ui['ui:title']) ||
      (typeof node.title === 'string' && node.title) ||
      fieldKey;
    const description = (typeof ui?.['ui:description'] === 'string' && ui['ui:description']) ||
      (typeof node.description === 'string' ? node.description : '');
    const placeholder = typeof ui?.['ui:placeholder'] === 'string' ? ui['ui:placeholder'] : undefined;
    const widget = typeof ui?.['ui:widget'] === 'string' ? ui['ui:widget'] : undefined;
    const format = typeof node.format === 'string' ? node.format : undefined;

    const properties = isJsonObject(node.properties) ? node.properties : null;
    const isObjectNode = node.type === 'object' || (properties !== null && node.type !== 'array');

    if (isObjectNode) {
      const propEntries = properties ? Object.entries(properties) : [];
      const reqList = Array.isArray(node.required)
        ? node.required.filter((x): x is string => typeof x === 'string')
        : [];
      const reqSet = new Set(reqList);

      if (propEntries.length === 0 && path.length === 0) {
        return (
          <div className="ca-empty-hint">
            {t('当前扩展暂无需要填写的可视化配置字段。', 'This extension has no visual configuration fields.')}
          </div>
        );
      }

      if (path.length === 0) {
        return (
          <div className="ca-form-stack">
            {propEntries.map(([key, child]) => (
              <div key={key}>
                {renderNode(
                  typeof child === 'boolean' || isJsonObject(child) ? child : true,
                  [key],
                  reqSet.has(key),
                )}
              </div>
            ))}
          </div>
        );
      }

      return (
        <fieldset className="ca-fieldset">
          <legend className="ca-fieldset-title">{title}</legend>
          {description && <p className="ca-field-help">{description}</p>}
          <div className="ca-form-stack">
            {propEntries.map(([key, child]) => (
              <div key={key}>
                {renderNode(
                  typeof child === 'boolean' || isJsonObject(child) ? child : true,
                  [...path, key],
                  reqSet.has(key),
                )}
              </div>
            ))}
          </div>
        </fieldset>
      );
    }

    const rawOverrideValue = getAtPath(formData, path);
    const hasOverride = rawOverrideValue !== undefined;
    const inheritedValue = baseConfig ? getAtPath(baseConfig, path) : undefined;
    const effectiveVal = overrideMode
      ? (hasOverride ? rawOverrideValue : inheritedValue ?? node.default)
      : (rawOverrideValue !== undefined ? rawOverrideValue : node.default);

    const fieldDisabled = Boolean(disabled) || (overrideMode && !hasOverride);
    const inputId = `ca-field-${path.join('-')}`;

    const updateField = (next: JsonValue | undefined) => {
      onChange(setAtPath(formData, path, next));
    };

    const toggleOverride = (checked: boolean) => {
      if (checked) {
        const seed = inheritedValue !== undefined
          ? inheritedValue
          : node.default !== undefined
            ? node.default
            : node.type === 'boolean'
              ? false
              : node.type === 'array'
                ? []
                : node.type === 'number' || node.type === 'integer'
                  ? 0
                  : '';
        onChange(setAtPath(formData, path, seed as JsonValue));
      } else {
        onChange(setAtPath(formData, path, undefined));
      }
    };

    const enumValues = Array.isArray(node.enum) ? node.enum : null;
    const itemsNode = isJsonObject(node.items) ? resolveSchemaRef(node.items, schema) : null;
    const itemEnums = itemsNode && isJsonObject(itemsNode) && Array.isArray(itemsNode.enum)
      ? itemsNode.enum.map(v => String(v))
      : undefined;

    let control: React.ReactNode = null;

    if (enumValues) {
      const strVal = effectiveVal === undefined || effectiveVal === null ? '' : String(effectiveVal);
      control = (
        <select
          id={inputId}
          className="ca-select"
          disabled={fieldDisabled}
          required={required}
          value={strVal}
          onChange={e => {
            const matched = enumValues.find(item => String(item) === e.target.value);
            updateField(matched === undefined ? undefined : (matched as JsonValue));
          }}
        >
          {!required && <option value="">{t('（未设置）', '(Unset)')}</option>}
          {enumValues.map(item => {
            const s = String(item);
            return (
              <option key={s} value={s}>
                {s}
              </option>
            );
          })}
        </select>
      );
    } else if (node.type === 'boolean') {
      const checked = Boolean(effectiveVal);
      control = (
        <button
          id={inputId}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={title}
          disabled={fieldDisabled}
          className={`ca-switch ${checked ? 'is-on' : ''}`}
          onClick={() => updateField(!checked)}
        >
          <span className="ca-switch-thumb" />
        </button>
      );
    } else if (node.type === 'number' || node.type === 'integer') {
      const numStr = typeof effectiveVal === 'number' ? String(effectiveVal) : '';
      control = (
        <input
          id={inputId}
          type="number"
          step={node.type === 'integer' ? 1 : 'any'}
          className="ca-input"
          disabled={fieldDisabled}
          required={required}
          placeholder={placeholder}
          value={numStr}
          onChange={e => {
            const v = e.target.value;
            if (v === '') updateField(undefined);
            else {
              const parsed = node.type === 'integer' ? parseInt(v, 10) : Number(v);
              if (!Number.isNaN(parsed)) updateField(parsed);
            }
          }}
        />
      );
    } else if (node.type === 'array') {
      const arr = Array.isArray(effectiveVal) ? effectiveVal.map(v => String(v)) : [];
      control = (
        <StringArrayField
          value={arr}
          disabled={fieldDisabled}
          enumOptions={itemEnums}
          onChange={next => updateField(next)}
        />
      );
    } else if (format === 'credential-ref' || widget === 'credential') {
      control = (
        <CredentialField
          id={inputId}
          value={typeof effectiveVal === 'string' ? effectiveVal : ''}
          disabled={fieldDisabled}
          required={required}
          placeholder={placeholder}
          api={api}
          onChange={next => updateField(next)}
        />
      );
    } else if (format === 'password' || widget === 'password') {
      control = (
        <input
          id={inputId}
          type="password"
          className="ca-input"
          autoComplete="new-password"
          disabled={fieldDisabled}
          required={required}
          placeholder={placeholder}
          value={typeof effectiveVal === 'string' ? effectiveVal : ''}
          onChange={e => updateField(e.target.value || undefined)}
        />
      );
    } else if (widget === 'textarea') {
      control = (
        <textarea
          id={inputId}
          rows={3}
          className="ca-textarea"
          disabled={fieldDisabled}
          required={required}
          placeholder={placeholder}
          value={typeof effectiveVal === 'string' ? effectiveVal : ''}
          onChange={e => updateField(e.target.value || undefined)}
        />
      );
    } else {
      control = (
        <input
          id={inputId}
          type="text"
          className="ca-input"
          disabled={fieldDisabled}
          required={required}
          placeholder={placeholder}
          value={typeof effectiveVal === 'string' ? effectiveVal : ''}
          onChange={e => updateField(e.target.value || undefined)}
        />
      );
    }

    return (
      <div className="ca-field">
        <div className="ca-field-head">
          <label htmlFor={inputId} className="ca-field-label">
            {title}
            {required && <span className="ca-req">*</span>}
          </label>
          {overrideMode && (
            <label className="ca-override-toggle">
              <input
                type="checkbox"
                disabled={disabled}
                checked={hasOverride}
                onChange={e => toggleOverride(e.target.checked)}
              />
              <span>{hasOverride ? t('覆盖全局设置', 'Override global') : t('继承全局默认', 'Inherit global')}</span>
            </label>
          )}
        </div>
        {node.type === 'boolean' ? (
          <div className="ca-inline-between">
            {description ? <span className="ca-field-help">{description}</span> : <span />}
            {control}
          </div>
        ) : (
          <>
            {control}
            {description && <p className="ca-field-help">{description}</p>}
          </>
        )}
      </div>
    );
  };

  const applyRawJson = () => {
    try {
      const parsed = JSON.parse(rawText || '{}') as unknown;
      if (!isJsonObject(parsed)) {
        setRawError(t('配置必须是 JSON 对象', 'Configuration must be a JSON object'));
        return;
      }
      setRawError('');
      onChange(parsed);
    } catch (err) {
      setRawError(err instanceof Error ? err.message : t('JSON 解析失败', 'Failed to parse JSON'));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  return (
    <form className="ca-schema-form" onSubmit={handleSubmit}>
      {typeof resolvedRoot === 'boolean' ? (
        <div className="ca-empty-hint">
          {resolvedRoot ? t('请使用下方高级 JSON 编辑器配置参数。', 'Use the advanced JSON editor below to configure parameters.') : t('当前扩展无配置项。', 'This extension has no configuration options.')}
        </div>
      ) : (
        renderNode(resolvedRoot, [], false)
      )}

      {!hideRawJson && (
        <div className="ca-disclosure">
          <button
            type="button"
            className="ca-disclosure-btn"
            aria-expanded={rawOpen}
            onClick={() => setRawOpen(prev => !prev)}
          >
            <span>{rawOpen ? '▾' : '▸'} {t('高级 JSON 配置', 'Advanced JSON config')}</span>
          </button>
          {rawOpen && (
            <div className="ca-disclosure-body">
              <textarea
                rows={6}
                className="ca-textarea ca-mono"
                disabled={disabled}
                value={rawText}
                onChange={e => setRawText(e.target.value)}
              />
              {rawError && <p className="ca-error-text">{rawError}</p>}
              {!disabled && (
                <div className="ca-inline-end ca-mt-2">
                  <button
                    type="button"
                    className="ca-btn ca-btn-secondary ca-btn-sm"
                    onClick={applyRawJson}
                  >
                    {t('应用 JSON', 'Apply JSON')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {submitLabel && (
        <div className="ca-form-actions">
          <button type="submit" className="ca-btn ca-btn-primary" disabled={disabled || submitBusy}>
            {submitBusy ? t('保存中…', 'Saving…') : submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}
