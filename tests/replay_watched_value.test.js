import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setTimeframe } from '../src/core/chart.js';

// `expect` is one of: 'blocked' (replay really is running), 'allowed' (it is
// not), or 'unknown' (the state could not be read).
//
// 'unknown' was folded into 'blocked' in 2.5.1, which was safe but not honest:
// the refusal asserted "replay is running" about a state nobody had read, so a
// future rename of .value() would have reproduced the original 2.5.0 symptom
// with a misleading message attached. Guarded is still the right OUTCOME. It is
// now a separate ANSWER.
for (const [name, state, expect] of [
  ['plain inactive', false, 'allowed'],
  ['plain active', true, 'blocked'],
  ['watched inactive', { current: false, value() { return this.current; } }, 'allowed'],
  ['watched active', { current: true, value() { return this.current; } }, 'blocked'],
  ['getter-style inactive', { get() { return false; } }, 'allowed'],
  ['getter-style active', { get() { return true; } }, 'blocked'],
  ['plain value property, inactive', { value: false }, 'allowed'],
  ['plain value property, active', { value: true }, 'blocked'],
  ['null is not a replay session', null, 'allowed'],
  ['undefined is not a replay session', undefined, 'allowed'],
  ['unknown object is guarded AND reported as unknown', {}, 'unknown'],
  ['unknown primitive is guarded AND reported as unknown', 42, 'unknown'],
]) {
  test(`timeframe replay guard: ${name}`, async () => {
    let mutations = 0;
    const _deps = {
      getReplayApi: async () => 'replay',
      evaluate: async (code) => vm.runInNewContext(code, { replay: { isReplayStarted: () => state } }),
      evaluateAsync: async () => { mutations++; return { ok: true }; },
      waitForChartReady: async () => true,
    };
    if (expect === 'blocked') {
      await assert.rejects(setTimeframe({ timeframe: '1D', _deps }), /while replay is running/);
      assert.equal(mutations, 0);
    } else if (expect === 'unknown') {
      await assert.rejects(
        setTimeframe({ timeframe: '1D', _deps }),
        (err) => {
          assert.match(err.message, /Could not determine whether replay is running/);
          // The point of the split: it must NOT claim replay is running.
          assert.doesNotMatch(err.message, /while replay is running/);
          assert.match(err.message, /may or may not be active/);
          return true;
        },
      );
      assert.equal(mutations, 0, 'an unreadable state must still block the change');
    } else {
      const result = await setTimeframe({ timeframe: '1D', _deps });
      assert.equal(result.success, true);
      assert.equal(mutations, 1);
    }
  });
}

test('a probe that throws is not the same as an unrecognised shape', async () => {
  // No TradingView to connect to means there is no replay session to protect,
  // so this proceeds. An unrecognised RESPONSE means something is there and we
  // cannot read it, which does not.
  let mutations = 0;
  const result = await setTimeframe({
    timeframe: '1D',
    _deps: {
      getReplayApi: async () => { throw new Error('CDP disconnected'); },
      evaluate: async () => { throw new Error('should not be reached'); },
      evaluateAsync: async () => { mutations++; return { ok: true }; },
      waitForChartReady: async () => true,
    },
  });
  assert.equal(result.success, true);
  assert.equal(mutations, 1);
});

test('a page-side exception reads as inactive, not as unknown', async () => {
  // isReplayStarted() throwing is TradingView telling us there is no replay
  // controller. That is a real answer.
  const result = await setTimeframe({
    timeframe: '1D',
    _deps: {
      getReplayApi: async () => 'replay',
      evaluate: async (code) => vm.runInNewContext(code, {
        replay: { isReplayStarted: () => { throw new Error('no replay controller'); } },
      }),
      evaluateAsync: async () => ({ ok: true }),
      waitForChartReady: async () => true,
    },
  });
  assert.equal(result.success, true);
});
