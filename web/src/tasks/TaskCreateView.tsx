import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { mobileHaptic } from '../native/tauri-host';
import { useText } from '../ui';
import type { GlobalTasksController } from './useGlobalTasks';

export interface TaskCreateViewProps {
  controller: GlobalTasksController;
  onClose: () => void;
}

const isCoarsePointerQuery = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

function useIsCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(isCoarsePointerQuery);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(pointer: coarse)');
    setCoarse(mql.matches);
    const onChange = (event: MediaQueryListEvent) => setCoarse(event.matches);
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
  }, []);
  return coarse;
}

export function TaskCreateView({ controller, onClose }: TaskCreateViewProps) {
  const t = useText();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const isCoarse = useIsCoarsePointer();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const trimmed = controller.createDraft.trim();
  const hasDraft = trimmed.length > 0;
  const effectiveError = validationError || submitError;

  // Focus textarea on mount ONLY on non-coarse pointers so touch keyboards never pop up unexpectedly.
  useEffect(() => {
    if (isCoarsePointerQuery()) return;
    textareaRef.current?.focus();
  }, []);

  const handleBack = useCallback(() => {
    if (submitting) return;
    controller.markDraftLeftUnpublished();
    onClose();
  }, [controller, onClose, submitting]);

  const handleSubmit = async () => {
    if (submitting) return;
    if (!hasDraft) {
      setValidationError(t('请先写下任务内容再发布。', 'Please describe the task before publishing.'));
      textareaRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setValidationError(null);
    setSubmitError(null);
    try {
      await controller.createTask({ text: trimmed });
      mobileHaptic('confirm');
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof Error && err.message
          ? err.message
          : String(err || t('发布任务失败', 'Failed to publish task')),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      handleBack();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSubmit();
    }
  };

  const handleViewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.defaultPrevented) return;
    if (event.key === 'Escape' && !submitting) {
      event.preventDefault();
      handleBack();
    }
  };

  const describedBy = [hintId, effectiveError ? errorId : ''].filter(Boolean).join(' ');

  return (
    <div className="tasks-scroll" onKeyDown={handleViewKeyDown}>
      <div className="tasks-container page-enter">
        <header className="detail-topbar">
          <button type="button" className="back-btn" onClick={handleBack} disabled={submitting}>
            <ArrowLeft size={19} aria-hidden="true" />
            <span>{t('任务列表', 'Tasks')}</span>
          </button>
        </header>

        <section className="create-page-card" aria-label={t('新建任务', 'New task')}>
          <h1 className="create-page-title">{t('新建任务', 'New task')}</h1>
          <label htmlFor={inputId} className="sr-only">
            {t('输入想法或任务内容', 'Enter an idea or task description')}
          </label>
          <textarea
            ref={textareaRef}
            id={inputId}
            className="create-page-textarea"
            value={controller.createDraft}
            aria-invalid={Boolean(effectiveError) || undefined}
            aria-describedby={describedBy}
            onChange={event => {
              setValidationError(null);
              setSubmitError(null);
              controller.setCreateDraft(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('随手写下一句想法，或直接交代要做的事…', 'Jot down an idea or describe what you need done…')}
            disabled={submitting}
          />

          {effectiveError ? (
            <div id={errorId} className="tasks-error-strip" role="alert">
              <span>{effectiveError}</span>
            </div>
          ) : null}

          <div className="create-page-footer">
            {hasDraft && controller.showDraftSaved ? (
              <span id={hintId} className="create-page-hint is-saved">
                {isCoarse
                  ? t('已保留上次未发布的草稿，可继续编辑', 'Your unpublished draft was restored.')
                  : t('已保留上次未发布的草稿 · Ctrl/⌘+Enter 发布 · Esc 返回', 'Unpublished draft restored · Ctrl/⌘+Enter to publish · Esc to cancel')}
              </span>
            ) : (
              <span id={hintId} className="create-page-hint">
                {isCoarse
                  ? t('不用选谁来做，写下想法或要求即可交给 Bot 安排', 'No need to pick an owner—describe what you need and a Bot will coordinate it.')
                  : t('不用选谁来做，写下要求即可交给 Bot 安排 · Ctrl/⌘+Enter 发布 · Esc 返回', 'Describe what you need and a Bot will coordinate it · Ctrl/⌘+Enter to publish · Esc to cancel')}
              </span>
            )}
            <button
              type="button"
              className="tb-primary-btn"
              disabled={!hasDraft || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? t('发布中…', 'Publishing…') : t('发布任务', 'Publish task')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
