import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotSkillReviewInput } from '../../../host-core/index.js';
import { useText } from '../ui';
import './SkillReviewPanel.css';

export type SkillReviewCall = (input: BotSkillReviewInput) => Promise<unknown>;

type Translate = ReturnType<typeof useText>;
type Source = {
  mode: 'review' | 'learn' | 'curate';
  createdAt: string;
  jobId?: string;
  conversationId?: string;
  afterEntryId?: number;
  throughEntryId?: number;
};
type Draft = {
  skillId: string;
  name: string;
  revision: number;
  headRevision: number;
  publishedRevision: number | null;
  state: string;
  source: Source;
};
type Change = { path: string; kind: 'added' | 'removed' | 'modified' };
type ChangedFile = { path: string; before: string | null; after: string | null };
type DraftDetail = Draft & { changes: Change[]; file?: ChangedFile };
type Phase = { status: string; error?: { code?: string; message?: string } | null };
type ApprovalReceipt = { publication: Phase; deployment?: Phase };
type Approval = Extract<BotSkillReviewInput, { action: 'approve' }>;

function errorCode(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.match(/\b(?:REVISION_CONFLICT|REQUEST_CONFLICT|NOT_FOUND|PAYLOAD_TOO_LARGE|CENTER_OFFLINE|OFFLINE|NOT_CONNECTED|UNSUPPORTED_METHOD)\b/)?.[0];
}

function failureText(error: unknown, t: Translate) {
  switch (errorCode(error)) {
    case 'REVISION_CONFLICT':
    case 'REQUEST_CONFLICT': return t('草稿已变化。请刷新并重新审阅。', 'This draft changed. Refresh and review the new revision.');
    case 'NOT_FOUND': return t('该草稿已处理或移除。请刷新列表。', 'This draft was handled or removed. Refresh the list.');
    case 'PAYLOAD_TOO_LARGE': return t('文件过大，无法完整预览。请先将文件拆分或缩小。', 'This file is too large to preview in full. Split or reduce it before review.');
    case 'CENTER_OFFLINE':
    case 'OFFLINE':
    case 'NOT_CONNECTED': return t('连接暂不可用。恢复后请刷新。', 'The connection is unavailable. Refresh after reconnecting.');
    case 'UNSUPPORTED_METHOD': return t('请更新目标 Host 和中心后再审阅。', 'Update the target Host and Center to use Skill Review.');
    default: return t('操作结果未确认。请刷新核对草稿或发布状态。', 'The result is unconfirmed. Refresh to check the draft or publication status.');
  }
}

function receiptText(receipt: ApprovalReceipt, t: Translate) {
  if (receipt.publication.status === 'failed') return t('发布失败，草稿仍可审阅。', 'Publication failed. The draft is available for review.');
  if (receipt.publication.status === 'queued') return t('发布已排队。', 'Publication is queued.');
  if (receipt.publication.status === 'activating') return t('中心正在启用此版本。', 'The Center is activating this revision.');
  switch (receipt.deployment?.status) {
    case 'applied': return t('目标设备已应用此版本。', 'The target device applied this revision.');
    case 'failed': return t('中心已发布，目标设备应用失败。', 'Published to Center. Deployment failed on the target device.');
    case 'waiting-idle': return t('中心已发布，目标设备空闲后会应用。', 'Published to Center. The target device is waiting for an idle window.');
    case 'superseded': return t('目标设备的部署计划已变更。', 'The target device deployment plan has changed.');
    case 'removed': return t('目标设备已移除该 Skill。', 'The target device removed this Skill.');
    case 'downloading':
    case 'preparing':
    case 'activating': return t('中心已发布，目标设备正在应用。', 'Published to Center. The target device is applying it.');
    default: return t('中心已发布，等待目标设备应用。', 'Published to Center. Waiting for the target device.');
  }
}

function sourceTitle(source: Source, t: Translate) {
  switch (source.mode) {
    case 'review': return t('会话复盘', 'Conversation review');
    case 'curate': return t('Skill 策展', 'Skill curation');
    default: return t('显式学习', 'Manual learning');
  }
}

function changeTitle(kind: Change['kind'], t: Translate) {
  switch (kind) {
    case 'added': return t('新增', 'Added');
    case 'removed': return t('删除', 'Removed');
    default: return t('修改', 'Modified');
  }
}

