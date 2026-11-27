export type RootScreen = 'hub' | 'tasks' | 'board' | 'settings';

export const ROOT_SCREENS: readonly RootScreen[] = ['hub', 'tasks', 'board', 'settings'] as const;

export type SettingsSubPage =
  | 'overview'
  | 'connection'
  | 'devices'
  | 'manual'
  | 'updates'
  | 'permissions'
  | 'clipboard'
  | 'advanced';

export interface NavEntry<S extends string = string> {
  screen: S;
  botKey?: string | null;
  settingsPage?: SettingsSubPage;
  taskId?: string | null;
}

export function isRootScreen(screen: string): screen is RootScreen {
  return (ROOT_SCREENS as readonly string[]).includes(screen);
}

/**
 * Only 'hub' ("对话") exits/backgrounds the app when hardware Back reaches stack bottom.
 * Other root screens ('tasks', 'board', 'settings') return to 'hub' instead of exiting.
 */
export function isExitRootScreen(screen: string): boolean {
  return screen === 'hub';
}

function cloneNavEntry<S extends string>(entry: NavEntry<S>): NavEntry<S> {
  return {
    screen: entry.screen,
    ...(entry.botKey !== undefined ? { botKey: entry.botKey } : {}),
    ...(entry.settingsPage !== undefined ? { settingsPage: entry.settingsPage } : {}),
    ...(entry.taskId !== undefined ? { taskId: entry.taskId } : {}),
  };
}

export function createNavStack<S extends string>(
  root: S,
  extra?: Omit<NavEntry<S>, 'screen'>,
): NavEntry<S>[] {
  return [{ screen: root, ...(extra ?? {}) }];
}

export function currentNavEntry<S extends string>(stack: readonly NavEntry<S>[]): NavEntry<S> {
  return stack[stack.length - 1];
}

export function previousNavEntry<S extends string>(
  stack: readonly NavEntry<S>[],
): NavEntry<S> | undefined {
  return stack.length > 1 ? stack[stack.length - 2] : undefined;
}

function sameNavTarget<S extends string>(a: NavEntry<S>, b: NavEntry<S>): boolean {
  if (a.screen !== b.screen) return false;
  if (a.screen === 'settings') {
    return (a.settingsPage ?? 'overview') === (b.settingsPage ?? 'overview');
  }
  if (a.screen === 'tasks') {
    return (a.taskId ?? null) === (b.taskId ?? null);
  }
  if (a.botKey !== undefined && b.botKey !== undefined) {
    return (a.botKey ?? null) === (b.botKey ?? null);
  }
  if (a.botKey === undefined && b.botKey !== undefined) {
    return false;
  }
  return true;
}

