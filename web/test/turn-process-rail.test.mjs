import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatTurnsWithoutBotDm,
  chatTurnsWithoutToolOutput,
  groupProcessTimelineSteps,
  isBotDmSendToTool,
  parseHistoryEntries,
  partitionAssistantTurnBlocks,
  resolveAssistantCopyText,
} from '../src/chatTurnModel.ts';

function userEntry(id, text) {
  return {
    id,
    kind: 'pi.user',
    model: [{ role: 'user', content: [{ type: 'text', text }] }],
  };
}

function assistantEntry(id, content) {
  return {
    id,
    kind: 'pi.assistant',
    model: [{ role: 'assistant', content }],
  };
}

function toolResultEntry(id, toolCallId, toolName, text = 'ok') {
  return {
    id,
    kind: 'pi.tool_result',
    model: [
      {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
      },
    ],
  };
}

test('single-step Q&A without tools keeps text non-interim and emits no process segment', () => {
  const turns = parseHistoryEntries([
    userEntry(1, 'What is 2 + 2?'),
    assistantEntry(2, [{ type: 'text', text: '4' }]),
  ]);

  assert.equal(turns.length, 2);
  const [userTurn, assistantTurn] = turns;
  assert.equal(assistantTurn.blocks?.length, 1);
  assert.equal(assistantTurn.blocks[0].kind, 'text');
  assert.equal(assistantTurn.blocks[0].text, '4');
  assert.equal(assistantTurn.blocks[0].interim, undefined);

  const segments = partitionAssistantTurnBlocks(assistantTurn.blocks);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'block');
  assert.equal(segments[0].id, assistantTurn.blocks[0].id);
  assert.equal(segments[0].block, assistantTurn.blocks[0]);
  assert.equal(segments.some((seg) => seg.kind === 'process'), false);

  assert.equal(resolveAssistantCopyText(assistantTurn), '4');
  assert.equal(resolveAssistantCopyText(userTurn), 'What is 2 + 2?');
  assert.equal(resolveAssistantCopyText({ role: 'assistant', text: 'Legacy turn' }), 'Legacy turn');
  assert.deepEqual(partitionAssistantTurnBlocks(undefined), []);
  assert.deepEqual(partitionAssistantTurnBlocks([]), []);
});

test('single-step tool turn marks pre-tool text interim and folds uniformly with and without tool output', () => {
  const turns = parseHistoryEntries([
    userEntry(1, 'Check the package name'),
    assistantEntry(2, [
      { type: 'text', text: 'Let me inspect package.json.' },
      { type: 'toolCall', id: 'tc_1', name: 'read', arguments: { path: 'package.json' } },
    ]),
    toolResultEntry(3, 'tc_1', 'read', '{"name":"pibot"}'),
    assistantEntry(4, [{ type: 'text', text: 'The package name is pibot.' }]),
  ]);

  assert.equal(turns.length, 2);
  const assistantTurn = turns[1];
  assert.equal(assistantTurn.blocks?.length, 3);
  assert.equal(assistantTurn.blocks[0].kind, 'text');
  assert.equal(assistantTurn.blocks[0].text, 'Let me inspect package.json.');
  assert.equal(assistantTurn.blocks[0].interim, true);
  assert.equal(assistantTurn.blocks[1].kind, 'tools');
  assert.equal(assistantTurn.blocks[1].tools[0].id, 'tc_1');
  assert.equal(assistantTurn.blocks[2].kind, 'text');
  assert.equal(assistantTurn.blocks[2].text, 'The package name is pibot.');
  assert.equal(assistantTurn.blocks[2].interim, undefined);

  const fullSegments = partitionAssistantTurnBlocks(assistantTurn.blocks);
  assert.equal(fullSegments.length, 2);
  assert.equal(fullSegments[0].kind, 'process');
  assert.equal(fullSegments[0].id, `${assistantTurn.blocks[0].id}-process`);
  assert.deepEqual(fullSegments[0].blocks, [assistantTurn.blocks[0], assistantTurn.blocks[1]]);
  assert.equal(fullSegments[1].kind, 'block');
  assert.equal(fullSegments[1].id, assistantTurn.blocks[2].id);
  assert.equal(fullSegments[1].block, assistantTurn.blocks[2]);
  assert.equal(resolveAssistantCopyText(assistantTurn), 'The package name is pibot.');

  const strippedTurns = chatTurnsWithoutToolOutput(turns);
  assert.equal(strippedTurns.length, 2);
  const strippedTurn = strippedTurns[1];
  assert.equal(strippedTurn.tools, undefined);
  assert.equal(strippedTurn.blocks?.length, 2);
  assert.equal(strippedTurn.blocks[0].kind, 'text');
  assert.equal(strippedTurn.blocks[0].interim, true);
  assert.equal(strippedTurn.blocks[1].kind, 'text');
  assert.equal(strippedTurn.blocks[1].interim, undefined);

  const strippedSegments = partitionAssistantTurnBlocks(strippedTurn.blocks);
  assert.equal(strippedSegments.length, 2);
  assert.equal(strippedSegments[0].kind, 'process');
  assert.equal(strippedSegments[0].id, `${strippedTurn.blocks[0].id}-process`);
  assert.deepEqual(strippedSegments[0].blocks, [strippedTurn.blocks[0]]);
  assert.equal(strippedSegments[1].kind, 'block');
  assert.equal(strippedSegments[1].id, strippedTurn.blocks[1].id);
  assert.equal(strippedSegments[1].block, strippedTurn.blocks[1]);
  assert.equal(resolveAssistantCopyText(strippedTurn), 'The package name is pibot.');
});