function focusedComparison(file: ChangedFile) {
  if (file.before === null || file.after === null) return null;
  const before = file.before.split('\n');
  const after = file.after.split('\n');
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const trimStart = Math.max(0, start - 3);
  const trimEnd = Math.max(0, end - 3);
  if (trimStart === 0 && trimEnd === 0) return null;
  return {
    before: before.slice(trimStart, before.length - trimEnd).join('\n'),
    after: after.slice(trimStart, after.length - trimEnd).join('\n'),
  };
}

function FileComparison({ file, t }: { file: ChangedFile; t: Translate }) {
  const [full, setFull] = useState(false);
  const excerpt = useMemo(() => focusedComparison(file), [file]);
  const visible = full || !excerpt ? file : excerpt;
  return (
    <div className="skill-review-file">
      {excerpt ? (
        <button type="button" aria-pressed={full} onClick={() => setFull(value => !value)}>
          {full ? t('聚焦变更', 'Focus changes') : t('展开相同上下文', 'Show unchanged context')}
        </button>
      ) : null}
      <div className="skill-review-comparison">
        <figure>
          <figcaption>{t('已发布内容', 'Published content')}</figcaption>
          {visible.before === null ? <p>{t('新增文件', 'New file')}</p> : <pre>{visible.before || t('（空文件）', '(empty file)')}</pre>}
        </figure>
        <figure>
          <figcaption>{t('学习草稿', 'Learning draft')}</figcaption>
          {visible.after === null ? <p>{t('文件已删除', 'File removed')}</p> : <pre>{visible.after || t('（空文件）', '(empty file)')}</pre>}
        </figure>
      </div>
    </div>
  );
}

export function SkillReviewPanel({ connected, call }: { connected: boolean; call: SkillReviewCall }) {
  const t = useText();
  if (!connected) return <p className="skill-review-muted">{t('连接目标 Host 后可审阅 Skill 草稿。', 'Connect to the target Host to review Skill drafts.')}</p>;
  return <SkillReviewSession call={call} t={t} />;
}

