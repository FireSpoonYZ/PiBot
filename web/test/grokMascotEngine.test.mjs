import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GROK_POKE_TYPES,
  normalizeGrokBodyShape,
  renderGrokMascotFrameSvg,
  resolveGrokMascotState,
} from '../src/grokMascotEngine.ts';

test('normalizeGrokBodyShape maps aliases and defaults unknown shapes to cloud', () => {
  assert.equal(normalizeGrokBodyShape('cloud'), 'cloud');
  assert.equal(normalizeGrokBodyShape('blob'), 'sphere');
  assert.equal(normalizeGrokBodyShape('unknown-shape'), 'cloud');
  assert.equal(normalizeGrokBodyShape(null), 'cloud');
});

test('resolveGrokMascotState maps busy, tool, streaming, and settlement states', () => {
  assert.equal(resolveGrokMascotState({ isBusy: false }), 'idle');
  assert.equal(resolveGrokMascotState({ isBusy: false, settlementOutcome: 'success' }), 'finished');
  assert.equal(resolveGrokMascotState({ isBusy: false, settlementOutcome: 'error' }), 'failed');
  assert.equal(resolveGrokMascotState({ isBusy: true }), 'working');
  assert.equal(resolveGrokMascotState({ isBusy: true, isStreaming: true }), 'streaming');
  assert.equal(resolveGrokMascotState({ isBusy: true, activeToolName: 'grep' }), 'searching');
  assert.equal(resolveGrokMascotState({ isBusy: true, activeToolName: 'write_file' }), 'writing');
  assert.equal(resolveGrokMascotState({ isBusy: true, activeToolName: 'read_file' }), 'reading');
  assert.equal(resolveGrokMascotState({ isBusy: true, activeToolName: 'bash' }), 'running');
  assert.equal(resolveGrokMascotState({ isBusy: true, activeToolName: 'subagent' }), 'waiting');
  assert.deepEqual([...GROK_POKE_TYPES], ['spin', 'bounce', 'nod']);
});

test('renderGrokMascotFrameSvg renders valid 2.5D cloud SVG across working and morph states', () => {
  for (const state of ['working', 'streaming', 'thinking', 'searching', 'writing', 'finished']) {
    const svg = renderGrokMascotFrameSvg({
      id: `test_${state}`,
      body: 'cloud',
      inkColor: '#2B70F6',
      eyeColor: '#FAF8F5',
      state,
      advanceSeconds: 0.45,
      size: 36,
    });
    assert.ok(svg.startsWith('<svg '), `expected SVG root for state=${state}`);
    assert.ok(svg.includes('fill="#2B70F6"'), `expected ink fill for state=${state}`);
  }
});