function mergeNavEntry<S extends string>(existing: NavEntry<S>, next: NavEntry<S>): NavEntry<S> {
  return {
    ...existing,
    ...next,
    ...(next.botKey === undefined && existing.botKey !== undefined ? { botKey: existing.botKey } : {}),
    ...(next.taskId === undefined && existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
    ...(next.settingsPage === undefined && existing.settingsPage !== undefined
      ? { settingsPage: existing.settingsPage }
      : {}),
  };
}

/**
 * Push a screen onto the navigation stack.
 * - Identical top target updates metadata in place without duplicating.
 * - Navigating to a target already present in the stack (e.g. bot-profile <-> settings-center-admin)
 *   unwinds back to that existing frame so back-navigation can never form a cycle.
 */
export function pushNavEntry<S extends string>(
  stack: readonly NavEntry<S>[],
  next: NavEntry<S>,
): NavEntry<S>[] {
  if (stack.length === 0) return [next];
  const top = stack[stack.length - 1];
  if (sameNavTarget(top, next)) {
    const merged = mergeNavEntry(top, next);
    return [...stack.slice(0, -1), merged];
  }
  for (let i = stack.length - 2; i >= 0; i -= 1) {
    if (sameNavTarget(stack[i], next)) {
      const merged = mergeNavEntry(stack[i], next);
      return [...stack.slice(0, i), merged];
    }
  }
  return [...stack, next];
}

/**
 * Replace the top entry of the stack (e.g. completing creation wizard and entering the new chat/room
 * so pressing Back returns to the screen before the wizard, not back into the wizard).
 */
export function replaceTopNavEntry<S extends string>(
  stack: readonly NavEntry<S>[],
  next: NavEntry<S>,
): NavEntry<S>[] {
  if (stack.length <= 1) return [next];
  return pushNavEntry(stack.slice(0, -1), next);
}

/**
 * Pop the top entry from the stack.
 * When already at a root (stack length <= 1), returns popped: false so native Back handling takes over.
 */
export function popNavEntry<S extends string>(
  stack: readonly NavEntry<S>[],
): { stack: NavEntry<S>[]; popped: boolean; current: NavEntry<S> } {
  if (stack.length <= 1) {
    return { stack: [...stack], popped: false, current: stack[0] };
  }
  const remaining = stack.slice(0, -1);
  return { stack: remaining, popped: true, current: remaining[remaining.length - 1] };
}

/**
 * Reset the entire stack to a single root screen (used by left navigation drawer root switching).
 */
export function resetNavStack<S extends string>(
  root: S,
  extra?: Omit<NavEntry<S>, 'screen'>,
): NavEntry<S>[] {
  return [{ screen: root, ...(extra ?? {}) }];
}

/**
 * Reset the entire stack to a clean, cycle-free chain of entries
 * (e.g. notification launch resetting to [{ screen: 'hub' }, { screen: 'chat', botKey }]).
 */
export function resetNavStackChain<S extends string>(
  root: NavEntry<S>,
  ...rest: NavEntry<S>[]
): NavEntry<S>[] {
  let stack: NavEntry<S>[] = [cloneNavEntry(root)];
  for (const entry of rest) {
    stack = pushNavEntry(stack, cloneNavEntry(entry));
  }
  return stack;
}

/**
 * Map a navigation entry to its HashRouter-compatible hash fragment.
 */
export function navEntryToHash(entry: NavEntry): string {
  switch (entry.screen) {
    case 'hub':
      return '#/';
    case 'tasks':
      return '#/tasks';
    case 'board':
      return '#/board';
    case 'settings':
      return entry.settingsPage && entry.settingsPage !== 'overview'
        ? `#/settings/${entry.settingsPage}`
        : '#/settings';
    case 'settings-center-admin':
      return '#/settings/center-admin';
    case 'pending':
      return '#/settings/pending';
    case 'archived-bots':
      return '#/settings/archived-bots';
    case 'bot-profile-manage':
      return '#/bot-profile/manage';
    default:
      return `#/${entry.screen}`;
  }
}

/**
 * Parse an initial window.location.hash into a safe root entry.
 * Sub-screens requiring runtime entity state (chat/profile/etc.) safely fall back to hub on cold load.
 */
export function parseHashToRootEntry(hash: string): NavEntry<RootScreen> {
  const normalized = (hash || '').replace(/^#\/?/, '').trim().toLowerCase();
  const firstSegment = normalized.split(/[/?#]/)[0] || '';
  if (firstSegment === 'tasks') return { screen: 'tasks' };
  if (firstSegment === 'board') return { screen: 'board' };
  if (firstSegment === 'settings') return { screen: 'settings', settingsPage: 'overview' };
  return { screen: 'hub' };
}

/**
 * Synchronize browser/WebView location hash with the current navigation entry via replaceState
 * so HashRouter reflects the active view without pushing conflicting browser history entries.
 */
export function syncLocationHash(
  entry: NavEntry,
  loc?: Pick<Location, 'hash' | 'pathname' | 'search'>,
  hist?: Pick<History, 'replaceState'>,
): boolean {
  const targetHash = navEntryToHash(entry);
  const locationObj = loc ?? (typeof window !== 'undefined' ? window.location : undefined);
  const historyObj = hist ?? (typeof window !== 'undefined' ? window.history : undefined);
  if (!locationObj || !historyObj || typeof historyObj.replaceState !== 'function') return false;
  if (locationObj.hash === targetHash) return false;
  try {
    const base = `${locationObj.pathname || ''}${locationObj.search || ''}`;
    historyObj.replaceState(null, '', `${base}${targetHash}`);
    return true;
  } catch {
    return false;
  }
}