function SkillReviewSession({ call, t }: { call: SkillReviewCall; t: Translate }) {
  const [items, setItems] = useState<Draft[] | null>(null);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [file, setFile] = useState<ChangedFile | null>(null);
  const [viewed, setViewed] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<ApprovalReceipt | null>(null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const approval = useRef<Approval | null>(null);
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
    approval.current = null;
    setDetail(null);
    setFile(null);
    setViewed([]);
    setReceipt(null);
    run(async () => {
      const result = await callRef.current({ action: 'list' }) as { items: Draft[] } | null;
      if (!Array.isArray(result?.items)) throw new Error('Invalid draft list');
      return result.items;
    }, setItems);
  }, [run]);

  useEffect(() => {
    loadList();
    return () => { sequence.current++; };
  }, [loadList]);

  function openDraft(draft: Draft) {
    run(async () => {
      const result = await callRef.current({ action: 'read', skillId: draft.skillId }) as DraftDetail | null;
      if (!result || result.skillId !== draft.skillId || !Array.isArray(result.changes) || !result.source) {
        throw new Error('Invalid draft details');
      }
      return result;
    }, setDetail);
  }

  function openFile(draft: DraftDetail, selected: Change) {
    run(async () => {
      const result = await callRef.current({
        action: 'read', skillId: draft.skillId, path: selected.path, expectedRevision: draft.revision,
      }) as DraftDetail | null;
      if (!result?.file || result.revision !== draft.revision || result.file.path !== selected.path) {
        throw new Error('Invalid file comparison');
      }
      return result.file;
    }, next => {
      setFile(next);
      setViewed(current => current.includes(next.path) ? current : [...current, next.path]);
    });
  }

  function approve(draft: DraftDetail) {
    if (!approval.current) {
      const requestId = globalThis.crypto?.randomUUID?.() ?? (Date.now() + '-' + Math.random().toString(36).slice(2));
      approval.current = { action: 'approve', skillId: draft.skillId, expectedRevision: draft.revision, requestId };
    }
    const input = approval.current;
    run(async () => {
      const result = await callRef.current(input) as ApprovalReceipt | null;
      if (!result?.publication?.status) throw new Error('Invalid publication receipt');
      return result;
    }, setReceipt);
  }

  const published = receipt?.publication.status === 'enabled';
  const requireRefresh = failure && ['REVISION_CONFLICT', 'REQUEST_CONFLICT', 'NOT_FOUND'].includes(errorCode(failure.error) ?? '');
  const publicationError = receipt?.deployment?.error ?? receipt?.publication.error;

  return (
    <section className="skill-review-panel" aria-busy={busy}>
      <header className="skill-review-header">
        <div>
          <h3>{detail ? detail.name : t('待审阅草稿', 'Drafts awaiting review')}</h3>
          <p className="skill-review-muted">
            {detail ? t('草稿版本 ', 'Draft revision ') + detail.headRevision
              : t('Bot 学习会生成 Skill 草稿。审阅差异后可确认发布。', 'Bot learning saves Skill drafts. Review the changes before publishing.')}
          </p>
        </div>
        <button type="button" disabled={busy} onClick={loadList}>
          {detail ? t('返回草稿', 'Back to drafts') : t('刷新', 'Refresh')}
        </button>
      </header>
      {busy ? <p className="skill-review-muted" role="status">{t('正在读取或处理草稿…', 'Reading or processing the draft…')}</p> : null}
      {failure ? <p role="alert">{failureText(failure.error, t)}</p> : null}
      {receipt ? (
        <p role={publicationError ? 'alert' : 'status'}>
          {receiptText(receipt, t)} {publicationError?.code ?? ''}
        </p>
      ) : null}
      {!detail && items?.length === 0 ? <p className="skill-review-muted">{t('暂无待审阅的 Skill 草稿。', 'There are no Skill drafts awaiting review.')}</p> : null}
      {!detail && items?.length ? (
        <ul className="skill-review-list">
          {items.map(draft => (
            <li key={draft.skillId}>
              <button type="button" disabled={busy} onClick={() => openDraft(draft)}>
                <strong>{draft.name}</strong>
                <span>{sourceTitle(draft.source, t)} · r{draft.headRevision}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {detail ? (
        <>
          <div className="skill-review-source">
            <p><strong>{t('最近一次学习', 'Latest learning source')}</strong> · {sourceTitle(detail.source, t)} · {new Date(detail.source.createdAt).toLocaleString()}</p>
            {detail.source.conversationId ? <p>{t('来源会话', 'Source conversation')} <code>{detail.source.conversationId}</code></p> : null}
            {detail.source.throughEntryId !== undefined && detail.source.throughEntryId > (detail.source.afterEntryId ?? 0) ? (
              <p>{t('会话条目范围', 'Conversation entry range')} {(detail.source.afterEntryId ?? 0) + 1}–{detail.source.throughEntryId}</p>
            ) : null}
            {detail.source.jobId ? <p>{t('作业', 'Job')} <code>{detail.source.jobId}</code></p> : null}
            <p>{detail.publishedRevision === null
              ? t('首次发布', 'First publication')
              : t('对比已发布版本 ', 'Comparing with published revision ') + detail.publishedRevision}</p>
          </div>
          {!published && detail.changes.length ? (
            <ul className="skill-review-list" aria-label={t('变更文件', 'Changed files')}>
              {detail.changes.map(change => (
                <li key={change.path}>
                  <button type="button" aria-pressed={file?.path === change.path} disabled={busy || !!requireRefresh}
                    onClick={() => openFile(detail, change)}>
                    <code>{change.path}</code>
                    <span>{changeTitle(change.kind, t)}{viewed.includes(change.path) ? ' ✓' : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {file && !published ? <FileComparison key={file.path} file={file} t={t} /> : null}
          {!published && !detail.changes.length ? <p className="skill-review-muted">{t('文件内容与已发布版本相同。', 'The files match the published version.')}</p> : null}
          {detail.state === 'archived' ? (
            <p className="skill-review-muted">{t('请先在 Skill 管理中恢复这项 Skill。', 'Restore this Skill in Skill management before publishing.')}</p>
          ) : (
            <div className="skill-review-actions">
              {!published && detail.changes.length ? <span className="skill-review-muted">{t('已查看 ', 'Viewed ')}{viewed.length}/{detail.changes.length}</span> : null}
              <button type="button" className="skill-review-primary"
                disabled={busy || !!requireRefresh || viewed.length !== detail.changes.length}
                onClick={() => approve(detail)}>
                {published ? t('刷新应用状态', 'Refresh deployment status')
                  : approval.current ? t('核对并继续发布', 'Check and continue publication')
                  : t('确认发布版本 ', 'Approve revision ') + detail.headRevision}
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
