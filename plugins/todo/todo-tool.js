// plugins/todo/todo-tool.js
// The `todo` tool declaration and executor. Model, UI, and program callers all
// observe the same committed state: the doc change lands inside api.commit()
// before details/output are produced.

import { applyTodoChange, presentation, snapshotOf, taskSnapshot, MAX_TASKS, MAX_SUBJECT } from './todo-state.js';

const TOOL_ERROR_CODES = new Set(['INVALID_ARGUMENT', 'VALIDATION_FAILED', 'NOT_FOUND']);

const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['create', 'update', 'list', 'delete', 'clear'] },
    subject: { type: 'string', minLength: 1, maxLength: MAX_SUBJECT },
    id: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
  },
  required: ['action'],
  additionalProperties: false,
};

function errorResult(code, message) {
  return { output: [{ type: 'text', text: JSON.stringify({ code, message }) }], isError: true };
}

function summarize(doc, outcome) {
  const tasks = snapshotOf(doc);
  const counts = { pending: 0, in_progress: 0, completed: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return JSON.stringify({ ...outcome, total: tasks.length, ...counts, tasks });
}

// read is a DocumentReader (ToolExecutionApi or the section input's read).
async function run(args, read, commit, api, context, installationId, Todos) {
  if (args.action === 'list') {
    const doc = await read.snapshot(Todos, api.conversationId, context);
    return {
      output: [{ type: 'text', text: summarize(doc, { status: 'ok', action: 'list' }) }],
      details: { presentation: presentation(installationId, doc) },
    };
  }
  let outcome;
  // The committed task list is captured inside the transaction so output,
  // details, and the persisted doc are the same snapshot.
  const tasks = await commit(async (tx) => {
    const draft = await tx.doc(Todos, api.conversationId);
    const result = applyTodoChange(draft, args);
    outcome = { status: 'ok', action: args.action };
    if (result.task) outcome.task = taskSnapshot(result.task);
    if (result.cleared !== undefined) outcome.cleared = result.cleared;
    return snapshotOf(draft);
  }, context);
  const details = { presentation: presentation(installationId, { tasks }) };
  // 运行中的 UI 与结果共用同一份已提交快照。
  await api.details(details, context);
  return {
    output: [{ type: 'text', text: summarize({ tasks }, outcome) }],
    details,
  };
}

export function createTodoTool({ defineTool, installationId, Todos }) {
  return defineTool({
    name: 'todo',
    description:
      `Manage a per-conversation todo list (at most ${MAX_TASKS} tasks). ` +
      'action=create requires subject (non-empty); update requires id plus subject and/or status ' +
      '(pending|in_progress|completed; setting a task in_progress pauses the currently in-progress task so at most one is in progress); ' +
      'list returns the whole list; delete requires id; clear removes every task. ' +
      'Task ids are stable integers assigned on creation. Use this to track multi-step work and mark progress.',
    parameters: PARAMETERS,
    // Default unsafe replay: an execution interrupted after its commit is not
    // rerun, so a restart cannot silently create or mutate tasks a second time.
    replay: 'unsafe',
    async execute(args, api, context) {
      try {
        return await run(args, api, api.commit.bind(api), api, context, installationId, Todos);
      } catch (error) {
        const code = typeof error?.code === 'string' && TOOL_ERROR_CODES.has(error.code) ? error.code : 'INTERNAL';
        const message = typeof error?.message === 'string' ? error.message.slice(0, 200) : 'todo operation failed';
        return errorResult(code, message);
      }
    },
  });
}