test('multi-step turn marks all pre-tool texts interim, groups them into one process segment after stripping tools, and copies only final answer', () => {
  const narrations = [
    'Step 1: reading config.',
    'Step 2: searching call sites.',
    'Step 3: updating handler.',
    'Step 4: verifying output.',
  ];
  const finalAnswer = 'All four steps completed and the bug is fixed.';

  const turns = parseHistoryEntries([
    userEntry(1, 'Fix the sync issue'),
    assistantEntry(2, [
      { type: 'text', text: narrations[0] },
      { type: 'toolCall', id: 'tc_1', name: 'read', arguments: { path: 'config.ts' } },
    ]),
    toolResultEntry(3, 'tc_1', 'read', 'config ok'),
    assistantEntry(4, [
      { type: 'text', text: narrations[1] },
      { type: 'toolCall', id: 'tc_2', name: 'grep', arguments: { pattern: 'syncState' } },
    ]),
    toolResultEntry(5, 'tc_2', 'grep', 'sync.ts:42'),
    assistantEntry(6, [
      { type: 'text', text: narrations[2] },
      { type: 'toolCall', id: 'tc_3', name: 'edit', arguments: { path: 'sync.ts' } },
    ]),
    toolResultEntry(7, 'tc_3', 'edit', 'edited'),
    assistantEntry(8, [
      { type: 'text', text: narrations[3] },
      { type: 'toolCall', id: 'tc_4', name: 'bash', arguments: { command: 'npm test' } },
    ]),
    toolResultEntry(9, 'tc_4', 'bash', 'pass'),
    assistantEntry(10, [{ type: 'text', text: finalAnswer }]),
  ]);

  const assistantTurn = turns[1];
  assert.equal(assistantTurn.blocks?.length, 9);
  for (let i = 0; i < 4; i += 1) {
    const textBlock = assistantTurn.blocks[i * 2];
    assert.equal(textBlock.kind, 'text');
    assert.equal(textBlock.text, narrations[i]);
    assert.equal(textBlock.interim, true);
    assert.equal(assistantTurn.blocks[i * 2 + 1].kind, 'tools');
  }
  const finalBlock = assistantTurn.blocks[8];
  assert.equal(finalBlock.kind, 'text');
  assert.equal(finalBlock.text, finalAnswer);
  assert.equal(finalBlock.interim, undefined);

  const fullSegments = partitionAssistantTurnBlocks(assistantTurn.blocks);
  assert.equal(fullSegments.length, 2);
  assert.equal(fullSegments[0].kind, 'process');
  assert.equal(fullSegments[0].blocks.length, 8);
  assert.equal(fullSegments[1].kind, 'block');
  assert.equal(fullSegments[1].block, finalBlock);

  const strippedTurn = chatTurnsWithoutToolOutput(turns)[1];
  assert.equal(strippedTurn.blocks?.length, 5);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(strippedTurn.blocks[i].kind, 'text');
    assert.equal(strippedTurn.blocks[i].text, narrations[i]);
    assert.equal(strippedTurn.blocks[i].interim, true);
  }
  assert.equal(strippedTurn.blocks[4].kind, 'text');
  assert.equal(strippedTurn.blocks[4].text, finalAnswer);
  assert.equal(strippedTurn.blocks[4].interim, undefined);

  const strippedSegments = partitionAssistantTurnBlocks(strippedTurn.blocks);
  assert.equal(strippedSegments.length, 2);
  assert.equal(strippedSegments[0].kind, 'process');
  assert.equal(strippedSegments[0].id, `${strippedTurn.blocks[0].id}-process`);
  assert.deepEqual(
    strippedSegments[0].blocks.map((block) => block.text),
    narrations,
  );
  assert.equal(strippedSegments[1].kind, 'block');
  assert.equal(strippedSegments[1].block, strippedTurn.blocks[4]);

  assert.ok(assistantTurn.text.includes(narrations[0]));
  assert.equal(resolveAssistantCopyText(assistantTurn), finalAnswer);
  assert.equal(resolveAssistantCopyText(strippedTurn), finalAnswer);

  assert.equal(
    resolveAssistantCopyText({
      role: 'assistant',
      text: 'fallback',
      blocks: [
        { id: 'b1', kind: 'text', text: 'Interim note', interim: true },
        { id: 'b2', kind: 'text', text: '   ' },
        { id: 'b3', kind: 'text', text: '  First final paragraph.  ' },
        { id: 'b4', kind: 'text', text: '  Second final paragraph.  ' },
      ],
    }),
    'First final paragraph.\n\nSecond final paragraph.',
  );
});

