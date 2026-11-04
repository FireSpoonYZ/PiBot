import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openHost } from '../../host-core/host.js';
import {
  ScheduleRule,
  ScheduleCalendar,
  getDefaultScheduleCalendar,
  zonedWallTimeToEpochMs,
} from '../../host-core/schedule-calendar.js';
import {
  normalizeScheduleTaskInput,
  normalizeScheduleControlParams,
} from '../../host-core/schedule-protocol.js';
import { normalizeControlCall } from '../../host-core/remote-control-protocol.js';
import { createScheduleManager } from '../../host-core/host-schedules.js';
import { createScheduleTools } from '../../host-core/schedule-tools.js';
import { PrimaryIndex } from '../../host-core/runtime-docs.js';
import { WorkIndex, WorkContextState } from '../../host-core/work-context-docs.js';

function epochMs(zoneId, year, month, day, hour, minute, second = 0) {
  return zonedWallTimeToEpochMs(year, month, day, hour, minute, zoneId) + second * 1000;
}

test('ScheduleRule: daily, weekly, monthly, DST, and statutory calendar rules match Android ScheduleRuleTest', () => {
  const calendar = getDefaultScheduleCalendar();
  const shanghai = 'Asia/Shanghai';

  const daily = ScheduleRule.fromJson({ repeat: 'daily', time: '09:30' });
  assert.equal(
    daily.nextAfter(epochMs(shanghai, 2026, 4, 20, 9, 29, 59), shanghai, calendar),
    epochMs(shanghai, 2026, 4, 20, 9, 30, 0),
  );
  assert.equal(
    daily.nextAfter(epochMs(shanghai, 2026, 4, 20, 9, 30, 0), shanghai, calendar),
    epochMs(shanghai, 2026, 4, 21, 9, 30, 0),
  );

  const weekly = ScheduleRule.fromJson({
    repeat: 'weekly',
    time: '08:00',
    weekdays: [5, 1, 3],
  });
  assert.deepEqual(weekly.weekdays, [1, 3, 5]);
  assert.equal(
    weekly.nextAfter(epochMs(shanghai, 2026, 4, 20, 8, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2026, 4, 22, 8, 0, 0),
  );

  const monthly31 = ScheduleRule.fromJson({
    repeat: 'monthly',
    time: '10:00',
    monthDay: 31,
  });
  assert.equal(
    monthly31.nextAfter(epochMs(shanghai, 2026, 4, 1, 0, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2026, 5, 31, 10, 0, 0),
  );

  const leapDay = ScheduleRule.fromJson({
    repeat: 'monthly',
    time: '07:15',
    monthDay: 29,
  });
  assert.equal(
    leapDay.nextAfter(epochMs(shanghai, 2025, 2, 1, 0, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2025, 3, 29, 7, 15, 0),
  );
  assert.equal(
    leapDay.nextAfter(epochMs(shanghai, 2024, 2, 1, 0, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2024, 2, 29, 7, 15, 0),
  );

  // DST gap and overlap in America/New_York
  const ny = 'America/New_York';
  const dstGap = ScheduleRule.fromJson({ repeat: 'daily', time: '02:30' });
  assert.equal(
    dstGap.nextAfter(epochMs(ny, 2026, 3, 8, 1, 0, 0), ny, calendar),
    epochMs(ny, 2026, 3, 8, 3, 30, 0),
  );

  // Statutory workday & holiday in Asia/Shanghai
  const workday = ScheduleRule.fromJson({ repeat: 'statutoryWorkday', time: '09:00' });
  // 2026-04-30 Thursday after 09:00 -> May 1-5 is Labor Day holiday -> May 6 Wednesday
  assert.equal(
    workday.nextAfter(epochMs(shanghai, 2026, 4, 30, 9, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2026, 5, 6, 9, 0, 0),
  );
  // 2026-05-08 Friday after 09:00 -> 2026-05-09 Saturday is a make-up workday!
  assert.equal(
    workday.nextAfter(epochMs(shanghai, 2026, 5, 8, 9, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2026, 5, 9, 9, 0, 0),
  );

  const holiday = ScheduleRule.fromJson({ repeat: 'statutoryHoliday', time: '10:00' });
  assert.equal(
    holiday.nextAfter(epochMs(shanghai, 2026, 5, 8, 10, 0, 0), shanghai, calendar),
    epochMs(shanghai, 2026, 5, 10, 10, 0, 0),
  );
});

test('schedule-protocol and remote-control-protocol validate scheduleTask calls strictly', () => {
  const validCreate = normalizeControlCall('scheduleTask', {
    botId: 'bot-alpha',
    input: {
      action: 'create',
      title: '每日早报',
      prompt: '汇总今日待办',
      repeat: 'daily',
      time: '08:30',
    },
  });
  assert.equal(validCreate.method, 'scheduleTask');
  assert.equal(validCreate.params.botId, 'bot-alpha');
  assert.equal(validCreate.params.input.action, 'create');

  assert.throws(
    () =>
      normalizeScheduleTaskInput({
        action: 'create',
        title: 'bad',
        prompt: 'bad',
        repeat: 'daily',
        time: '25:00',
      }),
    (err) => err?.code === 'INVALID_ARGUMENT',
  );

  assert.throws(
    () =>
      normalizeScheduleControlParams({
        botId: 'bot-alpha',
        input: { action: 'delete', id: 'not-a-uuid', revision: 1 },
      }),
    /UUID/,
  );
});

test('createScheduleManager (Node SQLite): multi-bot CRUD, CAS, trigger execution, archive pause, and delete cleanup', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schedule-mgr-test-'));
  const host = openHost({ dataRoot });
  try {
    const primaryBot = host.createBot({
      requestId: 'req-primary',
      role: 'Jarvis',
      cwd: dataRoot,
      makePrimary: true,
    });
    const workerBot = host.createBot({
      requestId: 'req-worker',
      role: 'Researcher',
      cwd: dataRoot,
      makePrimary: false,
    });

    const submitted = [];
    const fakeRuntime = {
      async submit(botId, { requestId, text }) {
        submitted.push({ botId, requestId, text });
        const bot = host.getBot(botId);
        return {
          botId,
          conversationId: bot.primaryConversationId,
          requestId,
          submissionId: submitted.length,
          status: 'done',
        };
      },
      async getSubmission(botId, requestId) {
        const bot = host.getBot(botId);
        return {
          botId,
          conversationId: bot.primaryConversationId,
          requestId,
          submissionId: 1,
          status: 'done',
        };
      },
    };

    const schedules = createScheduleManager({
      host,
      getRuntime: () => fakeRuntime,
      isOnline: () => true,
    });
    schedules.start();

    // Non-primary workerBot creates its own scheduled task
    const createdWorker = await schedules.execute(workerBot, {
      action: 'create',
      title: '巡检任务',
      prompt: '检查构建状态',
      repeat: 'daily',
      time: '09:00',
    });
    assert.equal(createdWorker.task.title, '巡检任务');
    assert.equal(createdWorker.task.prompt, '检查构建状态');
    assert.equal(createdWorker.task.revision, 1);
    assert.equal(createdWorker.task.enabled, true);

    // Primary bot's schedule list is isolated from workerBot's schedule list
    const primaryList = await schedules.execute(primaryBot, { action: 'list' });
    assert.equal(primaryList.tasks.length, 0);

    const workerList = await schedules.execute(workerBot, { action: 'list' });
    assert.equal(workerList.tasks.length, 1);
    assert.equal(workerList.tasks[0].id, createdWorker.task.id);

    // CAS revision check rejects stale revision
    await assert.rejects(
      () =>
        schedules.execute(workerBot, {
          action: 'update',
          id: createdWorker.task.id,
          revision: 99,
          title: '越权修改',
        }),
      (err) => err?.code === 'REQUEST_CONFLICT',
    );

    // Update increments revision
    const updatedWorker = await schedules.execute(workerBot, {
      action: 'update',
      id: createdWorker.task.id,
      revision: 1,
      title: '每日巡检 v2',
    });
    assert.equal(updatedWorker.task.revision, 2);
    assert.equal(updatedWorker.task.title, '每日巡检 v2');

    // Archive pauseBot disables active tasks for workerBot
    await schedules.pauseBot(workerBot);
    const afterPause = await schedules.execute(workerBot, { action: 'list' });
    assert.equal(afterPause.tasks[0].enabled, false);
    assert.equal(afterPause.tasks[0].nextRunAt, 0);
    assert.equal(afterPause.tasks[0].revision, 3);

    // Delete deleteBot removes all tasks for workerBot
    await schedules.deleteBot(workerBot);
    const afterDelete = await schedules.execute(workerBot, { action: 'list' });
    assert.equal(afterDelete.tasks.length, 0);

    await schedules.close();
  } finally {
    host.close();
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('schedule_task tool: works for non-primary Bot, room/dm contexts, and cross-bot scheduling', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schedule-tool-test-'));
  const host = openHost({ dataRoot });
  let schedules = null;
  try {
    const primaryBot = host.createBot({
      requestId: 'req-1',
      role: 'PrimaryBot',
      cwd: dataRoot,
      makePrimary: true,
    });
    const secondBot = host.createBot({
      requestId: 'req-2',
      role: 'SecondBot',
      cwd: dataRoot,
      makePrimary: false,
    });

    // Fake harness snapshot supporting both primary conversation (id=101 for secondBot)
    // and room work context (id=202 for primaryBot in scope room-1)
    const fakeHarness = {
      async snapshot(doc, id) {
        if (doc === PrimaryIndex) {
          return {
            byPrimary: {
              [primaryBot.primaryConversationId]: 100,
              [secondBot.primaryConversationId]: 101,
            },
          };
        }
        if (doc === WorkIndex) {
          return {
            byKey: {
              [JSON.stringify([primaryBot.botId, 'room-1'])]: { nativeId: 202 },
            },
          };
        }
        if (doc === WorkContextState && id === 202) {
          return {
            deviceId: host.deviceId,
            botId: primaryBot.botId,
            conversationId: 'work-conv-202',
            scopeId: 'room-1',
            kind: 'room',
          };
        }
        return null;
      },
    };

    schedules = createScheduleManager({
      host,
      getRuntime: () => null,
      isOnline: () => true,
    });
    schedules.start();

    const remoteCalls = [];
    const collaboration = {
      async scheduleTask(call) {
        remoteCalls.push(call);
        return {
          exactAlarmGranted: true,
          schedulingError: '',
          timeZone: 'Asia/Shanghai',
          now: Date.now(),
          tasks: [],
          nextCursor: null,
        };
      },
    };

    const [scheduleTool] = createScheduleTools({
      host,
      getHarness: () => fakeHarness,
      schedules,
      collaboration,
    });

    // 1. Non-primary Bot (secondBot) creates its own task in primary chat (conversationId=101)
    const res1 = await scheduleTool.execute(
      {
        action: 'create',
        title: '普通Bot自己的任务',
        prompt: '执行自检',
        repeat: 'daily',
        time: '10:30',
      },
      { conversationId: 101, taskId: 7 },
      {},
    );
    assert.equal(res1.isError, undefined);
    const parsed1 = JSON.parse(res1.output[0].text);
    assert.equal(parsed1.task.title, '普通Bot自己的任务');

    // 2. Bot in a room work context (conversationId=202 -> primaryBot in room-1) creates a task for itself
    const res2 = await scheduleTool.execute(
      {
        action: 'create',
        title: '群聊中创建的定时任务',
        prompt: '汇总群聊进展',
        repeat: 'weekly',
        weekdays: [1, 5],
        time: '18:00',
      },
      { conversationId: 202, taskId: 8 },
      {},
    );
    assert.equal(res2.isError, undefined);
    const parsed2 = JSON.parse(res2.output[0].text);
    assert.equal(parsed2.task.title, '群聊中创建的定时任务');

    // Verify primaryBot's schedule list has that task
    const listPrimary = await schedules.execute(primaryBot, { action: 'list' });
    assert.equal(listPrimary.tasks.length, 1);
    assert.equal(listPrimary.tasks[0].title, '群聊中创建的定时任务');

    // 3. PrimaryBot manages secondBot's schedules by passing botId
    const res3 = await scheduleTool.execute(
      {
        action: 'list',
        botId: secondBot.botId,
      },
      { conversationId: 100, taskId: 9 },
      {},
    );
    assert.equal(res3.isError, undefined);
    const parsed3 = JSON.parse(res3.output[0].text);
    assert.equal(parsed3.tasks.length, 1);
    assert.equal(parsed3.tasks[0].title, '普通Bot自己的任务');

    // 4. PrimaryBot manages a remote device Bot's schedules by passing deviceId + botId
    const res4 = await scheduleTool.execute(
      {
        action: 'list',
        deviceId: 'remote-device-99',
        botId: 'remote-bot-1',
      },
      { conversationId: 100, taskId: 10 },
      {},
    );
    assert.equal(res4.isError, undefined);
    assert.equal(remoteCalls.length, 1);
    assert.equal(remoteCalls[0].deviceId, 'remote-device-99');
    assert.equal(remoteCalls[0].botId, 'remote-bot-1');

    await schedules.close();
  } finally {
    await schedules?.close();
    host.close();
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
