import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROOT_SCREENS,
  createNavStack,
  currentNavEntry,
  isRootScreen,
  navEntryToHash,
  parseHashToRootEntry,
  popNavEntry,
  previousNavEntry,
  pushNavEntry,
  replaceTopNavEntry,
  resetNavStack,
  syncLocationHash,
} from '../src/hub/navigationLogic.ts';
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

  // Sticking to bottom follows incoming streaming messages automatically.
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
  assert.equal(followDecision.action, 'scroll-bottom');
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