test('promoted interactive and Bot DM tool blocks split process rails cleanly', () => {
  const interactiveTurns = parseHistoryEntries([
    userEntry(1, 'Deploy after confirming target'),
    assistantEntry(2, [
      { type: 'text', text: 'Checking deployment environments.' },
      { type: 'toolCall', id: 'tc_read', name: 'read', arguments: { path: 'deploy.json' } },
    ]),
    toolResultEntry(3, 'tc_read', 'read', '{"targets":["staging","prod"]}'),
    assistantEntry(4, [
      { type: 'text', text: 'Asking you to confirm the target.' },
      { type: 'toolCall', id: 'tc_ask', name: 'ask_user_question', arguments: { title: 'Target?' } },
    ]),
    toolResultEntry(5, 'tc_ask', 'ask_user_question', 'staging'),
    assistantEntry(6, [
      { type: 'text', text: 'Running staging deploy.' },
      { type: 'toolCall', id: 'tc_bash', name: 'bash', arguments: { command: 'deploy staging' } },
    ]),
    toolResultEntry(7, 'tc_bash', 'bash', 'deployed'),
    assistantEntry(8, [{ type: 'text', text: 'Staging deployment succeeded.' }]),
  ]);

  const interactiveTurn = interactiveTurns[1];
  assert.equal(interactiveTurn.blocks?.length, 7);
  const interactiveSegments = partitionAssistantTurnBlocks(interactiveTurn.blocks, {
    isPromotedToolBlock: (tools) => tools.some((tool) => tool.name === 'ask_user_question'),
  });

  assert.deepEqual(
    interactiveSegments.map((seg) => seg.kind),
    ['process', 'block', 'process', 'block'],
  );
  assert.equal(interactiveSegments[0].id, `${interactiveTurn.blocks[0].id}-process`);
  assert.deepEqual(interactiveSegments[0].blocks, [
    interactiveTurn.blocks[0],
    interactiveTurn.blocks[1],
    interactiveTurn.blocks[2],
  ]);
  assert.equal(interactiveSegments[1].id, interactiveTurn.blocks[3].id);
  assert.equal(interactiveSegments[1].block, interactiveTurn.blocks[3]);
  assert.equal(interactiveSegments[2].id, `${interactiveTurn.blocks[4].id}-process`);
  assert.deepEqual(interactiveSegments[2].blocks, [
    interactiveTurn.blocks[4],
    interactiveTurn.blocks[5],
  ]);
  assert.equal(interactiveSegments[3].id, interactiveTurn.blocks[6].id);
  assert.equal(interactiveSegments[3].block, interactiveTurn.blocks[6]);

  const dmTurns = parseHistoryEntries([
    userEntry(10, 'Ask reviewer bot to verify'),
    assistantEntry(11, [
      { type: 'text', text: 'Reading local diff.' },
      { type: 'toolCall', id: 'tc_diff', name: 'bash', arguments: { command: 'git diff' } },
    ]),
    toolResultEntry(12, 'tc_diff', 'bash', '+line'),
    assistantEntry(13, [
      { type: 'text', text: 'Sending request to reviewer bot.' },
      {
        type: 'toolCall',
        id: 'tc_dm',
        name: 'send_to',
        arguments: { scopeId: 'scope_dm_1', text: 'Please review this patch' },
      },
    ]),
    toolResultEntry(
      14,
      'tc_dm',
      'send_to',
      JSON.stringify({
        messageId: 'm_dm_1',
        scopeId: 'scope_dm_1',
        scopeKind: 'dm',
        category: 'request',
        status: 'stored',
      }),
    ),
    assistantEntry(15, [
      { type: 'text', text: 'Recording verification note.' },
      { type: 'toolCall', id: 'tc_log', name: 'write', arguments: { path: 'notes.txt' } },
    ]),
    toolResultEntry(16, 'tc_log', 'write', 'ok'),
    assistantEntry(17, [{ type: 'text', text: 'Sent to reviewer and logged.' }]),
  ]);

  const dmTurn = dmTurns[1];
  const dmSegments = partitionAssistantTurnBlocks(dmTurn.blocks, {
    isPromotedToolBlock: (tools) => tools.some((tool) => isBotDmSendToTool(tool, dmTurn)),
  });
  assert.deepEqual(
    dmSegments.map((seg) => seg.kind),
    ['process', 'block', 'process', 'block'],
  );
  assert.equal(dmSegments[1].block.kind, 'tools');
  assert.equal(dmSegments[1].block.tools[0].id, 'tc_dm');

  const withoutDmTurn = chatTurnsWithoutBotDm(dmTurns)[1];
  const withoutDmTextBlocks = (withoutDmTurn.blocks ?? []).filter((block) => block.kind === 'text');
  assert.equal(withoutDmTextBlocks.length, 4);
  assert.equal(withoutDmTextBlocks[0].interim, true);
  assert.equal(withoutDmTextBlocks[1].interim, true);
  assert.equal(withoutDmTextBlocks[2].interim, true);
  assert.equal(withoutDmTextBlocks[3].interim, undefined);
});

