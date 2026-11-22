import { useEffect, useMemo, useState } from 'react';
import type * as React from 'react';
import { LabelStack, ReservedSlot } from '../layout';
import { useText } from '../ui';
import { errorMessage } from './transport';
import type { CenterApi } from './transport';
import type { JsonObject, JsonSchema, JsonValue } from './types';

const CREDENTIAL_LOOKUP_DEBOUNCE_MS = 350;

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
  const [status, setStatus] = useState<'empty' | 'loading' | 'configured' | 'unset' | 'missing'>('empty');
  const [secret, setSecret] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');

  const trimmedId = value.trim();

  useEffect(() => {
    let active = true;
    setSecret('');
    setRevision(null);
    setSaveError('');

    if (!trimmedId) {
      setStatus('empty');
      return;
    }

    setStatus('loading');
    const timer = window.setTimeout(() => {
      api
        .getCredential(trimmedId)
        .then(info => {
          if (!active) return;
          setRevision(info.revision);
          setStatus(info.configured ? 'configured' : 'unset');
        })
        .catch(() => {
          if (!active) return;
          setStatus('missing');
        });
    }, CREDENTIAL_LOOKUP_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api, trimmedId]);

  const statusLabel = useMemo(() => {
    switch (status) {
      case 'loading':
        return t('检查中…', 'Checking…');
      case 'configured':
        return t('已配置密钥', 'Secret configured');
      case 'unset':
        return t('未配置密钥', 'Secret unset');
      case 'missing':
        return t('新凭证（输入密钥即可创建）', 'New credential (enter secret to create)');
      default:
        return t('未填写凭证 ID', 'No credential ID');
    }
  }, [status, t]);

  const handleSaveSecret = async () => {
    if (!trimmedId || !secret || busy || disabled) return;
    setBusy(true);
    setSaveError('');
    try {
      const info = await api.putCredential(trimmedId, { value: secret, expectedRevision: revision });
      setRevision(info.revision);
      setSecret('');
      setStatus(info.configured ? 'configured' : 'unset');
    } catch (err) {
      const detail = errorMessage(err, t('中心拒绝了写入请求', 'Center rejected the request'));
      setSaveError(
        t(`保存密钥失败：${detail}。请确认凭证 ID 无误后重试。`, `Failed to save secret: ${detail}. Check the credential ID and try again.`),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ca-cred-box ca-form-stack">
      <div className="ca-inline-row" style={{ flexWrap: 'nowrap' }}>
        <input
          id={id}
          type="text"
          className="ca-input"
          style={{ flex: 1 }}
          value={value}
          disabled={disabled || busy}
          required={required}
          placeholder={placeholder || t('输入凭证 ID', 'Enter credential ID')}
          onChange={e => onChange(e.target.value || undefined)}
        />
        <span
          className={`ca-pill ${
            status === 'configured' ? 'ca-pill-ok' : status === 'missing' ? 'ca-pill-warn' : 'ca-pill-muted'
          }`}
        >
          {statusLabel}
        </span>
      </div>
      {trimmedId && !disabled && (
        <div className="ca-inline-row" style={{ flexWrap: 'nowrap' }}>
          <input
            type="password"
            className="ca-input"
            style={{ flex: 1 }}
            autoComplete="new-password"
            placeholder={t('输入新密钥写入（仅保存到中心，不回显）', 'Enter a new secret (stored on center, never shown again)')}
            value={secret}
            disabled={busy}
            onChange={e => {
              setSecret(e.target.value);
              if (saveError) setSaveError('');
            }}
          />
          <button
            type="button"
            className="ca-btn ca-btn-secondary ca-btn-sm"
            disabled={!secret || busy}
            aria-busy={busy}
            onClick={() => void handleSaveSecret()}
          >
            <LabelStack
              active={busy ? t('保存中…', 'Saving…') : t('保存密钥', 'Save secret')}
              labels={[t('保存密钥', 'Save secret'), t('保存中…', 'Saving…')]}
            />
          </button>
        </div>
      )}
      {saveError && (
        <p className="ca-error-text" role="alert" style={{ margin: 0 }}>
          {saveError}
        </p>
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

  const addDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed || disabled) return;
    onChange([...value, trimmed]);
    setDraft('');
  };

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
        <div className={`ca-inline-row${value.length > 0 ? ' ca-mt-2' : ''}`} style={{ flexWrap: 'nowrap' }}>
          <input
            type="text"
            className="ca-input"
            style={{ flex: 1 }}
            value={draft}
            placeholder={t('输入条目后点击添加', 'Enter an item and click Add')}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addDraft();
              }
            }}
          />
          <button
            type="button"
            className="ca-btn ca-btn-secondary ca-btn-sm"
            disabled={!draft.trim()}
            onClick={addDraft}
          >
            {t('添加条目', 'Add item')}
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
  cancelLabel?: string;
  onCancel?: () => void;
  error?: string;
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
  cancelLabel,
  onCancel,
  error,
}: SchemaConfigFormProps): React.JSX.Element {
  const t = useText();
  const overrideMode = baseConfig !== undefined;
  const formDisabled = Boolean(disabled || submitBusy);
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
    const title =
      (typeof ui?.['ui:title'] === 'string' && ui['ui:title']) ||
      (typeof node.title === 'string' && node.title) ||
      fieldKey;
    const description =
      (typeof ui?.['ui:description'] === 'string' && ui['ui:description']) ||
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
          {description && <p className="ca-field-help ca-mb-2">{description}</p>}
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
      ? hasOverride
        ? rawOverrideValue
        : inheritedValue ?? node.default
      : rawOverrideValue !== undefined
        ? rawOverrideValue
        : node.default;

    const fieldDisabled = formDisabled || (overrideMode && !hasOverride);
    const inputId = `ca-field-${path.join('-').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

    const updateField = (next: JsonValue | undefined) => {
      onChange(setAtPath(formData, path, next));
    };

    const toggleOverride = (checked: boolean) => {
      if (checked) {
        const seed =
          inheritedValue !== undefined
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
    const itemEnums =
      itemsNode && isJsonObject(itemsNode) && Array.isArray(itemsNode.enum)
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
          <span className="ca-switch-thumb" aria-hidden="true" />
        </button>
      );
    } else if (node.type === 'number' || node.type === 'integer') {
      const numStr = typeof effectiveVal === 'number' ? String(effectiveVal) : '';
      control = (
        <input
          id={inputId}
          type="number"
          step={node.type === 'integer' ? 1 : 'any'}
          className="ca-input ca-num"
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

    if (node.type === 'boolean') {
      return (
        <div className="ca-field">
          <div className="ca-inline-between">
            <label htmlFor={inputId} className="ca-field-label">
              {title}
              {required && <span className="ca-req">*</span>}
            </label>
            <div className="ca-inline-row" style={{ flexWrap: 'nowrap' }}>
              {overrideMode && (
                <label className="ca-override-toggle">
                  <input
                    type="checkbox"
                    disabled={formDisabled}
                    checked={hasOverride}
                    onChange={e => toggleOverride(e.target.checked)}
                  />
                  <LabelStack
                    active={hasOverride ? t('覆盖全局', 'Override') : t('继承全局', 'Inherit')}
                    labels={[t('覆盖全局', 'Override'), t('继承全局', 'Inherit')]}
                    align="start"
                  />
                </label>
              )}
              {control}
            </div>
          </div>
          {description && <p className="ca-field-help">{description}</p>}
        </div>
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
                disabled={formDisabled}
                checked={hasOverride}
                onChange={e => toggleOverride(e.target.checked)}
              />
              <LabelStack
                active={hasOverride ? t('覆盖全局设置', 'Override global') : t('继承全局默认', 'Inherit global')}
                labels={[t('覆盖全局设置', 'Override global'), t('继承全局默认', 'Inherit global')]}
                align="start"
              />
            </label>
          )}
        </div>
        {control}
        {description && <p className="ca-field-help">{description}</p>}
      </div>
    );
  };

  const applyRawJson = () => {
    if (formDisabled) return;
    try {
      const parsed = JSON.parse(rawText || '{}') as unknown;
      if (!isJsonObject(parsed)) {
        setRawError(t('配置顶层必须是 JSON 对象（例如 {}）。请修正结构后重试。', 'Configuration root must be a JSON object (e.g. {}). Fix the structure and try again.'));
        return;
      }
      setRawError('');
      onChange(parsed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : t('语法错误', 'Syntax error');
      setRawError(t(`JSON 解析失败：${detail}。请检查括号与引号后重试。`, `Failed to parse JSON: ${detail}. Check braces and quotes, then try again.`));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (formDisabled) return;
    onSubmit?.();
  };

  return (
    <form className="ca-schema-form ca-form-stack" onSubmit={handleSubmit}>
      {typeof resolvedRoot === 'boolean' ? (
        <div className="ca-empty-hint">
          {resolvedRoot
            ? t('请使用下方高级 JSON 编辑器配置参数。', 'Use the advanced JSON editor below to configure parameters.')
            : t('当前扩展无配置项。', 'This extension has no configuration options.')}
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
            <div className="ca-disclosure-body smooth-expand-mount">
              <textarea
                rows={6}
                className="ca-textarea ca-mono"
                disabled={formDisabled}
                value={rawText}
                onChange={e => {
                  setRawText(e.target.value);
                  if (rawError) setRawError('');
                }}
              />
              <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
                {rawError ? (
                  <p className="ca-error-text" role="alert">
                    {rawError}
                  </p>
                ) : null}
              </ReservedSlot>
              {!formDisabled && (
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

      {error && (
        <ReservedSlot minHeight={20} align="start" className="ca-inline-error-slot">
          <p className="ca-error-text" role="alert">
            {error}
          </p>
        </ReservedSlot>
      )}

      {(submitLabel || onCancel) && (
        <div className="ca-form-actions" style={{ flexWrap: 'nowrap' }}>
          {onCancel && (
            <button
              type="button"
              className="ca-btn"
              disabled={Boolean(submitBusy)}
              onClick={onCancel}
            >
              {cancelLabel ?? t('取消', 'Cancel')}
            </button>
          )}
          {submitLabel && (
            <button
              type="submit"
              className="ca-btn ca-btn-primary"
              disabled={formDisabled}
              aria-busy={Boolean(submitBusy)}
            >
              <LabelStack
                active={submitBusy ? t('保存中…', 'Saving…') : submitLabel}
                labels={[submitLabel, t('保存中…', 'Saving…')]}
              />
            </button>
          )}
        </div>
      )}
    </form>
  );
}
