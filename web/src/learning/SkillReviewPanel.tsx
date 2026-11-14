import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotSkillReviewInput } from '../../../host-core/index.js';
import { useText } from '../ui';
import './SkillReviewPanel.css';

export type SkillReviewCall = (input: BotSkillReviewInput) => Promise<unknown>;

type Translate = ReturnType<typeof useText>;

type LearningSource = {
  mode: 'review' | 'learn' | 'curate';
  createdAt: string;
  contentRevision?: number;
  jobId?: string;
  conversationId?: string;
  afterEntryId?: number;
  throughEntryId?: number;
};

type LearnedSkillSummary = {
  skillId: string;
  name: string;
  path: string;
  category?: string;
  description: string | null;
  revision?: number;
  stateRevision?: number;
  headRevision?: number;
  state: 'active' | 'stale' | 'archived' | string;
  pinned: boolean;
  locked: boolean;
  visibilityScope?: 'private' | 'assigned' | 'global';
  useCount?: number;
  viewCount?: number;
  patchCount?: number;
  lastActivityAt?: string;
  createdAt?: string;
  updatedAt?: string;
  source: LearningSource | null;
  deployment?: { status: string; error?: { code?: string; message?: string } | null };
};

type LearnedSkillDetail = LearnedSkillSummary & {
  files: Record<string, string>;
};

type StateFilter = 'all' | 'active' | 'stale' | 'archived';

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.match(/\b(?:REVISION_CONFLICT|REQUEST_CONFLICT|NOT_FOUND|PAYLOAD_TOO_LARGE|INVALID_STATE|CENTER_OFFLINE|OFFLINE|NOT_CONNECTED|UNSUPPORTED_METHOD)\b/)?.[0];
}

function failureText(error: unknown, t: Translate) {
  switch (errorCode(error)) {
    case 'REVISION_CONFLICT':
    case 'REQUEST_CONFLICT':
      return t('技能状态已在后台更新，请刷新后重试。', 'Skill changed in the background. Refresh and retry.');
    case 'NOT_FOUND':
      return t('未找到该技能或版本，请刷新列表。', 'Skill or revision not found. Refresh the list.');
    case 'INVALID_STATE': {
      const msg = error instanceof Error ? error.message : String(error ?? '');
      if (msg.includes('shared')) {
        return t('共享或全局技能已在中心固定，请先在中心管理页改回私有后再归档。', 'Shared or global skills cannot be archived directly.');
      }
      return t('当前技能状态不支持此操作，请刷新核对。', 'This action is not valid for the current skill state.');
    }
    case 'PAYLOAD_TOO_LARGE':
      return t('文件内容过大，超出预览上限。', 'This file is too large to preview.');
    case 'CENTER_OFFLINE':
    case 'OFFLINE':
    case 'NOT_CONNECTED':
      return t('连接暂不可用，恢复连接后请刷新。', 'Connection unavailable. Refresh after reconnecting.');
    case 'UNSUPPORTED_METHOD':
      return t('请先将目标 Host 与中心升级到最新版本。', 'Update the target Host and Center to manage learned skills.');
    default:
      return t('操作未确认，请刷新核对最新状态。', 'Operation unconfirmed. Refresh to check the latest status.');
  }
}

function sourceTitle(source: LearningSource | null | undefined, t: Translate) {
  if (!source) return t('手动或迁移技能', 'Managed skill');
  switch (source.mode) {
    case 'review': return t('空闲静默复盘', 'Idle reflection');
    case 'curate': return t('技能定期整理', 'Skill curation');
    default: return t('对话显式学习', 'Explicit learning');
  }
}

function stateLabel(state: string, t: Translate) {
  switch (state) {
    case 'stale': return t('待观察', 'Stale');
    case 'archived': return t('已归档', 'Archived');
    default: return t('生效中', 'Active');
  }
}

function scopeLabel(scope: string | undefined, t: Translate) {
  switch (scope) {
    case 'global': return t('全局可用', 'Global');
    case 'assigned': return t('指定共享', 'Shared');
    default: return t('仅本 Bot', 'Private');
  }
}