test('settled turn empty-shell fallback promotes last interim text block and copy falls back to turn.text', () => {
  const turns = parseHistoryEntries([
    userEntry(1, 'Restart the background worker'),
    assistantEntry(2, [
      { type: 'text', text: 'Inspecting worker status.' },
      { type: 'toolCall', id: 'tc_1', name: 'bash', arguments: { command: 'worker status' } },
    ]),
    toolResultEntry(3, 'tc_1', 'bash', 'stopped'),
    assistantEntry(4, [
      { type: 'text', text: 'Restarting the worker now.' },
      { type: 'toolCall', id: 'tc_2', name: 'bash', arguments: { command: 'worker start' } },
    ]),
    toolResultEntry(5, 'tc_2', 'bash', 'running'),
  ]);

  const assistantTurn = turns[1];
  assert.equal(assistantTurn.blocks?.length, 4);
  assert.equal(assistantTurn.blocks[0].kind, 'text');
  assert.equal(assistantTurn.blocks[0].interim, true);
  assert.equal(assistantTurn.blocks[2].kind, 'text');
  assert.equal(assistantTurn.blocks[2].interim, true);

  const settledSegments = partitionAssistantTurnBlocks(assistantTurn.blocks, { isLive: false });
  assert.deepEqual(
    settledSegments.map((seg) => seg.kind),
    ['process', 'block', 'process'],
  );
  assert.deepEqual(settledSegments[0].blocks, [assistantTurn.blocks[0], assistantTurn.blocks[1]]);
  assert.equal(settledSegments[1].id, assistantTurn.blocks[2].id);
  assert.equal(settledSegments[1].block, assistantTurn.blocks[2]);
  assert.deepEqual(settledSegments[2].blocks, [assistantTurn.blocks[3]]);

  // Omitting options defaults to settled fallback behavior.
  assert.deepEqual(partitionAssistantTurnBlocks(assistantTurn.blocks), settledSegments);

  const strippedTurn = chatTurnsWithoutToolOutput(turns)[1];
  assert.equal(strippedTurn.blocks?.length, 2);
  const strippedSegments = partitionAssistantTurnBlocks(strippedTurn.blocks, { isLive: false });
  assert.deepEqual(
    strippedSegments.map((seg) => seg.kind),
    ['process', 'block'],
  );
  assert.deepEqual(strippedSegments[0].blocks, [strippedTurn.blocks[0]]);
  assert.equal(strippedSegments[1].block, strippedTurn.blocks[1]);

  // Single interim text block with no other blocks promotes to top-level with zero process rail.
  const singleTextSegments = partitionAssistantTurnBlocks([strippedTurn.blocks[0]], { isLive: false });
  assert.equal(singleTextSegments.length, 1);
  assert.equal(singleTextSegments[0].kind, 'block');
  assert.equal(singleTextSegments[0].block, strippedTurn.blocks[0]);

  assert.equal(resolveAssistantCopyText(assistantTurn), assistantTurn.text);
  assert.equal(assistantTurn.text, 'Inspecting worker status.\n\nRestarting the worker now.');

  // Tool/thinking-only settled turn with zero text blocks remains a single process segment.
  const noTextBlocks = [
    { id: 'th-1', kind: 'thinking', text: 'Internal check' },
    { id: 'tl-1', kind: 'tools', tools: [{ id: 'tc_only', name: 'ls', status: 'done', outcome: 'ok' }] },
  ];
  const noTextSegments = partitionAssistantTurnBlocks(noTextBlocks, { isLive: false });
  assert.equal(noTextSegments.length, 1);
  assert.equal(noTextSegments[0].kind, 'process');
  assert.deepEqual(noTextSegments[0].blocks, noTextBlocks);
});

