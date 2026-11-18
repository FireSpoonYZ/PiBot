import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Star } from 'lucide-react';
import type { ModelPickerResponse } from '@e-launcher/center-contract';
import { api } from '../api';
import { SearchInput, Segmented } from './primitives';

const providerOf = (ref: string) => ref.slice(0, ref.indexOf('/'));
const formatTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;

export interface CenterModelPickerProps {
  catalog: ModelPickerResponse;
  providerNames: Map<string, string>;
  value: string | null | undefined;
  onChange(modelRef: string | null): void;
  onStarsChange(starredModels: string[]): void;
  disabled?: boolean;
}

export function CenterModelPicker({
  catalog,
  providerNames,
  value,
  onChange,
  onStarsChange,
  disabled = false,
}: CenterModelPickerProps) {
  const [starred, setStarred] = useState(catalog.starredModels);
  const [scope, setScope] = useState<'all' | 'star'>(() =>
    catalog.models.some(m => catalog.starredModels.includes(m.modelRef)) ? 'star' : 'all',
  );
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [savingStar, setSavingStar] = useState(false);
  const [starError, setStarError] = useState('');
  const writing = useRef(false);

  useEffect(() => {
    setStarred(catalog.starredModels);
  }, [catalog.starredModels]);

  const starSet = useMemo(() => new Set(starred), [starred]);
  const starCount = useMemo(
    () => catalog.models.filter(m => starSet.has(m.modelRef)).length,
    [catalog.models, starSet],
  );

  const q = query.trim().toLowerCase();
  const matching = useMemo(
    () =>
      catalog.models.filter(
        m => !q || m.name.toLowerCase().includes(q) || m.modelRef.toLowerCase().includes(q),
      ),
    [catalog.models, q],
  );

  const scoped = useMemo(
    () => matching.filter(m => scope === 'all' || starSet.has(m.modelRef)),
    [matching, scope, starSet],
  );

  const providers = useMemo(
    () => [...new Set(scoped.map(m => providerOf(m.modelRef)))],
    [scoped],
  );
  const activeProvider = providers.includes(providerFilter) ? providerFilter : '';

  const visible = useMemo(
    () => scoped.filter(m => !activeProvider || providerOf(m.modelRef) === activeProvider),
    [scoped, activeProvider],
  );

  const groups = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const item of visible) {
      const pid = providerOf(item.modelRef);
      const list = map.get(pid);
      if (list) list.push(item);
      else map.set(pid, [item]);
    }
    return [...map.entries()];
  }, [visible]);

  const toggleStar = async (modelRef: string) => {
    if (writing.current) return;
    writing.current = true;
    setSavingStar(true);
    setStarError('');
    try {
      const next = !starSet.has(modelRef);
      const res = await api.setModelStar(modelRef, next);
      setStarred(res.starredModels);
      onStarsChange(res.starredModels);
    } catch (e) {
      setStarError(e instanceof Error ? e.message : String(e));
    } finally {
      writing.current = false;
      setSavingStar(false);
    }
  };

  return (
    <div className="cw-picker">
      <Segmented<'all' | 'star'>
        label="模型范围"
        value={scope}
        disabled={disabled}
        options={[
          { value: 'star', label: `收藏 (${starCount})` },
          { value: 'all', label: `全部 (${catalog.models.length})` },
        ]}
        onChange={setScope}
      />

      <SearchInput
        value={query}
        disabled={disabled}
        placeholder="搜索模型名称或 ID…"
        onChange={setQuery}
      />

      {providers.length > 1 ? (
        <div className="cw-chips cw-picker-providers" role="radiogroup" aria-label="按服务商筛选">
          <button
            type="button"
            role="radio"
            aria-checked={!activeProvider}
            className={`cw-chip cw-chip-sm${!activeProvider ? ' is-active' : ''}`}
            onClick={() => setProviderFilter('')}
          >
            全部服务商
          </button>
          {providers.map(pid => (
            <button
              key={pid}
              type="button"
              role="radio"
              aria-checked={activeProvider === pid}
              className={`cw-chip cw-chip-sm${activeProvider === pid ? ' is-active' : ''}`}
              onClick={() => setProviderFilter(pid)}
            >
              {providerNames.get(pid) || pid}
            </button>
          ))}
        </div>
      ) : null}

      {starError ? <p className="inline-error">{starError}</p> : null}

      <div className="cw-picker-scroll">
        {groups.map(([pid, list]) => (
          <div key={pid} className="cw-picker-group">
            <div className="cw-picker-group-head">{providerNames.get(pid) || pid}</div>
            <div className="cw-card">
              {list.map(model => {
                const selected = value === model.modelRef;
                const isStar = starSet.has(model.modelRef);
                return (
                  <div
                    key={model.modelRef}
                    className={`cw-row is-split${selected ? ' is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="cw-row-main"
                      disabled={disabled}
                      onClick={() => onChange(model.modelRef)}
                    >
                      <span className="cw-row-text">
                        <span className="cw-row-title">{model.name}</span>
                        <span className="cw-row-sub">
                          {model.modelRef} · {formatTokens(model.contextWindow)}
                          {model.reasoning ? ' · 推理' : ''}
                        </span>
                      </span>
                      <span className={`cw-row-check${selected ? ' is-on' : ''}`} aria-hidden="true">
                        {selected ? <Check size={17} /> : null}
                      </span>
                    </button>
                    <span className="cw-row-trailing">
                      <button
                        type="button"
                        className={`cw-star-btn${isStar ? ' is-starred' : ''}`}
                        aria-label={isStar ? '取消收藏' : '收藏模型'}
                        disabled={disabled || savingStar}
                        onClick={() => void toggleStar(model.modelRef)}
                      >
                        <Star size={16} fill={isStar ? 'currentColor' : 'none'} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {visible.length === 0 ? (
          <div className="cw-empty">
            <strong>
              {catalog.models.length === 0
                ? '暂无可用模型'
                : scope === 'star' && starCount === 0
                  ? '还没有收藏常用模型'
                  : '没有匹配的模型'}
            </strong>
            <p className="secondary">
              {catalog.models.length === 0
                ? '先在下方配置并启用一个模型服务商（完成登录或填写密钥），即可在此选择默认模型。'
                : scope === 'star'
                  ? '切换到「全部」点击模型右侧星标，可把常用模型固定在这里。'
                  : '换个关键词试试，或清空筛选条件。'}
            </p>
            <div className="action-row" style={{ justifyContent: 'center', marginBottom: 0 }}>
              {scope === 'star' && catalog.models.length > 0 ? (
                <button type="button" className="cw-btn is-small" onClick={() => setScope('all')}>
                  查看全部 ({matching.length})
                </button>
              ) : null}
              {q || activeProvider ? (
                <button
                  type="button"
                  className="cw-btn is-small is-ghost"
                  onClick={() => {
                    setQuery('');
                    setProviderFilter('');
                  }}
                >
                  清空筛选
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {value ? (
        <div className="cw-picker-footer">
          <span className="secondary">当前：{value}</span>
          <button
            type="button"
            className="cw-btn is-small is-ghost is-danger"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            清空默认模型
          </button>
        </div>
      ) : null}
    </div>
  );
}
