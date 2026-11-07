import type { ChatToolCallItem } from './chatTurnModel';
import { formatTurnDuration } from './chatTurnModel';
import {
  readToolPresentation,
  ToolPresentationCard,
  type QuestionnaireSubmitPayload,
  type VaultUnlockSubmitPayload,
} from './ToolPresentation';
import { useText } from './ui';
import './tool-call-card.css';

export interface ToolCallCardProps {
  tool: ChatToolCallItem;
  scopeKey: string;
  active: boolean;
  disabled?: boolean;
  onSubmitQuestionnaire?: (installationId: string, input: QuestionnaireSubmitPayload) => Promise<unknown>;
  onSubmitVaultUnlock?: (input: VaultUnlockSubmitPayload) => Promise<unknown>;
}

/** One model call, its script-owned children, and its own result stay in the same block. */
export function ToolCallCard({
  tool,
  scopeKey,
  active,
  disabled = false,
  onSubmitQuestionnaire,
  onSubmitVaultUnlock,
}: ToolCallCardProps) {
  const t = useText();
  const presentation = readToolPresentation(tool.presentation);
  const codemode = tool.name === 'codemode';
  const script = codemode && typeof tool.args?.code === 'string' ? tool.args.code : undefined;
  const args = tool.args && Object.keys(tool.args).length > 0 ? JSON.stringify(tool.args, null, 2) : undefined;
  const incomplete = tool.status === 'done' && tool.outcome !== 'ok';
  const statusLabel = tool.status === 'running' ? t('调用中', 'Calling')
    : tool.status === 'error' ? t('失败', 'Failed')
      : tool.status === 'cancelled' ? t('已取消', 'Cancelled')
        : tool.status === 'interrupted' ? t('已中断', 'Interrupted')
          : incomplete ? t('结果不完整', 'Outcome unavailable') : t('已完成', 'Done');
  const icon = tool.status === 'running' ? '…'
    : tool.status === 'error' ? '✕'
      : tool.status === 'cancelled' ? '⊘'
        : tool.status === 'interrupted' || incomplete ? '—' : '✓';
  const duration = tool.durationMs === undefined ? undefined
    : tool.durationMs < 1000 ? `${Math.round(tool.durationMs)}ms`
      : formatTurnDuration(tool.durationMs, (_zh, en) => en);
  const presentationKey = presentation && presentation.kind !== 'todo' ? presentation.requestId : tool.id;
  const hasDetails = codemode || args !== undefined || tool.output !== undefined || tool.outputTruncated ||
    (tool.parentCallId !== undefined && tool.argSummary !== undefined);

  return (
    <div
      key={`${scopeKey}:${tool.id}`}
      role="listitem"
      className={`tool-call-card is-${tool.status}${incomplete ? ' is-incomplete' : ''}${tool.parentCallId ? ' is-nested' : ''}`}
    >
      <div className="tool-call-header">
        <span className="tool-call-icon" aria-hidden="true">{icon}</span>
        <span className="tool-call-name">{tool.name}</span>
        {tool.argSummary ? <span className="tool-call-args" title={tool.argSummary}>{tool.argSummary}</span> : null}
        <span className="tool-call-state">{statusLabel}</span>
        {duration ? <span className="tool-call-duration">{duration}</span> : null}
      </div>

      {tool.error ? <pre className="tool-call-error">{tool.error}</pre> : null}

      {tool.children && tool.children.length > 0 ? (
        <div className="tool-call-children" role="list" aria-label={t('脚本子调用', 'Nested tool calls')}>
          {tool.children.map(child => (
            <ToolCallCard
              key={child.id}
              tool={child}
              scopeKey={scopeKey}
              active={active && tool.status === 'running'}
              disabled={disabled}
              onSubmitQuestionnaire={onSubmitQuestionnaire}
              onSubmitVaultUnlock={onSubmitVaultUnlock}
            />
          ))}
        </div>
      ) : null}
      {tool.nestedCallsTruncated ? (
        <p className="tool-call-notice">{t('子调用摘要已截断，部分信息未显示。', 'Nested call summaries are truncated; some information is not shown.')}</p>
      ) : null}
      {codemode && tool.status !== 'running' && tool.children === undefined ? (
        <p className="tool-call-notice">{t('此记录未保留子调用摘要。', 'No nested call summaries were recorded.')}</p>
      ) : null}

      {hasDetails ? (
        <details className="tool-call-details">
          <summary>{codemode ? t('脚本与输出', 'Script and output') : t('调用详情', 'Call details')}</summary>
          {script !== undefined ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('脚本', 'Script')}</span>
              <pre>{script}</pre>
            </div>
          ) : args !== undefined ? (
            <div className="tool-call-section">
              <span className="tool-call-label">{t('参数', 'Arguments')}</span>
              <pre>{args}</pre>
            </div>
          ) : codemode ? <p className="tool-call-notice">{t('此记录未保留脚本。', 'The script is not available in this record.')}</p>
            : tool.argSummary ? (
              <div className="tool-call-section">
                <span className="tool-call-label">{t('参数摘要', 'Argument preview')}</span>
                <pre>{tool.argSummary}</pre>
              </div>
            ) : null}
          {tool.output !== undefined ? (
            <div className="tool-call-section">
              <span className="tool-call-label">
                {tool.status === 'running' ? t('实时输出', 'Live output') : t('输出', 'Output')}
              </span>
              <pre>{tool.output}</pre>
            </div>
          ) : codemode ? <p className="tool-call-notice">{t('暂无记录的文本输出。', 'No recorded text output is available.')}</p> : null}
          {tool.outputTruncated ? <p className="tool-call-notice">{t('输出已截断。', 'Output is truncated.')}</p> : null}
        </details>
      ) : null}

      {presentation ? (
        <ToolPresentationCard
          key={`${scopeKey}:${tool.id}:${presentation.kind}:${presentationKey}`}
          presentation={presentation}
          active={active && tool.presentationLive === true}
          disabled={disabled}
          onSubmit={presentation.kind === 'questionnaire' && onSubmitQuestionnaire
            ? input => onSubmitQuestionnaire(presentation.installationId, input)
            : undefined}
          onSubmitVaultUnlock={onSubmitVaultUnlock}
        />
      ) : null}
    </div>
  );
}
