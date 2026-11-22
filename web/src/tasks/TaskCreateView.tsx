import { useId, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ActionBar } from '../components/ui';
import { mobileHaptic } from '../native/tauri-host';
import { useNotice } from '../notice';
import { useText } from '../ui';
import type { GlobalTasksController } from './useGlobalTasks';

export interface TaskCreateViewProps {
  controller: GlobalTasksController;
  onClose: () => void;
}

export function TaskCreateView({ controller, onClose }: TaskCreateViewProps) {
  const t = useText();
  const { notify } = useNotice();
  const inputId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const trimmed = controller.createDraft.trim();
  const hasDraft = trimmed.length > 0;

  const handleBack = () => {
    controller.markDraftLeftUnpublished();
    onClose();
  };

  const handleSubmit = async () => {
    if (!hasDraft || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await controller.createTask({ text: trimmed });
      mobileHaptic('confirm');
      notify({
        id: 'task-created',
        tone: 'success',
        title: t('已发布任务', 'Task published'),
      });
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error && err.message ? err.message : String(err || t('发布任务失败', 'Failed to publish task')));
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="tasks-scroll">
      <div className="tasks-container page-enter">
        <header className="detail-topbar">
          <ActionBar align="start">
            <button type="button" className="back-btn" onClick={handleBack} disabled={submitting}>
              <ArrowLeft size={19} aria-hidden="true" />
              <span>{t('任务列表', 'Tasks')}</span>
            </button>
          </ActionBar>
        </header>

        <section className="create-page-card" aria-label={t('新建任务', 'New task')}>
          <h1 className="create-page-title">{t('新建任务', 'New task')}</h1>
          <label htmlFor={inputId} className="sr-only">
            {t('输入想法或任务内容', 'Enter an idea or task description')}
          </label>
          <textarea
            id={inputId}
            className="create-page-textarea"
            value={controller.createDraft}
            onChange={event => {
              setSubmitError(null);
              controller.setCreateDraft(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={t('随手写下一句想法，或直接交代要做的事…', 'Jot down an idea or describe what you need done…')}
            disabled={submitting}
            autoFocus
          />

          {submitError ? (
            <div className="tasks-error-strip" role="alert">
              <span>{submitError}</span>
            </div>
          ) : null}

          <div className="create-page-footer">
            {hasDraft && controller.showDraftSaved ? (
              <span className="create-page-hint is-saved">{t('已保留上次未发布的草稿，可继续编辑', 'Your unpublished draft was restored.')}</span>
            ) : (
              <span className="create-page-hint">{t('不用选谁来做，写下想法或要求即可交给 Bot 安排', 'No need to pick an owner—describe what you need and a Bot will coordinate it.')}</span>
            )}
            <ActionBar align="end">
              <button
                type="button"
                className="tb-secondary-btn"
                disabled={submitting}
                onClick={handleBack}
              >
                {hasDraft ? t('暂存草稿', 'Save draft') : t('取消', 'Cancel')}
              </button>
              <button
                type="button"
                className="tb-primary-btn"
                disabled={!hasDraft || submitting}
                aria-busy={submitting || undefined}
                onClick={() => void handleSubmit()}
              >
                {submitting ? <Loader2 size={15} className="spin" aria-hidden="true" /> : null}
                <span>{submitting ? t('发布中…', 'Publishing…') : t('发布任务', 'Publish task')}</span>
              </button>
            </ActionBar>
          </div>
        </section>
      </div>
    </div>
  );
}
