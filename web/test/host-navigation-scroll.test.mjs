import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
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
} from '../src/hub/navigationLogic.ts';
import {
  getOverlayStackDepth,
  hasOpenOverlay,
  registerOverlayBackHandler,
} from '../src/components/ui/overlayStack.ts';
import {
  CHAT_STICK_THRESHOLD_PX,
  decideChatAutoScroll,
  hasIncomingChatContent,
  isNearChatBottom,
} from '../src/hub/chatScrollLogic.ts';

test('4 root screens IA excludes pending and archived-bots from roots', () => {
  assert.deepEqual([...ROOT_SCREENS], ['hub', 'tasks', 'board', 'settings']);
  assert.equal(isRootScreen('hub'), true);
  assert.equal(isRootScreen('tasks'), true);
  assert.equal(isRootScreen('board'), true);
  assert.equal(isRootScreen('settings'), true);
  assert.equal(isRootScreen('pending'), false);
  assert.equal(isRootScreen('archived-bots'), false);
  assert.equal(isRootScreen('chat'), false);
});

test('navigation stack pushes LIFO subpages and pops cleanly until root hands off to native', () => {
  let stack = createNavStack('hub');
  stack = pushNavEntry(stack, { screen: 'chat', botKey: 'local:b1' });
  stack = pushNavEntry(stack, { screen: 'bot-profile', botKey: 'local:b1' });
  stack = pushNavEntry(stack, { screen: 'bot-soul', botKey: 'local:b1' });

  assert.equal(stack.length, 4);
  assert.equal(currentNavEntry(stack).screen, 'bot-soul');
  assert.equal(previousNavEntry(stack)?.screen, 'bot-profile');

  const p1 = popNavEntry(stack);
  assert.equal(p1.popped, true);
  assert.equal(p1.current.screen, 'bot-profile');

  const p2 = popNavEntry(p1.stack);
  assert.equal(p2.popped, true);
  assert.equal(p2.current.screen, 'chat');

  const p3 = popNavEntry(p2.stack);
  assert.equal(p3.popped, true);
  assert.equal(p3.current.screen, 'hub');

  // At root, pop returns popped: false so native Back handling takes over.
  const p4 = popNavEntry(p3.stack);
  assert.equal(p4.popped, false);
  assert.equal(p4.current.screen, 'hub');
});

test('navigation stack prevents bot-profile <-> settings-center-admin ping-pong cycle', () => {
  let stack = createNavStack('hub');
  stack = pushNavEntry(stack, { screen: 'chat', botKey: 'local:b1' });
  stack = pushNavEntry(stack, { screen: 'bot-profile', botKey: 'local:b1' });
  stack = pushNavEntry(stack, { screen: 'settings-center-admin' });
  // Navigating from center admin back to the same bot profile unwinds instead of cycling.
  stack = pushNavEntry(stack, { screen: 'bot-profile', botKey: 'local:b1' });

  assert.deepEqual(
    stack.map(entry => entry.screen),
    ['hub', 'chat', 'bot-profile'],
  );

  // Continuous back presses terminate cleanly at hub without looping.
  const visited = [currentNavEntry(stack).screen];
  let cur = stack;
  for (let i = 0; i < 10; i += 1) {
    const res = popNavEntry(cur);
    if (!res.popped) break;
    cur = res.stack;
    visited.push(res.current.screen);
  }
  assert.deepEqual(visited, ['bot-profile', 'chat', 'hub']);
});

test('navigation stack supports configuring a different Bot from center admin without cycling', () => {
  let stack = createNavStack('settings', { settingsPage: 'overview' });
  stack = pushNavEntry(stack, { screen: 'settings-center-admin' });
  stack = pushNavEntry(stack, { screen: 'bot-profile', botKey: 'remote:b2' });

  assert.deepEqual(
    stack.map(entry => entry.screen),
    ['settings', 'settings-center-admin', 'bot-profile'],
  );

  // Jumping back to center admin unwinds instead of adding a duplicate center-admin frame.
  stack = pushNavEntry(stack, { screen: 'settings-center-admin' });
  assert.deepEqual(
    stack.map(entry => entry.screen),
    ['settings', 'settings-center-admin'],
  );

  const popped = popNavEntry(stack);
  assert.equal(popped.popped, true);
  assert.equal(popped.current.screen, 'settings');
  assert.equal(popped.current.settingsPage, 'overview');
});

