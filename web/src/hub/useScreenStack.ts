import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createNavStack,
  currentNavEntry,
  popNavEntry,
  previousNavEntry,
  pushNavEntry,
  replaceTopNavEntry,
  resetNavStack,
  resetNavStackChain,
  syncLocationHash,
  type NavEntry,
} from './navigationLogic';

export {
  ROOT_SCREENS,
  createNavStack,
  currentNavEntry,
  isExitRootScreen,
  isRootScreen,
  navEntryToHash,
  parseHashToRootEntry,
  popNavEntry,
  previousNavEntry,
  pushNavEntry,
  replaceTopNavEntry,
  resetNavStack,
  resetNavStackChain,
  syncLocationHash,
  type NavEntry,
  type RootScreen,
  type SettingsSubPage,
} from './navigationLogic';

export type ScreenStackEntry<S extends string = string> = NavEntry<S>;

/**
 * Full navigation stack hook for HostPage.
 * - Drawer root switches call `resetTo(root)`.
 * - Sub-screen jumps call `push(next)` (auto-unwinding cycles like bot-profile <-> settings-center-admin).
 * - Wizard completions call `replaceTop(next)`.
 * - Back navigation calls `pop()`, returning `null` when at a root so native Back takes over.
 * - Optionally syncs `window.location.hash` via `history.replaceState` so HashRouter never conflicts.
 */
export function useScreenStack<S extends string>(
  initialEntry: NavEntry<S>,
  options?: { syncHash?: boolean },
) {
  const syncHash = options?.syncHash ?? false;
  const [stack, setStack] = useState<NavEntry<S>[]>(() =>
    createNavStack(initialEntry.screen, {
      ...(initialEntry.botKey !== undefined ? { botKey: initialEntry.botKey } : {}),
      ...(initialEntry.settingsPage !== undefined ? { settingsPage: initialEntry.settingsPage } : {}),
      ...(initialEntry.taskId !== undefined ? { taskId: initialEntry.taskId } : {}),
    }),
  );
  const stackRef = useRef<NavEntry<S>[]>(stack);
  stackRef.current = stack;

  const current = currentNavEntry(stack);
  const previous = previousNavEntry(stack);
  const canGoBack = stack.length > 1;

  useEffect(() => {
    if (!syncHash) return;
    syncLocationHash(current);
  }, [syncHash, current.screen, current.settingsPage]);

  const push = useCallback((next: NavEntry<S>) => {
    const updated = pushNavEntry(stackRef.current, next);
    stackRef.current = updated;
    setStack(updated);
  }, []);

  const replaceTop = useCallback((next: NavEntry<S>) => {
    const updated = replaceTopNavEntry(stackRef.current, next);
    stackRef.current = updated;
    setStack(updated);
  }, []);

  const pop = useCallback((): NavEntry<S> | null => {
    const result = popNavEntry(stackRef.current);
    if (!result.popped) return null;
    stackRef.current = result.stack;
    setStack(result.stack);
    return result.current;
  }, []);

  const resetTo = useCallback((root: NavEntry<S>, ...rest: NavEntry<S>[]) => {
    const updated =
      rest.length > 0
        ? resetNavStackChain(root, ...rest)
        : resetNavStack(root.screen, {
            ...(root.botKey !== undefined ? { botKey: root.botKey } : {}),
            ...(root.settingsPage !== undefined ? { settingsPage: root.settingsPage } : {}),
            ...(root.taskId !== undefined ? { taskId: root.taskId } : {}),
          });
    stackRef.current = updated;
    setStack(updated);
  }, []);

  return {
    stack,
    stackRef,
    current,
    previous,
    canGoBack,
    push,
    replaceTop,
    pop,
    resetTo,
  };
}