function deploymentLabel(status: string | undefined, t: Translate) {
  switch (status) {
    case 'applied': return t('已生效', 'Applied');
    case 'waiting-idle': return t('待空闲生效', 'Waiting for idle');
    case 'queued':
    case 'downloading':
    case 'preparing':
    case 'activating':
    case 'pending': return t('同步中', 'Syncing');
    case 'disabled': return t('已停用', 'Disabled');
    case 'failed': return t('部署异常', 'Deploy failed');
    default: return null;
  }
}

export function SkillReviewPanel({ connected, call }: { connected: boolean; call: SkillReviewCall }) {
  const t = useText();
  if (!connected) {
    return (
      <p className="skill-review-muted">
        {t('连接目标 Host 后可查看和管理已学技能。', 'Connect to the target Host to inspect and manage learned skills.')}
      </p>
    );
  }
  return <LearnedSkillsSession call={call} t={t} />;
}

function LearnedSkillsSession({ call, t }: { call: SkillReviewCall; t: Translate }) {
  const [items, setItems] = useState<LearnedSkillSummary[] | null>(null);
  const [filter, setFilter] = useState<StateFilter>('all');
  const [detail, setDetail] = useState<LearnedSkillDetail | null>(null);
  const [selectedFile, setSelectedFile] = useState<string>('SKILL.md');
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const callRef = useRef(call);
  callRef.current = call;

  const run = useCallback(<T,>(work: () => Promise<T>, receive: (value: T) => void) => {
    const current = ++sequence.current;
    setBusy(true);
    setFailure(null);
    void (async () => {
      try {
        const result = await work();
        if (sequence.current === current) receive(result);
      } catch (error) {
        if (sequence.current === current) setFailure({ error });
      } finally {
        if (sequence.current === current) setBusy(false);
      }
    })();
  }, []);

  const loadList = useCallback(() => {
    setDetail(null);
    setNotice(null);
    run(async () => {
      const result = await callRef.current({ action: 'list' }) as { items: LearnedSkillSummary[] } | null;
      if (!Array.isArray(result?.items)) throw new Error('Invalid learned skill list');
      return result.items;
    }, setItems);
  }, [run]);

  useEffect(() => {
    loadList();
    return () => { sequence.current++; };
  }, [loadList]);

  const counts = useMemo(() => {
    const list = items ?? [];
    return {
      all: list.length,
      active: list.filter(item => item.state === 'active').length,
      stale: list.filter(item => item.state === 'stale').length,
      archived: list.filter(item => item.state === 'archived').length,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    const list = items ?? [];
    if (filter === 'all') return list;
    return list.filter(item => item.state === filter);
  }, [items, filter]);

  function syncSummaryIntoList(updated: LearnedSkillSummary) {
    setItems(prev => prev ? prev.map(item => item.skillId === updated.skillId ? { ...item, ...updated } : item) : prev);
  }

  function openSkill(skill: LearnedSkillSummary) {
    setNotice(null);
    run(async () => {
      const result = await callRef.current({ action: 'read', skillId: skill.skillId }) as LearnedSkillDetail | null;
      if (!result || result.skillId !== skill.skillId || !result.files) {
        throw new Error('Invalid skill detail');
      }
      return result;
    }, loaded => {
      setDetail(loaded);
      const paths = Object.keys(loaded.files);
      setSelectedFile(paths.includes('SKILL.md') ? 'SKILL.md' : (paths[0] ?? 'SKILL.md'));
      syncSummaryIntoList(loaded);
    });
  }

  function reloadDetail(skillId: string, msg?: string) {
    run(async () => {
      const result = await callRef.current({ action: 'read', skillId }) as LearnedSkillDetail | null;
      if (!result || result.skillId !== skillId || !result.files) {
        throw new Error('Invalid skill detail');
      }
      return result;
    }, loaded => {
      setDetail(loaded);
      const paths = Object.keys(loaded.files);
      if (!paths.includes(selectedFile)) {
        setSelectedFile(paths.includes('SKILL.md') ? 'SKILL.md' : (paths[0] ?? 'SKILL.md'));
      }
      syncSummaryIntoList(loaded);
      if (msg) setNotice(msg);
    });
  }

  function togglePin(current: LearnedSkillDetail) {
    const nextPinned = !current.pinned;
    run(async () => {
      return await callRef.current({
        action: 'pin',
        skillId: current.skillId,
        pinned: nextPinned,
        requestId: newRequestId(),
      }) as LearnedSkillSummary;
    }, updated => {
      setDetail(prev => prev && prev.skillId === current.skillId ? { ...prev, ...updated } : prev);
      syncSummaryIntoList(updated);
      setNotice(nextPinned
        ? t('已固定技能，不会因闲置自动归档。', 'Skill pinned; exempt from inactivity archival.')
        : t('已取消固定，恢复正常闲置过期计时。', 'Skill unpinned.'));
    });
  }

  function toggleLock(current: LearnedSkillDetail) {
    const nextLocked = !current.locked;
    run(async () => {
      return await callRef.current({
        action: 'lock',
        skillId: current.skillId,
        locked: nextLocked,
        requestId: newRequestId(),
      }) as LearnedSkillSummary;
    }, updated => {
      setDetail(prev => prev && prev.skillId === current.skillId ? { ...prev, ...updated } : prev);
      syncSummaryIntoList(updated);
      setNotice(nextLocked
        ? t('已锁定技能，自学习不会再自动覆盖。', 'Skill locked against autonomous edits.')
        : t('已解除锁定，允许后续复盘继续演进。', 'Skill unlocked.'));
    });
  }

  function toggleArchive(current: LearnedSkillDetail) {
    const archiving = current.state !== 'archived';
    run(async () => {
      return await callRef.current({
        action: archiving ? 'archive' : 'restore',
        skillId: current.skillId,
        requestId: newRequestId(),
      }) as LearnedSkillSummary;
    }, updated => {
      setDetail(prev => prev && prev.skillId === current.skillId ? { ...prev, ...updated } : prev);
      syncSummaryIntoList(updated);
      setNotice(archiving
        ? t('技能已归档并从当前 Bot 停用，可随时在此恢复。', 'Skill archived and disabled on this Bot.')
        : t('技能已恢复启用。', 'Skill restored and re-enabled.'));
    });
  }

  const filePaths = useMemo(() => Object.keys(detail?.files ?? {}).sort((a, b) => {
    if (a === 'SKILL.md') return -1;
    if (b === 'SKILL.md') return 1;
    return a.localeCompare(b);
  }), [detail?.files]);

  return (
    <section className="skill-review-panel" aria-busy={busy}>
      <header className="skill-review-header">
        <div>
          <h3>{detail ? detail.name : t('已学技能库', 'Learned Skills')}</h3>
          <p className="skill-review-muted">
            {detail
              ? `${stateLabel(detail.state, t)} · ${scopeLabel(detail.visibilityScope, t)}`
              : t('空闲复盘提炼的技能会自动对本 Bot 生效；30 天未用会自动归档，可在中心调整跨 Bot 共享范围。', 'Skills learned during idle reflection auto-apply to this Bot, auto-archive after 30 days unused, and can be shared in Center.')}
          </p>
        </div>
        <div className="skill-review-header-btns">
          {detail ? (
            <button type="button" disabled={busy} onClick={() => reloadDetail(detail.skillId)}>
              {t('刷新', 'Refresh')}
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={loadList}>
            {detail ? t('返回列表', 'Back') : t('刷新', 'Refresh')}
          </button>
        </div>
      </header>

      {busy ? <p className="skill-review-muted" role="status">{t('正在同步技能数据…', 'Syncing skills…')}</p> : null}
      {failure ? <p role="alert">{failureText(failure.error, t)}</p> : null}
      {notice ? <p className="skill-review-notice" role="status">{notice}</p> : null}

      {!detail ? (
        <>
          <div className="skill-review-filters" role="tablist" aria-label={t('按状态筛选', 'Filter by state')}>
            {([
              ['all', `${t('全部', 'All')} (${counts.all})`],
              ['active', `${t('生效中', 'Active')} (${counts.active})`],
              ['stale', `${t('待观察', 'Stale')} (${counts.stale})`],
              ['archived', `${t('已归档', 'Archived')} (${counts.archived})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={filter === key}
                className={filter === key ? 'is-active' : ''}
                onClick={() => setFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {filteredItems.length === 0 && items !== null ? (
            <p className="skill-review-muted">
              {counts.all === 0
                ? t('该 Bot 尚未沉淀自学习技能。完成复杂任务并在空闲静置后会自动提炼。', 'No learned skills yet. Complex workflows will be distilled automatically during idle windows.')
                : t('当前筛选下没有技能。', 'No skills match this filter.')}
            </p>
          ) : null}

          {filteredItems.length > 0 ? (
            <ul className="skill-review-list">
              {filteredItems.map(item => (
                <li key={item.skillId}>
                  <button type="button" className="skill-review-card" disabled={busy} onClick={() => openSkill(item)}>
                    <div className="skill-review-card-top">
                      <strong>{item.name}</strong>
                      <div className="skill-review-badges">
                        <span className={`skill-badge is-${item.state}`}>{stateLabel(item.state, t)}</span>
                        <span className="skill-badge">{scopeLabel(item.visibilityScope, t)}</span>
                        {item.pinned ? <span className="skill-badge is-accent">📌 Pin</span> : null}
                        {item.locked ? <span className="skill-badge">🔒 Lock</span> : null}
                      </div>
                    </div>
                    {item.description ? <p className="skill-review-desc">{item.description}</p> : null}
                    <div className="skill-review-card-meta">
                      <span>{sourceTitle(item.source, t)}</span>
                      <span>{t(`使用 ${item.useCount ?? 0} 次`, `${item.useCount ?? 0} uses`)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <>
          <div className="skill-review-source">
            {detail.description ? <p><strong>{detail.description}</strong></p> : null}
            <div className="skill-review-badges">
              <span className={`skill-badge is-${detail.state}`}>{stateLabel(detail.state, t)}</span>
              <span className="skill-badge">{scopeLabel(detail.visibilityScope, t)}</span>
              {deploymentLabel(detail.deployment?.status, t) ? (
                <span className="skill-badge">{deploymentLabel(detail.deployment?.status, t)}</span>
              ) : null}
              <span className="skill-badge">{t(`已用 ${detail.useCount ?? 0} 次`, `${detail.useCount ?? 0} uses`)}</span>
              <span className="skill-badge">{t(`修订 ${detail.patchCount ?? 0} 次`, `${detail.patchCount ?? 0} edits`)}</span>
            </div>
            <p className="skill-review-muted">
              {sourceTitle(detail.source, t)}
              {detail.updatedAt ? ` · ${new Date(detail.updatedAt).toLocaleString()}` : ''}
            </p>
          </div>

          <div className="skill-review-actions">
            {detail.state !== 'archived' ? (
              <button type="button" disabled={busy} onClick={() => togglePin(detail)}>
                {detail.pinned ? t('📌 取消固定', '📌 Unpin') : t('📌 固定不过期', '📌 Pin')}
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => toggleLock(detail)}>
              {detail.locked ? t('🔓 解除锁定', '🔓 Unlock') : t('🔒 锁定防改写', '🔒 Lock')}
            </button>
            <button
              type="button"
              className={detail.state === 'archived' ? 'skill-review-primary' : ''}
              disabled={busy}
              onClick={() => toggleArchive(detail)}
            >
              {detail.state === 'archived' ? t('恢复启用', 'Restore') : t('归档停用', 'Archive')}
            </button>
          </div>

          <div className="skill-review-file">
            {filePaths.length > 1 ? (
              <div className="skill-review-filters">
                {filePaths.map(fp => (
                  <button
                    key={fp}
                    type="button"
                    className={selectedFile === fp ? 'is-active' : ''}
                    onClick={() => setSelectedFile(fp)}
                  >
                    <code>{fp}</code>
                  </button>
                ))}
              </div>
            ) : null}
            <figure className="skill-review-codebox">
              <figcaption><code>{selectedFile}</code></figcaption>
              <pre>{detail.files[selectedFile] || t('（空文件）', '(empty file)')}</pre>
            </figure>
          </div>
        </>
      )}
    </section>
  );
}