test('settings subpages push over overview and drawer resetTo clears deep stacks', () => {
  let stack = resetNavStack('settings', { settingsPage: 'overview' });
  stack = pushNavEntry(stack, { screen: 'settings', settingsPage: 'connection' });
  assert.equal(stack.length, 2);
  assert.equal(currentNavEntry(stack).settingsPage, 'connection');

  const backToOverview = popNavEntry(stack);
  assert.equal(backToOverview.popped, true);
  assert.equal(backToOverview.current.screen, 'settings');
  assert.equal(backToOverview.current.settingsPage, 'overview');

  // Drawer switch resets deep stack to new single root.
  stack = pushNavEntry(backToOverview.stack, { screen: 'archived-bots' });
  stack = pushNavEntry(stack, { screen: 'chat', botKey: 'local:old' });
  const switched = resetNavStack('board');
  assert.equal(switched.length, 1);
  assert.equal(currentNavEntry(switched).screen, 'board');
  assert.equal(popNavEntry(switched).popped, false);
});

test('replaceTopNavEntry replaces wizard screen so Back skips the creation form', () => {
  let stack = createNavStack('hub');
  stack = pushNavEntry(stack, { screen: 'bot-edit' });
  stack = replaceTopNavEntry(stack, { screen: 'chat', botKey: 'local:new' });

  assert.deepEqual(
    stack.map(entry => entry.screen),
    ['hub', 'chat'],
  );
  const res = popNavEntry(stack);
  assert.equal(res.popped, true);
  assert.equal(res.current.screen, 'hub');
});

test('hash mapping and syncLocationHash use replaceState without conflicting history pushes', () => {
  assert.equal(navEntryToHash({ screen: 'hub' }), '#/');
  assert.equal(navEntryToHash({ screen: 'tasks' }), '#/tasks');
  assert.equal(navEntryToHash({ screen: 'board' }), '#/board');
  assert.equal(navEntryToHash({ screen: 'settings', settingsPage: 'overview' }), '#/settings');
  assert.equal(navEntryToHash({ screen: 'settings', settingsPage: 'connection' }), '#/settings/connection');
  assert.equal(navEntryToHash({ screen: 'pending' }), '#/settings/pending');
  assert.equal(navEntryToHash({ screen: 'archived-bots' }), '#/settings/archived-bots');

  assert.deepEqual(parseHashToRootEntry('#/tasks'), { screen: 'tasks' });
  assert.deepEqual(parseHashToRootEntry('#/board'), { screen: 'board' });
  assert.deepEqual(parseHashToRootEntry('#/settings/connection'), { screen: 'settings', settingsPage: 'overview' });
  assert.deepEqual(parseHashToRootEntry('#/chat'), { screen: 'hub' });
  assert.deepEqual(parseHashToRootEntry(''), { screen: 'hub' });

  const calls = [];
  const fakeLoc = { pathname: '/index.html', search: '', hash: '#/' };
  const fakeHist = {
    replaceState: (_data, _unused, url) => {
      calls.push(String(url));
      fakeLoc.hash = String(url).slice(String(url).indexOf('#'));
    },
  };
  assert.equal(syncLocationHash({ screen: 'hub' }, fakeLoc, fakeHist), false);
  assert.equal(syncLocationHash({ screen: 'settings', settingsPage: 'manual' }, fakeLoc, fakeHist), true);
  assert.deepEqual(calls, ['/index.html#/settings/manual']);
  // Calling again with same target is a no-op.
  assert.equal(syncLocationHash({ screen: 'settings', settingsPage: 'manual' }, fakeLoc, fakeHist), false);
});

