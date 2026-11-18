import { useState, type KeyboardEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { GlobalTasksController } from './useGlobalTasks';

export interface TaskCreateViewProps {
  controller: GlobalTasksController;
  onClose: () => void;
}

export function TaskCreateView({ controller, onClose }: TaskCreateViewProps) {
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
      onClose();
    } catch (err) {
      setSubmitError(err instanceof Error && err.message ? err.message : String(err || '发布任务失败'));
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
          <button type="button" className="back-btn" onClick={handleBack} disabled={submitting}>
            <ArrowLeft size={19} aria-hidden="true" />
            <span>任务列表</span>
          </button>
        </header>

        <section className="create-page-card" aria-label="新建任务">
          <h1 className="create-page-title">新建任务</h1>
          <label htmlFor="create-task-input" className="sr-only">
            输入想法或任务内容
          </label>
          <textarea
            id="create-task-input"
            className="create-page-textarea"
            value={controller.createDraft}
            onChange={event => {
              setSubmitError(null);
              controller.setCreateDraft(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder="随手写下一句想法，或直接交代要做的事…"
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
              <span className="create-page-hint is-saved">已保留上次未发布的草稿，可继续编辑</span>
            ) : (
              <span className="create-page-hint">不用选谁来做，写下想法或要求即可交给助手安排</span>
            )}
            <button
              type="button"
              className="tb-primary-btn"
              disabled={!hasDraft || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? '发布中…' : '发布任务'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