test('live turn keeps interim text and running tool inside process without premature promotion', () => {
  const turns = parseHistoryEntries(
    [
      userEntry(1, 'Search for process rail references'),
      assistantEntry(2, [
        { type: 'text', text: 'Scanning repository files...' },
        { type: 'toolCall', id: 'tc_live', name: 'grep', arguments: { pattern: 'TurnProcessRail' } },
      ]),
    ],
    0,
    {
      isBusy: true,
      liveTools: [{ callId: 'tc_live', name: 'grep', status: 'running', output: '' }],
    },
  );

  const liveTurn = turns[1];
  assert.equal(liveTurn.blocks?.length, 2);
  assert.equal(liveTurn.blocks[0].kind, 'text');
  assert.equal(liveTurn.blocks[0].interim, true);
  assert.equal(liveTurn.blocks[1].kind, 'tools');
  assert.equal(liveTurn.blocks[1].tools[0].status, 'running');

  const liveSegments = partitionAssistantTurnBlocks(liveTurn.blocks, { isLive: true });
  assert.equal(liveSegments.length, 1);
  assert.equal(liveSegments[0].kind, 'process');
  assert.equal(liveSegments[0].id, `${liveTurn.blocks[0].id}-process`);
  assert.deepEqual(liveSegments[0].blocks, liveTurn.blocks);

  // Contrast: once settled, the same blocks promote the last text block out of the empty shell.
  const settledSegments = partitionAssistantTurnBlocks(liveTurn.blocks, { isLive: false });
  assert.deepEqual(
    settledSegments.map((seg) => seg.kind),
    ['block', 'process'],
  );
  assert.equal(settledSegments[0].block, liveTurn.blocks[0]);

  // Also verify liveGeneratingBlocks projection behaves identically while live.
  const genTurns = parseHistoryEntries([userEntry(10, 'List workspace')], 0, {
    isBusy: true,
    liveGeneratingBlocks: [
      { type: 'text', text: 'Listing workspace...' },
      { type: 'toolCall', callId: 'tc_gen', name: 'ls' },
    ],
    liveTools: [{ callId: 'tc_gen', name: 'ls', status: 'running', output: '' }],
  });
  const genTurn = genTurns[1];
  assert.equal(genTurn.blocks?.length, 2);
  assert.equal(genTurn.blocks[0].kind, 'text');
  assert.equal(genTurn.blocks[0].interim, true);
  const genSegments = partitionAssistantTurnBlocks(genTurn.blocks, { isLive: true });
  assert.equal(genSegments.length, 1);
  assert.equal(genSegments[0].kind, 'process');
  assert.deepEqual(genSegments[0].blocks, genTurn.blocks);
});

