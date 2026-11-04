import { useEffect, useMemo, useState } from 'react';
import Form from '@rjsf/core';
import { customizeValidator } from '@rjsf/validator-ajv8';
import type { RJSFSchema, UiSchema, WidgetProps } from '@rjsf/utils';
import type { JsonObject, JsonSchema, JsonValue } from '@e-launcher/center-contract';
import { api } from '../api';
import './Config.css';

const validator = customizeValidator({ customFormats: { 'credential-ref': /.*/ } });
type Path = string[];
const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const at = (value: JsonValue | undefined, path: Path): JsonValue | undefined => path.reduce<JsonValue | undefined>((v, key) => isObject(v) ? v[key] : undefined, value);

function setAt(value: JsonObject, path: Path, next: JsonValue | undefined): JsonObject {
  const result = { ...value }, key = path[0];
  if (path.length === 1) { if (next === undefined) delete result[key]; else result[key] = next; }
  else {
    const child = setAt(isObject(result[key]) ? result[key] as JsonObject : {}, path.slice(1), next);
    if (Object.keys(child).length) result[key] = child; else delete result[key];
  }
  return result;
}

function merge(base: JsonValue | undefined, override: JsonValue | undefined): JsonValue | undefined {
  if (override === undefined) return base;
  if (!isObject(base) || !isObject(override)) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) result[key] = merge(base[key], override[key]) as JsonValue;
  return result;
}

function resolve(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (isObject(schema) && typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const path = schema.$ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    const target = at(root, path);
    if (typeof target === 'boolean' || isObject(target)) return target;
  }
  return schema;
}

function fields(schema: JsonSchema, root: JsonSchema, data: JsonValue | undefined, path: Path = []): Path[] {
  const node = resolve(schema, root);
  if (isObject(node) && node.type !== 'array') {
    const properties = isObject(node.properties) ? node.properties : {};
    const extra = node.additionalProperties;
    const keys = new Set([...Object.keys(properties), ...(isObject(data) && (isObject(extra) || extra === true) ? Object.keys(data) : [])]);
    if (keys.size || isObject(extra) || extra === true) return [...keys].flatMap(key => {
      const child = properties[key] ?? extra;
      return fields((typeof child === 'boolean' || isObject(child)) ? child : true, root, isObject(data) ? data[key] : undefined, [...path, key]);
    });
  }
  return path.length ? [path] : [];
}

/** uiSchema 中 ui:widget=hidden 的顶层字段不作为独立覆盖项展示（如废弃的旧键）。 */
function hiddenTopLevelPaths(uiSchema: JsonObject | undefined): Set<string> {
  const hidden = new Set<string>();
  if (!isObject(uiSchema)) return hidden;
  for (const [key, fieldUi] of Object.entries(uiSchema)) {
    if (isObject(fieldUi) && fieldUi['ui:widget'] === 'hidden') hidden.add(key);
  }
  return hidden;
}

function isAdditionalPath(schema: JsonSchema, root: JsonSchema, path: Path): boolean {
  let node = resolve(schema, root);
  for (const key of path) {
    if (!isObject(node)) return false;
    const properties = isObject(node.properties) ? node.properties : {};
    if (!(key in properties)) return isObject(node.additionalProperties) || node.additionalProperties === true;
    const child = properties[key];
    if (typeof child !== 'boolean' && !isObject(child)) return false;
    node = resolve(child, root);
  }
  return false;
}

function initialValue(schema: JsonSchema, root: JsonSchema, path: Path): JsonValue {
  let node = resolve(schema, root);
  for (const key of path) {
    if (!isObject(node)) return null;
    const properties = isObject(node.properties) ? node.properties : {};
    const child = properties[key] ?? node.additionalProperties;
    if (typeof child !== 'boolean' && !isObject(child)) return null;
    node = resolve(child, root);
  }
  return isObject(node) && node.type === 'array' ? [] : isObject(node) && node.type === 'object' ? {} : null;
}

function withoutDefaults(schema: JsonSchema): JsonSchema {
  if (!isObject(schema)) return schema;
  const result = { ...schema };
  delete result.default;
  for (const key of ['properties', 'patternProperties', 'definitions', '$defs']) {
    if (isObject(schema[key])) result[key] = Object.fromEntries(Object.entries(schema[key] as JsonObject).map(([name, child]) => [name, withoutDefaults(child as JsonSchema)]));
  }
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
    const child = schema[key];
    if (Array.isArray(child)) result[key] = child.map(item => withoutDefaults(item as JsonSchema));
    else if (typeof child === 'boolean' || isObject(child)) result[key] = withoutDefaults(child);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const children = schema[key];
    if (Array.isArray(children)) result[key] = children.map(child => withoutDefaults(child as JsonSchema));
  }
  return result;
}