test('isNearChatBottom honors 80px stick-to-bottom threshold', () => {
  assert.equal(CHAT_STICK_THRESHOLD_PX, 80);
  assert.equal(isNearChatBottom(1000, 420, 500), true); // distance = 80
  assert.equal(isNearChatBottom(1000, 500, 500), true); // distance = 0
  assert.equal(isNearChatBottom(1000, 419, 500), false); // distance = 81
});

test('decideChatAutoScroll preserves restored scroll, forces bottom on entry, and shows jump pill when scrolled up', () => {
  const baseMetrics = {
    turnsCount: 2,
    latestTurnId: 't2',
    latestTurnLen: 20,
    latestTurnTools: 0,
    generatingLen: 0,
    liveToolName: '',
    failureNotice: '',
  };
  const incomingMetrics = {
    ...baseMetrics,
    turnsCount: 3,
    latestTurnId: 't3',
    latestTurnLen: 45,
  };

  assert.equal(hasIncomingChatContent(baseMetrics, incomingMetrics), true);
  assert.equal(hasIncomingChatContent(baseMetrics, baseMetrics), false);

  // Returning from DM/room preserves saved scrollTop.
  const restoreDecision = decideChatAutoScroll({
    restorePending: true,
    justEntered: true,
    targetChanged: false,
    stickToBottom: false,
    jumpingToBottom: false,
    searchOpen: false,
    prevMetrics: baseMetrics,
    currentMetrics: baseMetrics,
    scrollHeight: 2000,
    scrollTop: 400,
    clientHeight: 600,
  });
  assert.equal(restoreDecision.action, 'skip-restore');
  assert.equal(restoreDecision.nextStickToBottom, false);

  // Fresh entry forces scroll to bottom and clears jump pill.
  const entryDecision = decideChatAutoScroll({
    restorePending: false,
    justEntered: true,
    targetChanged: false,
    stickToBottom: false,
    jumpingToBottom: false,
    searchOpen: false,
    prevMetrics: baseMetrics,
    currentMetrics: baseMetrics,
    scrollHeight: 2000,
    scrollTop: 0,
    clientHeight: 600,
  });
  assert.equal(entryDecision.action, 'force-bottom');
  assert.equal(entryDecision.nextStickToBottom, true);
  assert.equal(entryDecision.showNewContentPill, false);

  // Under F6, size-change sticking is owned by useStickToBottom ResizeObserver,
  // so decideChatAutoScroll returns 'noop' when already stuck to bottom.
  const followDecision = decideChatAutoScroll({
    restorePending: false,
    justEntered: false,
    targetChanged: false,
    stickToBottom: true,
    jumpingToBottom: false,
    searchOpen: false,
    prevMetrics: baseMetrics,
    currentMetrics: incomingMetrics,
    scrollHeight: 2100,
    scrollTop: 1450,
    clientHeight: 600,
  });
  assert.equal(followDecision.action, 'noop');
  assert.equal(followDecision.nextStickToBottom, true);
  assert.equal(followDecision.showNewContentPill, false);

  // Scrolled up (> 80px away) with new content shows jump pill without yanking scroll.
  const scrolledUpDecision = decideChatAutoScroll({
    restorePending: false,
    justEntered: false,
    targetChanged: false,
    stickToBottom: false,
    jumpingToBottom: false,
    searchOpen: false,
    prevMetrics: baseMetrics,
    currentMetrics: incomingMetrics,
    scrollHeight: 2100,
    scrollTop: 500,
    clientHeight: 600,
  });
  assert.equal(scrolledUpDecision.action, 'show-jump-pill');
  assert.equal(scrolledUpDecision.nextStickToBottom, false);
  assert.equal(scrolledUpDecision.showNewContentPill, true);

  // While chat search is open, incoming content does not show the jump pill.
  const searchDecision = decideChatAutoScroll({
    restorePending: false,
    justEntered: false,
    targetChanged: false,
    stickToBottom: false,
    jumpingToBottom: false,
    searchOpen: true,
    prevMetrics: baseMetrics,
    currentMetrics: incomingMetrics,
    scrollHeight: 2100,
    scrollTop: 500,
    clientHeight: 600,
  });
  assert.equal(searchDecision.action, 'noop');
  assert.equal(searchDecision.showNewContentPill, false);
});