test('groupProcessTimelineSteps pairs narration with following blocks and handles leading tools or thinking', () => {
  const thinking0 = { id: 'th-0', kind: 'thinking', text: 'Initial reasoning' };
  const tools0 = {
    id: 'tl-0',
    kind: 'tools',
    tools: [{ id: 'tc_0', name: 'ls', status: 'done', outcome: 'ok' }],
  };
  const text1 = { id: 't-1', kind: 'text', text: 'Reading config.', entryId: '101', interim: true };
  const thinking1 = { id: 'th-1', kind: 'thinking', text: 'Checking keys' };
  const tools1 = {
    id: 'tl-1',
    kind: 'tools',
    tools: [{ id: 'tc_1', name: 'read', status: 'done', outcome: 'ok' }],
  };
  const text2 = { id: 't-2', kind: 'text', text: 'Running tests.', entryId: '102', interim: true };
  const tools2 = {
    id: 'tl-2',
    kind: 'tools',
    tools: [{ id: 'tc_2', name: 'bash', status: 'done', outcome: 'ok' }],
  };

  // Paired narrations with subsequent thinking/tools.
  const pairedSteps = groupProcessTimelineSteps([text1, thinking1, tools1, text2, tools2]);
  assert.equal(pairedSteps.length, 2);
  assert.equal(pairedSteps[0].id, 't-1');
  assert.equal(pairedSteps[0].text, 'Reading config.');
  assert.equal(pairedSteps[0].entryId, '101');
  assert.deepEqual(pairedSteps[0].blocks, [thinking1, tools1]);
  assert.equal(pairedSteps[1].id, 't-2');
  assert.equal(pairedSteps[1].text, 'Running tests.');
  assert.equal(pairedSteps[1].entryId, '102');
  assert.deepEqual(pairedSteps[1].blocks, [tools2]);

  // Leading thinking/tools with no preceding narration create a standalone step before narrated steps.
  const leadingSteps = groupProcessTimelineSteps([thinking0, tools0, text1, tools1]);
  assert.equal(leadingSteps.length, 2);
  assert.equal(leadingSteps[0].id, 'th-0');
  assert.equal(leadingSteps[0].text, undefined);
  assert.equal(leadingSteps[0].entryId, undefined);
  assert.deepEqual(leadingSteps[0].blocks, [thinking0, tools0]);
  assert.equal(leadingSteps[1].id, 't-1');
  assert.equal(leadingSteps[1].text, 'Reading config.');
  assert.equal(leadingSteps[1].entryId, '101');
  assert.deepEqual(leadingSteps[1].blocks, [tools1]);

  // Standalone leading tool with no thinking or narration.
  const toolOnlySteps = groupProcessTimelineSteps([tools0]);
  assert.equal(toolOnlySteps.length, 1);
  assert.equal(toolOnlySteps[0].id, 'tl-0');
  assert.equal(toolOnlySteps[0].text, undefined);
  assert.deepEqual(toolOnlySteps[0].blocks, [tools0]);

  // Consecutive interim text blocks (e.g. after chatTurnsWithoutToolOutput) become separate steps.
  const textOnlySteps = groupProcessTimelineSteps([text1, text2]);
  assert.equal(textOnlySteps.length, 2);
  assert.equal(textOnlySteps[0].id, 't-1');
  assert.equal(textOnlySteps[0].text, 'Reading config.');
  assert.deepEqual(textOnlySteps[0].blocks, []);
  assert.equal(textOnlySteps[1].id, 't-2');
  assert.equal(textOnlySteps[1].text, 'Running tests.');
  assert.deepEqual(textOnlySteps[1].blocks, []);

  assert.deepEqual(groupProcessTimelineSteps([]), []);
});
