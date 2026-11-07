import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search, Star, X } from 'lucide-react';
import type { CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { errorText, useText } from '../ui';
import './model-picker.css';

type Props = {
  catalog: CenterModelPicker;
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  value: string | null | undefined;
  onChange(modelRef: string): void;
  onStarsChange(starredModels: string[]): void;
  disabled?: boolean;
};

const providerOf = (ref: string) => ref.slice(0, ref.indexOf('/'));
const tokens = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;

export function ModelPicker({ catalog, api, identity, value, onChange, onStarsChange, disabled = false }: Props) {
  const t = useText();
  const [starred, setStarred] = useState(catalog.starredModels);
  const [scope, setScope] = useState<'all' | 'star'>(() =>
    catalog.models.some(model => catalog.starredModels.includes(model.modelRef)) ? 'star' : 'all');
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const [savingStar, setSavingStar] = useState(false);
  const [error, setError] = useState('');
  const writing = useRef(false);
  const alive = useRef(false);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setStarred(catalog.starredModels); }, [catalog.starredModels]);

  const starSet = useMemo(() => new Set(starred), [starred]);
  const scoped = catalog.models.filter(model => scope === 'all' || starSet.has(model.modelRef));
  const providers = [...new Set(scoped.map(model => providerOf(model.modelRef)))];
  const activeProvider = providers.includes(provider) ? provider : '';
  const q = query.trim().toLowerCase();
  const matching = catalog.models.filter(model =>
    (!activeProvider || providerOf(model.modelRef) === activeProvider) &&
    (!q || `${model.name} ${model.modelRef}`.toLowerCase().includes(q)));
  const visible = matching.filter(model => scope === 'all' || starSet.has(model.modelRef));
  const starCount = catalog.models.filter(model => starSet.has(model.modelRef)).length;
  const groups = [...new Set(visible.map(model => providerOf(model.modelRef)))];
  const selectedModel = catalog.models.find(model => model.modelRef === value);
  const focusRef = visible.some(model => model.modelRef === value) ? value : visible[0]?.modelRef;

  async function toggleStar(ref: string) {
    if (disabled || writing.current) return;
    const previous = starred;
    const nextStarred = !starSet.has(ref);
    writing.current = true;
    setSavingStar(true);
    setError('');
    setStarred(nextStarred ? [...previous, ref] : previous.filter(item => item !== ref));
    try {
      const result = await api.broker(identity, 'center_model_star_set', { modelRef: ref, starred: nextStarred });
      onStarsChange(result.starredModels);
      if (alive.current) setStarred(result.starredModels);
    } catch (failure) {
      if (alive.current) {
        setStarred(previous);
        setError(t('收藏更新未确认，请重试：', 'Star update not confirmed. Retry: ') + errorText(failure));
      }
    } finally {
      writing.current = false;
      if (alive.current) setSavingStar(false);
    }
  }

  function navigate(event: KeyboardEvent<HTMLButtonElement>, ref: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      void toggleStar(ref);
      return;
    }
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 :
      event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.closest('[role="radiogroup"]')!.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const next = rows[(rows.indexOf(event.currentTarget) + step + rows.length) % rows.length];
    next.focus();
    next.click();
  }

  return (
    <div className="model-picker">
      <div className="model-picker-scopes" role="group" aria-label={t('模型范围', 'Model scope')}>
        <button type="button" aria-pressed={scope === 'all'} onClick={() => { setScope('all'); setProvider(''); }}>
          All <span>{catalog.models.length}</span>
        </button>
        <button type="button" aria-pressed={scope === 'star'} onClick={() => { setScope('star'); setProvider(''); }}>
          <Star aria-hidden="true" /> Star <span>{starCount}</span>
        </button>
      </div>
      <p className="model-picker-hint">{t('收藏即时同步到中心；选择模型后仍需保存。', 'Stars sync to Center immediately. Save to apply your model selection.')}</p>
      {catalog.models.length > 0 ? (
        <div className="model-picker-search">
          <Search aria-hidden="true" />
          <input type="search" value={query} aria-label={t('搜索模型', 'Search models')}
            placeholder={t('搜索模型名称、ID 或服务商', 'Search name, ID or provider')}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); }
            }} />
          {query ? <button type="button" aria-label={t('清空搜索', 'Clear search')} onClick={() => setQuery('')}><X /></button> : null}
        </div>
      ) : null}
      {providers.length > 1 ? (
        <div className="model-picker-providers" role="group" aria-label={t('服务商筛选', 'Filter providers')}>
          {['', ...providers].map(id => (
            <button key={id} type="button" aria-pressed={activeProvider === id} onClick={() => setProvider(id)}>
              {id || t('全部服务商', 'All providers')}
            </button>
          ))}
        </div>
      ) : null}
      {value && (!selectedModel || (scope === 'star' && !starSet.has(value))) ? (
        <p className="model-picker-current">
          {t('当前选择：', 'Selected: ')}{selectedModel?.name ?? value}
          <span>{selectedModel ? t('未加入 Star，模型选择保持不变', 'Not starred; selection is unchanged') : t('不在可用目录中，请检查服务商配置', 'Not available; check the provider configuration')}</span>
        </p>
      ) : null}
      {error ? <p className="model-picker-error" role="alert">{error}</p> : null}
      <div className="model-picker-list" role="radiogroup" aria-label={t('选择模型', 'Choose model')}>
        {groups.map(id => (
          <div key={id} className="model-picker-group">
            <div className="model-picker-group-title">{id}<span>{visible.filter(model => providerOf(model.modelRef) === id).length}</span></div>
            {visible.filter(model => providerOf(model.modelRef) === id).map(model => {
              const isStarred = starSet.has(model.modelRef);
              const selected = value === model.modelRef;
              return (
                <div key={model.modelRef} className={`model-picker-row${selected ? ' is-selected' : ''}`}>
                  <button type="button" className="model-picker-select" role="radio" aria-checked={selected}
                    tabIndex={focusRef === model.modelRef ? 0 : -1} disabled={disabled}
                    onClick={() => onChange(model.modelRef)} onKeyDown={event => navigate(event, model.modelRef)}>
                    <span className="model-picker-mark" aria-hidden="true">{selected ? <Check /> : null}</span>
                    <span className="model-picker-text">
                      <span className="model-picker-name">{model.name}</span>
                      <span className="model-picker-ref">{model.modelRef}</span>
                      <span className="model-picker-meta">{tokens(model.contextWindow)} ctx · {tokens(model.maxTokens)} max{model.reasoning ? t(' · 推理', ' · Reasoning') : ''}</span>
                    </span>
                  </button>
                  <button type="button" className="model-picker-star" aria-pressed={isStarred}
                    aria-label={`${isStarred ? t('取消收藏', 'Unstar') : t('收藏', 'Star')} ${model.modelRef}`}
                    title={isStarred ? t('取消收藏', 'Unstar') : t('加入 Star', 'Add to Star')}
                    disabled={disabled || savingStar} onClick={() => void toggleStar(model.modelRef)}>
                    <Star aria-hidden="true" fill={isStarred ? 'currentColor' : 'none'} />
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="model-picker-empty" role="status">
          <strong>{catalog.models.length === 0 ? t('暂无可用模型', 'No models available') :
            scope === 'star' && starCount === 0 ? t('还没有收藏模型', 'No starred models yet') : t('没有匹配的模型', 'No matching models')}</strong>
          <p>{catalog.models.length === 0 ? t('在中心配置并启用服务商后，All 会显示自动同步的模型。', 'Configure and enable a provider in Center to see its synced models.') :
            scope === 'star' ? t('到 All 中点击模型旁的星标，添加常用模型。', 'Star models in All to keep them here.') : t('试试其他名称或清空筛选。', 'Try another name or clear the filters.')}</p>
          {scope === 'star' && catalog.models.length > 0 ? <button type="button" onClick={() => setScope('all')}>{t('在 All 中查看', 'View in All')}{q ? ` (${matching.length})` : ''}</button> : null}
          {q || activeProvider ? <button type="button" onClick={() => { setQuery(''); setProvider(''); }}>{t('清空筛选', 'Clear filters')}</button> : null}
        </div>
      ) : null}
      <p className="model-picker-hint" title={catalog.sync.syncedAt ?? undefined}>
        {catalog.sync.error ? t('pi.dev 同步失败，当前显示已缓存目录。', 'pi.dev sync failed. Showing cached models.') :
          catalog.sync.syncedAt ? `pi.dev · ${t('同步于 ', 'Synced ')}${new Date(catalog.sync.syncedAt).toLocaleString()}` : t('使用中心已缓存的模型目录', 'Using the cached Center catalog')}
      </p>
    </div>
  );
}