test('decideChatAutoScroll F6 simplified contract handles entering, targetChanged, restorePending, and explicit hasIncomingContent', () => {
  // 1. restorePending always takes precedence over entering/targetChanged and preserves stickToBottom.
  assert.deepEqual(
    decideChatAutoScroll({
      restorePending: true,
      entering: true,
      targetChanged: true,
      stickToBottom: true,
      searchOpen: false,
      hasIncomingContent: true,
    }),
    {
      action: 'skip-restore',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );

  // 2. entering (preferred prop) and targetChanged both force bottom and clear the jump pill.
  assert.deepEqual(
    decideChatAutoScroll({
      entering: true,
      targetChanged: false,
      stickToBottom: false,
      searchOpen: false,
    }),
    {
      action: 'force-bottom',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      justEntered: true,
      targetChanged: false,
      stickToBottom: false,
      searchOpen: false,
      hasIncomingContent: false,
    }),
    {
      action: 'noop',
      nextStickToBottom: false,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      targetChanged: true,
      stickToBottom: false,
      searchOpen: true,
    }),
    {
      action: 'force-bottom',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );

  // 3. !stickToBottom + explicit hasIncomingContent + !searchOpen shows jump pill without geometry inputs.
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      targetChanged: false,
      stickToBottom: false,
      searchOpen: false,
      hasIncomingContent: true,
    }),
    {
      action: 'show-jump-pill',
      nextStickToBottom: false,
      nextJumpingToBottom: false,
      showNewContentPill: true,
    },
  );

  // 4. searchOpen suppresses jump pill even with explicit hasIncomingContent: true.
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      targetChanged: false,
      stickToBottom: false,
      searchOpen: true,
      hasIncomingContent: true,
    }),
    {
      action: 'noop',
      nextStickToBottom: false,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );

  // 5. Explicit hasIncomingContent: false suppresses jump pill and stickToBottom: true returns noop.
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      targetChanged: false,
      stickToBottom: true,
      searchOpen: false,
      hasIncomingContent: true,
    }),
    {
      action: 'noop',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      targetChanged: false,
      stickToBottom: false,
      searchOpen: false,
      hasIncomingContent: false,
    }),
    {
      action: 'noop',
      nextStickToBottom: false,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );

  // 6. Empty chat metrics reset stickToBottom to true with noop action.
  const emptyMetrics = {
    turnsCount: 0,
    latestTurnId: '',
    latestTurnLen: 0,
    latestTurnTools: 0,
    generatingLen: 0,
    liveToolName: '',
    failureNotice: '',
  };
  assert.deepEqual(
    decideChatAutoScroll({
      entering: false,
      targetChanged: false,
      stickToBottom: false,
      searchOpen: false,
      currentMetrics: emptyMetrics,
    }),
    {
      action: 'noop',
      nextStickToBottom: true,
      nextJumpingToBottom: false,
      showNewContentPill: false,
    },
  );
});

test('isExitRootScreen only allows hub to exit/background the app at stack bottom', () => {
  assert.equal(isExitRootScreen('hub'), true);
  assert.equal(isExitRootScreen('tasks'), false);
  assert.equal(isExitRootScreen('board'), false);
  assert.equal(isExitRootScreen('settings'), false);
  assert.equal(isExitRootScreen('chat'), false);
  assert.equal(isExitRootScreen('bot-profile'), false);
});

test('resetNavStackChain builds clean [hub, chat] notification launch stack that pops to hub then hands off', () => {
  const stack = resetNavStackChain({ screen: 'hub' }, { screen: 'chat', botKey: 'local:local:b1' });
  assert.deepEqual(stack, [
    { screen: 'hub' },
    { screen: 'chat', botKey: 'local:local:b1' },
  ]);

  const backToHub = popNavEntry(stack);
  assert.equal(backToHub.popped, true);
  assert.deepEqual(backToHub.current, { screen: 'hub' });
  assert.equal(backToHub.stack.length, 1);

  const atRoot = popNavEntry(backToHub.stack);
  assert.equal(atRoot.popped, false);
  assert.deepEqual(atRoot.current, { screen: 'hub' });
});

