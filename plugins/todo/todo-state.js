// plugins/todo/todo-state.js
// Per-conversation todo document and shared helpers. Derived from the Durable
// 1.4 example test/examples/11-extension-state.ts in
// https://github.com/earendil-works/pi (upstream MIT License); kept with the
// attribution in README.md. `defineDoc` is the host-injected SDK variant: it
// already supplies checkpointWhen() === false.

export const MAX_TASKS = 100;
export const MAX_SUBJECT = 200;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

const err = (code, message) => Object.assign(new Error(message), { code });

// Rewindable conversation document: a fork starts with the tasks its parent had
// at the fork entry (fork: 'asOf'); nothing creates the doc up front, tx.doc()
// materializes it on first write and reads treat it as missing.
export function createTodoState(defineDoc) {
  const Todos = defineDoc({
    kind: 'e-launcher.todos',
    version: 1,
    scope: 'conversation',
    history: 'rewindable',
    fork: 'asOf',
    initial: () => ({ nextId: 1, tasks: [] }),
  });
  return { Todos };
}

export function checkSubject(subject) {
  if (typeof subject !== 'string' || !subject.isWellFormed()) {
    throw err('INVALID_ARGUMENT', 'subject must be a well-formed string');
  }
  const trimmed = subject.trim();
  if (!trimmed) throw err('INVALID_ARGUMENT', 'subject must not be empty');
  if (trimmed.length > MAX_SUBJECT) throw err('INVALID_ARGUMENT', `subject exceeds ${MAX_SUBJECT} characters`);
  return trimmed;
}

function checkStatus(status) {
  if (!STATUSES.has(status)) throw err('INVALID_ARGUMENT', 'status must be pending, in_progress, or completed');
  return status;
}

// All mutations run inside one tx.doc() commit so the in-progress invariant and
// id allocation stay atomic under the default unsafe replay policy.
export function applyTodoChange(doc, args) {
  const tasks = doc.tasks;
  switch (args.action) {
    case 'create': {
      const subject = checkSubject(args.subject);
      if (tasks.length >= MAX_TASKS) throw err('VALIDATION_FAILED', `todo list is full (${MAX_TASKS} tasks)`);
      const task = { id: doc.nextId, subject, status: 'pending' };
      doc.nextId += 1;
      tasks.push(task);
      return { task };
    }
    case 'update': {
      const task = tasks.find((item) => item.id === args.id);
      if (!task) throw err('NOT_FOUND', `task ${args.id} does not exist`);
      if (args.subject !== undefined) task.subject = checkSubject(args.subject);
      if (args.status !== undefined) {
        const status = checkStatus(args.status);
        if (status === 'in_progress' && task.status !== 'in_progress') {
          for (const item of tasks) if (item.status === 'in_progress') item.status = 'pending';
        }
        task.status = status;
      }
      return { task };
    }
    case 'delete': {
      const index = tasks.findIndex((item) => item.id === args.id);
      if (index === -1) throw err('NOT_FOUND', `task ${args.id} does not exist`);
      const [task] = tasks.splice(index, 1);
      return { task };
    }
    case 'clear': {
      const count = tasks.length;
      tasks.length = 0;
      return { cleared: count };
    }
    default:
      throw err('INVALID_ARGUMENT', 'action must be create, update, list, delete, or clear');
  }
}

// Whitelisted task fields only; no unknown fields from the stored doc leak out.
export function taskSnapshot(task) {
  return { id: task.id, subject: task.subject, status: task.status };
}

export function snapshotOf(doc) {
  return (doc?.tasks ?? []).map(taskSnapshot);
}

export function presentation(installationId, doc) {
  return { kind: 'todo', version: 1, installationId, tasks: snapshotOf(doc) };
}

// Model-facing section text: absent document or empty list renders nothing.
export function sectionText(doc) {
  const tasks = doc?.tasks ?? [];
  if (!tasks.length) return undefined;
  const lines = tasks.map((task) => {
    const mark = task.status === 'completed' ? 'x' : task.status === 'in_progress' ? '>' : ' ';
    return `[${mark}] #${task.id} ${task.subject}`;
  });
  return `Todo list (${tasks.length} task${tasks.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
}
