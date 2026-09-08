import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setTimeframe } from '../src/core/chart.js';

for (const [name, state, active] of [
  ['plain inactive', false, false],
  ['plain active', true, true],
  ['watched inactive', { current: false, value() { return this.current; } }, false],
  ['watched active', { current: true, value() { return this.current; } }, true],
  ['unknown object remains guarded', {}, true],
]) {
  test(`timeframe replay guard: ${name}`, async () => {
    let mutations = 0;
    const _deps = {
      getReplayApi: async () => 'replay',
      evaluate: async (code) => vm.runInNewContext(code, { replay: { isReplayStarted: () => state } }),
      evaluateAsync: async () => { mutations++; return { ok: true }; },
      waitForChartReady: async () => true,
    };
    if (active) {
      await assert.rejects(setTimeframe({ timeframe: '1D', _deps }), /while replay is running/);
      assert.equal(mutations, 0);
    } else {
      const result = await setTimeframe({ timeframe: '1D', _deps });
      assert.equal(result.success, true);
      assert.equal(mutations, 1);
    }
  });
}