test('cross-screen TaskDetail, Updates, and Group-Create stacks pop cleanly to their origins', () => {
  // Chat -> TaskDetail has non-tasks previous entry and pops straight back to chat.
  let chatTaskStack = createNavStack('hub');
  chatTaskStack = pushNavEntry(chatTaskStack, { screen: 'chat', botKey: 'local:local:b1' });
  chatTaskStack = pushNavEntry(chatTaskStack, { screen: 'tasks', taskId: 't1' });
  assert.equal(previousNavEntry(chatTaskStack)?.screen, 'chat');
  const backToChat = popNavEntry(chatTaskStack);
  assert.equal(backToChat.popped, true);
  assert.deepEqual(backToChat.current, { screen: 'chat', botKey: 'local:local:b1' });

  // Multi-hop Task A -> Chat -> Task B unwinds Task B -> Chat -> Task A cleanly.
  let multiHop = createNavStack('tasks', { taskId: 'tA' });
  multiHop = pushNavEntry(multiHop, { screen: 'chat', botKey: 'local:local:b1' });
  multiHop = pushNavEntry(multiHop, { screen: 'tasks', taskId: 'tB' });
  assert.equal(multiHop.length, 3);
  assert.equal(previousNavEntry(multiHop)?.screen, 'chat');

  const hop1 = popNavEntry(multiHop);
  assert.equal(hop1.popped, true);
  assert.deepEqual(hop1.current, { screen: 'chat', botKey: 'local:local:b1' });

  const hop2 = popNavEntry(hop1.stack);
  assert.equal(hop2.popped, true);
  assert.deepEqual(hop2.current, { screen: 'tasks', taskId: 'tA' });

  const backToTaskList = replaceTopNavEntry(hop2.stack, { ...hop2.current, taskId: null });
  assert.deepEqual(backToTaskList, [{ screen: 'tasks', taskId: null }]);
  assert.equal(popNavEntry(backToTaskList).popped, false);

  // Pushing settings/updates onto hub, tasks, board, or chat pops straight back to the origin.
  const origins = [
    createNavStack('hub'),
    createNavStack('tasks'),
    createNavStack('board'),
    pushNavEntry(createNavStack('hub'), { screen: 'chat', botKey: 'local:local:b1' }),
  ];
  for (const originStack of origins) {
    const originTop = currentNavEntry(originStack);
    const withUpdates = pushNavEntry(originStack, { screen: 'settings', settingsPage: 'updates' });
    assert.equal(withUpdates.length, originStack.length + 1);
    assert.deepEqual(currentNavEntry(withUpdates), { screen: 'settings', settingsPage: 'updates' });
    // Pushing updates again while already on updates does not duplicate the frame.
    assert.equal(
      pushNavEntry(withUpdates, { screen: 'settings', settingsPage: 'updates' }).length,
      withUpdates.length,
    );
    const popped = popNavEntry(withUpdates);
    assert.equal(popped.popped, true);
    assert.deepEqual(popped.current, originTop);
  }

  // Group-Create -> Bot-Edit keeps group-create beneath top and pops back to group-create.
  let groupCreateStack = createNavStack('hub');
  groupCreateStack = pushNavEntry(groupCreateStack, { screen: 'group-create' });
  groupCreateStack = pushNavEntry(groupCreateStack, { screen: 'bot-edit' });
  assert.equal(previousNavEntry(groupCreateStack)?.screen, 'group-create');
  const backToGroupCreate = popNavEntry(groupCreateStack);
  assert.equal(backToGroupCreate.popped, true);
  assert.deepEqual(backToGroupCreate.current, { screen: 'group-create' });
  assert.deepEqual(
    backToGroupCreate.stack.map(entry => entry.screen),
    ['hub', 'group-create'],
  );
});

