// 模型选择器：默认展示「全部」，将已收藏模型置顶；支持搜索、星标收藏与首行「跟随全局默认」。
import { useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import type { CenterModelPicker } from '../../../host-core/desktop-client.js';
import type { ModelCatalogEntry } from '../../../host-core/index.js';
import type { DesktopIdentity, DesktopPanelApi } from '../../../desktop/web/src/types';
import { ErrorNotice, errorText, useText } from '../ui';
import { Badge, Chips, Row, SearchField } from './primitives';
import './model-picker.css';

type PickerScope = 'all' | 'starred';

type ModelWithOptionalProvider = ModelCatalogEntry & {
  providerName?: string;
  available?: boolean;
};

export interface ModelPickerProps {
  catalog: CenterModelPicker;
  api: DesktopPanelApi;
  identity: DesktopIdentity;
  value?: string | null;
  onChange(modelRef: string): void;
  onStarsChange(starredModels: string[]): void;
  disabled?: boolean;
  allowInherit?: boolean;
  globalDefaultModelRef?: string | null;
  onSelectInherit?: () => void;
  onOpenCenterAdmin?: () => void;
}

const providerOf = (model: ModelWithOptionalProvider): string => {
  if (model.providerName && model.providerName.trim()) return model.providerName.trim();
  const slash = model.modelRef.indexOf('/');
  return slash > 0 ? model.modelRef.slice(0, slash) : 'default';
};

const tokensText = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

export function ModelPicker({
  catalog,
  api,
  identity,
  value,
  onChange,
  onStarsChange,
  disabled,
  allowInherit = false,
  globalDefaultModelRef,
  onSelectInherit,
  onOpenCenterAdmin,
}: ModelPickerProps) {
  const t = useText();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<PickerScope>('all');
  const [pendingStar, setPendingStar] = useState<string | null>(null);
  const [starError, setStarError] = useState('');

  const starredSet = useMemo(() => new Set(catalog.starredModels), [catalog.starredModels]);
  const allModels = catalog.models as ModelWithOptionalProvider[];

  const globalDefaultName = useMemo(() => {
    if (!globalDefaultModelRef) return undefined;
    const found = allModels.find(m => m.modelRef === globalDefaultModelRef);
    return found?.name ?? globalDefaultModelRef.split('/').pop() ?? globalDefaultModelRef;
  }, [allModels, globalDefaultModelRef]);

  const { starredMatched, groupedRest, totalMatched } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = allModels.filter(model => {
      if (scope === 'starred' && !starredSet.has(model.modelRef)) return false;
      if (!q) return true;
      const provider = providerOf(model).toLowerCase();
      return (
        model.name.toLowerCase().includes(q)
        || model.modelRef.toLowerCase().includes(q)
        || provider.includes(q)
      );
    });

    const starred: ModelWithOptionalProvider[] = [];
    const restByProvider = new Map<string, ModelWithOptionalProvider[]>();
    for (const model of matched) {
      if (starredSet.has(model.modelRef)) {
        starred.push(model);
      } else {
        const group = providerOf(model);
        const list = restByProvider.get(group);
        if (list) list.push(model);
        else restByProvider.set(group, [model]);
      }
    }

    return {
      starredMatched: starred,
      groupedRest: Array.from(restByProvider.entries()),
      totalMatched: matched.length,
    };
  }, [allModels, query, scope, starredSet]);

  const toggleStar = async (modelRef: string, starred: boolean) => {
    setPendingStar(modelRef);
    setStarError('');
    try {
      const result = await api.broker(identity, 'center_model_star_set', { modelRef, starred: !starred });
      onStarsChange(result.starredModels);
    } catch (failure) {
      setStarError(errorText(failure));
    } finally {
      setPendingStar(null);
    }
  };

  const renderModelRow = (model: ModelWithOptionalProvider) => {
    const starred = starredSet.has(model.modelRef);
    const unavailable = model.available === false;
    return (
      <Row
        key={model.modelRef}
        radio
        selected={value === model.modelRef}
        disabled={disabled}
        title={model.name}
        subtitle={`${providerOf(model)} · ${model.modelRef}`}
        onClick={() => onChange(model.modelRef)}
        meta={(
          <div className="model-picker-meta">
            {unavailable ? <Badge tone="warn">{t('不可用', 'Unavailable')}</Badge> : null}
            {model.reasoning ? <Badge>{t('推理', 'Reasoning')}</Badge> : null}
            {model.contextWindow > 0 ? <span className="model-picker-ctx">{tokensText(model.contextWindow)}</span> : null}
            <button
              type="button"
              className={`model-picker-star${starred ? ' is-starred' : ''}`}
              aria-label={starred ? t(`取消收藏 ${model.name}`, `Unstar ${model.name}`) : t(`收藏 ${model.name}`, `Star ${model.name}`)}
              disabled={pendingStar === model.modelRef}
              onClick={event => {
                event.stopPropagation();
                void toggleStar(model.modelRef, starred);
              }}
            >
              <Star aria-hidden="true" fill={starred ? 'currentColor' : 'none'} />
            </button>
          </div>
        )}
      />
    );
  };

  const hasAnyCatalogModels = allModels.length > 0;

  return (
    <div className="model-picker">
      <div className="model-picker-controls">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t('搜索模型或服务商', 'Search model or provider')}
        />
        <Chips
          label={t('模型筛选', 'Model filter')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: t('全部', 'All') },
            { value: 'starred', label: t('★ 收藏', '★ Starred') },
          ]}
        />
      </div>

      <ErrorNotice error={starError} onDismiss={() => setStarError('')} compact />

      <div className="model-picker-list">
        {allowInherit && onSelectInherit ? (
          <div className="bs-card">
            <Row
              radio
              selected={value === undefined}
              disabled={disabled}
              title={t('跟随全局默认', 'Follow global default')}
              subtitle={
                globalDefaultName
                  ? `${t('当前默认：', 'Current default: ')}${globalDefaultName}`
                  : t('当前全局未设置默认模型', 'No global default model configured')
              }
              onClick={onSelectInherit}
            />
          </div>
        ) : null}

        {!hasAnyCatalogModels ? (
          <div className="model-picker-empty">
            <p className="model-picker-empty-text">
              {t('尚未配置可用模型或服务商', 'No models or providers configured yet')}
            </p>
            {onOpenCenterAdmin ? (
              <button type="button" className="bs-btn is-primary is-small" onClick={onOpenCenterAdmin}>
                {t('去配置模型与服务商 →', 'Configure models & providers →')}
              </button>
            ) : null}
          </div>
        ) : totalMatched === 0 ? (
          <div className="model-picker-empty">
            <p className="model-picker-empty-text">
              {scope === 'starred' && catalog.starredModels.length === 0
                ? t('暂无收藏模型，可切换到「全部」后点亮星标', 'No starred models yet; switch to All and star models')
                : t('没有匹配的模型', 'No matching models')}
            </p>
            {scope === 'starred' ? (
              <button type="button" className="bs-btn is-ghost is-small" onClick={() => setScope('all')}>
                {t('查看全部模型', 'Show all models')}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {starredMatched.length > 0 ? (
              <div className="model-picker-group">
                <div className="model-picker-group-head">★ {t('已收藏', 'Starred')}</div>
                <div className="bs-card">{starredMatched.map(renderModelRow)}</div>
              </div>
            ) : null}

            {groupedRest.map(([provider, items]) => (
              <div key={provider} className="model-picker-group">
                <div className="model-picker-group-head">{provider}</div>
                <div className="bs-card">{items.map(renderModelRow)}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