function CredentialWidget(props: WidgetProps) {
  const [status, setStatus] = useState('');
  const [secret, setSecret] = useState('');
  const [revision, setRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setSecret('');
    setRevision(null);
    if (!props.value) {
      setStatus('未选择凭证');
      return;
    }
    setStatus('正在读取凭证状态…');
    api.getCredential(String(props.value))
      .then(info => {
        if (current) {
          setRevision(info.revision);
          setStatus(info.configured ? '已配置' : '未配置');
        }
      })
      .catch(() => {
        if (current) setStatus('无法读取凭证状态；新建可尝试保存');
      });
    return () => {
      current = false;
    };
  }, [props.value]);

  const badgeClass =
    status === '已配置'
      ? 'badge badge-online'
      : status === '未配置' || status === '未选择凭证'
        ? 'badge badge-neutral'
        : 'badge badge-warn';

  return (
    <div className="credential-box">
      <input
        id={props.id}
        type="text"
        value={props.value ?? ''}
        disabled={props.disabled || busy}
        readOnly={props.readonly}
        required={props.required}
        placeholder="输入或选择凭证 ID"
        onChange={event => props.onChange(event.target.value || undefined)}
        aria-describedby={`${props.id}-status`}
      />
      <div className="credential-header">
        <small id={`${props.id}-status`}>凭证 ID · {status}（不显示密钥）</small>
        {status && <span className={badgeClass}>{status}</span>}
      </div>
      {props.value && !props.disabled && !props.readonly && (
        <div className="credential-secret-row">
          <label>
            写入新密钥
            <input
              type="password"
              autoComplete="new-password"
              placeholder="输入新密钥以覆盖保存"
              value={secret}
              onChange={event => setSecret(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={!secret || busy}
            onClick={() => {
              setBusy(true);
              api.putCredential(String(props.value), { value: secret, expectedRevision: revision })
                .then(info => {
                  setRevision(info.revision);
                  setSecret('');
                  setStatus(info.configured ? '已配置' : '未配置');
                })
                .catch(error => setStatus(error instanceof Error ? error.message : String(error)))
                .finally(() => setBusy(false));
            }}
          >
            保存凭证
          </button>
        </div>
      )}
    </div>
  );
}

function makeUi(schema: JsonSchema, root: JsonSchema, ui: JsonObject, path: Path, selected: JsonObject | undefined, data: JsonValue | undefined): JsonObject {
  const node = resolve(schema, root), result: JsonObject = { ...ui };
  if (isObject(node) && node.type !== 'array') {
    const properties = isObject(node.properties) ? node.properties : {};
    const extra = node.additionalProperties;
    const keys = new Set([...Object.keys(properties), ...(isObject(data) && (isObject(extra) || extra === true) ? Object.keys(data) : [])]);
    if (keys.size || isObject(extra) || extra === true) {
      if (isObject(extra) || extra === true) result.additionalProperties = makeUi(extra, root, isObject(ui.additionalProperties) ? ui.additionalProperties : {}, [...path, '*'], undefined, undefined);
      for (const key of keys) {
        const child = properties[key] ?? extra;
        result[key] = makeUi((typeof child === 'boolean' || isObject(child)) ? child : true, root, isObject(ui[key]) ? ui[key] as JsonObject : {}, [...path, key], selected, isObject(data) ? data[key] : undefined);
      }
      return result;
    }
  }
  if (selected && at(selected, path) === undefined) result['ui:disabled'] = true;
  if (isObject(node) && node.format === 'credential-ref') result['ui:widget'] = 'credentialRef';
  return result;
}

export default function ConfigForm({
  schema,
  uiSchema,
  globalConfig,
  overrides,
  onSave,
}: {
  schema: JsonSchema;
  uiSchema?: JsonObject;
  globalConfig: JsonObject;
  overrides?: JsonObject;
  onSave(value: JsonObject): void;
}) {
  const [value, setValue] = useState<JsonObject>(overrides ?? globalConfig);
  useEffect(() => setValue(overrides ?? globalConfig), [globalConfig, overrides]);
  const effective = overrides === undefined ? value : (merge(globalConfig, value) as JsonObject);
  const paths = useMemo(() => fields(schema, schema, effective), [schema, effective]);
  const hidden = useMemo(() => hiddenTopLevelPaths(uiSchema), [uiSchema]);
  const ui = makeUi(schema, schema, uiSchema ?? {}, [], overrides === undefined ? undefined : value, effective);

  return (
    <div className="config-form">
      {overrides !== undefined && (
        <fieldset>
          <legend>Bot 覆盖字段</legend>
          <p className="secondary" style={{ margin: 0 }}>
            未勾选的字段继承全局配置；数组作为整体替换。字典中编辑的键自动覆盖，继承的键不能删除。
          </p>
          <div className="override-grid">
            {paths.filter(path => !(path.length === 1 && hidden.has(path[0]))).map(path => {
              const active = at(value, path) !== undefined;
              return (
                <label className={`config-override${active ? ' is-active' : ''}`} key={JSON.stringify(path)}>
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={event =>
                      setValue(current =>
                        setAt(
                          current,
                          path,
                          event.target.checked ? at(effective, path) ?? initialValue(schema, schema, path) : undefined,
                        ),
                      )
                    }
                  />
                  <span>{path.join(' › ')}</span>
                  <span className={`badge ${active ? 'badge-accent' : 'badge-neutral'}`}>{active ? '覆盖' : '继承'}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}
      <Form
        schema={withoutDefaults(schema) as RJSFSchema}
        uiSchema={ui as UiSchema}
        validator={validator}
        widgets={{ credentialRef: CredentialWidget }}
        formData={effective}
        onChange={({ formData }) => {
          if (!isObject(formData)) return;
          if (overrides === undefined) setValue(formData);
          else
            setValue(current => {
              const all = [...fields(schema, schema, effective), ...fields(schema, schema, formData)];
              const unique = [...new Map(all.map(path => [JSON.stringify(path), path])).values()];
              return unique.reduce((next, path) => {
                const previous = at(effective, path),
                  nextValue = at(formData, path);
                const changed = JSON.stringify(previous) !== JSON.stringify(nextValue);
                return at(current, path) !== undefined || (changed && nextValue !== undefined && isAdditionalPath(schema, schema, path))
                  ? setAt(next, path, nextValue)
                  : next;
              }, current);
            });
        }}
        onSubmit={() => onSave(value)}
      >
        <button type="submit" className="button">
          保存配置
        </button>
      </Form>
    </div>
  );
}