test('overlayStack LIFO invokes topmost drawer/modal before page handler and stays clean on out-of-order unregister', () => {
  const prevWindow = globalThis.window;
  const listeners = new Map();
  const fakeWindow = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchBack() {
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation() {},
      };
      for (const fn of listeners.get('app-back') ?? []) {
        fn(event);
        if (event.defaultPrevented) break;
      }
      return event.defaultPrevented;
    },
  };
  globalThis.window = fakeWindow;
  const cleanups = [];
  try {
    assert.equal(hasOpenOverlay(), false);
    assert.equal(getOverlayStackDepth(), 0);
    assert.equal(fakeWindow.dispatchBack(), false);

    const calls = [];
    let unregPage = () => {};
    let unregDrawer = () => {};
    unregPage = registerOverlayBackHandler(() => {
      calls.push('page');
      unregPage();
    });
    cleanups.push(unregPage);
    unregDrawer = registerOverlayBackHandler(() => {
      calls.push('drawer');
      unregDrawer();
    });
    cleanups.push(unregDrawer);

    assert.equal(hasOpenOverlay(), true);
    assert.equal(getOverlayStackDepth(), 2);

    // Topmost drawer/modal closes first.
    assert.equal(fakeWindow.dispatchBack(), true);
    assert.deepEqual(calls, ['drawer']);
    assert.equal(getOverlayStackDepth(), 1);

    // Underlying page-level handler runs second.
    assert.equal(fakeWindow.dispatchBack(), true);
    assert.deepEqual(calls, ['drawer', 'page']);
    assert.equal(getOverlayStackDepth(), 0);
    assert.equal(hasOpenOverlay(), false);

    // Empty stack returns false so native/Host fallback runs.
    assert.equal(fakeWindow.dispatchBack(), false);

    // Out-of-order unregistration preserves remaining LIFO order cleanly.
    const order = [];
    const unregA = registerOverlayBackHandler(() => order.push('A'));
    const unregB = registerOverlayBackHandler(() => order.push('B'));
    const unregC = registerOverlayBackHandler(() => order.push('C'));
    cleanups.push(unregA, unregB, unregC);

    unregB();
    unregB(); // duplicate unregister is a no-op
    assert.equal(getOverlayStackDepth(), 2);

    assert.equal(fakeWindow.dispatchBack(), true);
    assert.deepEqual(order, ['C']);
    unregC();

    assert.equal(fakeWindow.dispatchBack(), true);
    assert.deepEqual(order, ['C', 'A']);
    unregA();

    assert.equal(getOverlayStackDepth(), 0);
    assert.equal(fakeWindow.dispatchBack(), false);
  } finally {
    for (const fn of cleanups) fn();
    if (prevWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = prevWindow;
    }
  }
});

test('TauriMainActivity handleBackNavigation dispatches app-back with dialog Escape & moveTaskToBack and omits dead hooks', () => {
  const javaSource = readFileSync(
    new URL('../../app/src/main/java/com/example/launcherprobe/TauriMainActivity.java', import.meta.url),
    'utf8',
  );
  const startIdx = javaSource.indexOf('private void handleBackNavigation()');
  assert.notEqual(startIdx, -1, 'handleBackNavigation method should exist');
  const nextMethodIdx = javaSource.indexOf('private float getDisplayDensity', startIdx);
  assert.notEqual(nextMethodIdx, -1, 'Expected method boundary after handleBackNavigation');
  const methodBody = javaSource.slice(startIdx, nextMethodIdx);

  assert.match(methodBody, /new Event\('app-back',\{cancelable:true\}\)/);
  assert.match(methodBody, /\[role=\\"dialog\\"\]:not\(\[aria-hidden=\\"true\\"\]\)/);
  assert.match(methodBody, /key:'Escape'/);
  assert.match(methodBody, /moveTaskToBack\(true\)/);
  assert.doesNotMatch(javaSource, /composer-back/);
  assert.doesNotMatch(methodBody, /window\.history\.state/);
});
