import test from 'node:test';
import assert from 'node:assert/strict';
import { getOhlcv } from '../src/core/data.js';

// Builds a fake `evaluate` matching the exact call shapes getHistoricalOhlcvWindow
// issues (same substring-matching style as tests/chart_range.test.js). Each probe
// call consumes the next scripted state; requestMoreData calls are counted and can
// optionally trigger loading a scripted next probe state via the caller's own
// sequencing (the probeStates array itself encodes the effect of each load).
function makeEvaluate({ resolution = '15', probeStates = [], extractedBars = null, moreDataOk = true } = {}) {
  const calls = [];
  const states = [...probeStates];
  let requestMoreDataCalls = 0;
  const evaluate = async (expression) => {
    calls.push(expression);
    if (expression.includes('.resolution()')) return resolution;
    if (expression.includes('eventIdx: eventIdx')) {
      if (states.length === 0) throw new Error('Test bug: ran out of scripted probe states');
      return states.shift();
    }
    if (expression.includes('requestMoreData(1000)')) {
      requestMoreDataCalls += 1;
      return moreDataOk;
    }
    if (expression.includes('return { bars: result };')) {
      return { bars: extractedBars };
    }
    throw new Error(`Unexpected expression in test fake: ${expression}`);
  };
  return { evaluate, calls, requestMoreDataCallCount: () => requestMoreDataCalls };
}

function bar(time, open, high, low, close, volume = 10) {
  return { time, open, high, low, close, volume };
}

const RES15 = 900;

test('1. legacy count/summary path is unchanged by the historical branch', async () => {
  const evaluate = async (expression) => {
    if (expression.includes('bars.lastIndex')) {
      return {
        bars: [bar(100, 1, 2, 0.5, 1.5), bar(200, 1.5, 2.5, 1, 2), bar(300, 2, 3, 1.5, 2.5)],
        total_bars: 3,
        source: 'direct_bars',
      };
    }
    throw new Error(`Unexpected expression: ${expression}`);
  };
  const result = await getOhlcv({ count: 3, _deps: { evaluate } });
  assert.equal(result.success, true);
  assert.equal(result.count, 3);
  assert.equal(result.bars.length, 3);
  assert.equal(result.mode, undefined);
});

test('2. event inside a 15m candle resolves to that candle', async () => {
  // Candle at 1000..1900 (exclusive), event lands mid-bar at 1400.
  const probe = { eventIdx: 5, firstIdx: 0, lastIdx: 10, firstTime: 1000 - 5 * RES15, more: true };
  const window = [];
  for (let i = -2; i <= 2; i++) window.push(bar(1000 + i * RES15, 1, 1.1, 0.9, 1.05));
  const { evaluate } = makeEvaluate({ probeStates: [probe], extractedBars: window });
  const result = await getOhlcv({ event_timestamp: 1400, bars_before: 2, bars_after: 2, _deps: { evaluate } });
  assert.equal(result.success, true);
  assert.equal(result.mode, 'historical_window');
  assert.equal(result.event_bar_time, 1000);
  assert.equal(result.count, 5);
});

test('3. event exactly on a 15m boundary resolves to the new candle', async () => {
  // Event timestamp equals the opening time of the bar at index 5 exactly.
  const probe = { eventIdx: 5, firstIdx: 0, lastIdx: 10, firstTime: 1000 - 5 * RES15, more: true };
  const window = [];
  for (let i = -1; i <= 1; i++) window.push(bar(1000 + i * RES15, 1, 1.1, 0.9, 1.05));
  const { evaluate } = makeEvaluate({ probeStates: [probe], extractedBars: window });
  const result = await getOhlcv({ event_timestamp: 1000, bars_before: 1, bars_after: 1, _deps: { evaluate } });
  assert.equal(result.event_bar_time, 1000);
});

test('4. event in a non-trading gap fails (does not select the previous bar)', async () => {
  // Friday's last bar starts at 1000, effectively ends at min(1000+900, nextBarStart).
  // Next loaded bar (Monday) starts far later, at 100000. The gap timestamp 5000
  // sits after Friday's bar and before Monday's bar, so eventIdx is null, and
  // firstTime (1000) is NOT greater than eventTs (5000) -- not "older than loaded" --
  // so the implementation must fail immediately without further loading.
  const probe = { eventIdx: null, firstIdx: 0, lastIdx: 1, firstTime: 1000, more: true };
  const { evaluate } = makeEvaluate({ probeStates: [probe] });
  await assert.rejects(
    getOhlcv({ event_timestamp: 5000, bars_before: 1, bars_after: 1, _deps: { evaluate } }),
    (err) => err.category === 'chart_loading' && /gap|newer|exhausted/i.test(err.message),
  );
});

test('5. an event older than loaded history triggers requestMoreData(1000)', async () => {
  const firstProbe = { eventIdx: null, firstIdx: 10, lastIdx: 20, firstTime: 5000, more: true };
  const secondProbe = { eventIdx: 12, firstIdx: 5, lastIdx: 20, firstTime: 1000, more: true };
  const window = [bar(2500, 1, 1.1, 0.9, 1.05), bar(3400, 1, 1.1, 0.9, 1.05), bar(4300, 1, 1.1, 0.9, 1.05)];
  const helper = makeEvaluate({ probeStates: [firstProbe, secondProbe], extractedBars: window });
  const result = await getOhlcv({ event_timestamp: 3400, bars_before: 1, bars_after: 1, _deps: { evaluate: helper.evaluate } });
  assert.equal(result.success, true);
  assert.equal(helper.requestMoreDataCallCount(), 1);
  assert.equal(result.history.requests, 1);
});

test('6. historical loading never calls or contains zoomToBarsRange', async () => {
  const probe = { eventIdx: 5, firstIdx: 0, lastIdx: 10, firstTime: 1000 - 5 * RES15, more: true };
  const window = [bar(1000, 1, 1.1, 0.9, 1.05)];
  const helper = makeEvaluate({ probeStates: [probe], extractedBars: window });
  await getOhlcv({ event_timestamp: 1000, bars_before: 0, bars_after: 0, _deps: { evaluate: helper.evaluate } });
  assert.ok(helper.calls.every((expr) => !expr.includes('zoomToBarsRange')));
  assert.ok(helper.calls.every((expr) => !expr.includes('setVisibleRange')));
});

test('7. insufficient pre-event bars fails once history is exhausted', async () => {
  const probe = { eventIdx: 1, firstIdx: 0, lastIdx: 5, firstTime: 1000, more: false };
  const { evaluate } = makeEvaluate({ probeStates: [probe] });
  await assert.rejects(
    getOhlcv({ event_timestamp: 1900, bars_before: 5, bars_after: 1, _deps: { evaluate } }),
    (err) => err.category === 'chart_loading' && /before/i.test(err.message),
  );
});

test('8. insufficient post-event bars fails (event too recent)', async () => {
  const probe = { eventIdx: 8, firstIdx: 0, lastIdx: 8, firstTime: 1000, more: true };
  const { evaluate } = makeEvaluate({ probeStates: [probe] });
  await assert.rejects(
    getOhlcv({ event_timestamp: 8000, bars_before: 1, bars_after: 3, _deps: { evaluate } }),
    (err) => err.category === 'chart_loading' && /after/i.test(err.message),
  );
});

test('9. exactly 500 total bars is accepted by the size gate', async () => {
  const barsBefore = 249;
  const barsAfter = 250;
  const probe = { eventIdx: barsBefore, firstIdx: 0, lastIdx: barsBefore + barsAfter, firstTime: 0, more: true };
  const window = [];
  for (let i = 0; i <= barsBefore + barsAfter; i++) window.push(bar(i * RES15, 1, 1.1, 0.9, 1.05));
  const { evaluate } = makeEvaluate({ probeStates: [probe], extractedBars: window });
  const result = await getOhlcv({ event_timestamp: window[barsBefore].time, bars_before: barsBefore, bars_after: barsAfter, _deps: { evaluate } });
  assert.equal(result.count, 500);
});

test('10. 501 total bars is rejected before any history loading', async () => {
  let evaluateCalled = false;
  const evaluate = async () => { evaluateCalled = true; };
  await assert.rejects(
    getOhlcv({ event_timestamp: 1000, bars_before: 250, bars_after: 250, _deps: { evaluate } }),
    (err) => err.category === 'invalid_argument' && /500/.test(err.message),
  );
  assert.equal(evaluateCalled, false);
});

test('11. malformed OHLC geometry fails', async () => {
  const probe = { eventIdx: 1, firstIdx: 0, lastIdx: 2, firstTime: 1000, more: true };
  // low (5) > high (2) is impossible geometry.
  const window = [bar(1000, 1, 2, 0.5, 1.5), bar(1900, 3, 2, 5, 1), bar(2800, 1, 2, 0.5, 1.5)];
  const { evaluate } = makeEvaluate({ probeStates: [probe], extractedBars: window });
  await assert.rejects(
    getOhlcv({ event_timestamp: 1900, bars_before: 1, bars_after: 1, _deps: { evaluate } }),
    (err) => err.category === 'api_unexpected' && /geometry/i.test(err.message),
  );
});

test('12. non-monotonic timestamps fail', async () => {
  const probe = { eventIdx: 1, firstIdx: 0, lastIdx: 2, firstTime: 1000, more: true };
  const window = [bar(1900, 1, 1.1, 0.9, 1.05), bar(1000, 1, 1.1, 0.9, 1.05), bar(2800, 1, 1.1, 0.9, 1.05)];
  const { evaluate } = makeEvaluate({ probeStates: [probe], extractedBars: window });
  await assert.rejects(
    getOhlcv({ event_timestamp: 1000, bars_before: 1, bars_after: 1, _deps: { evaluate } }),
    (err) => err.category === 'api_unexpected' && /chronological/i.test(err.message),
  );
});

test('13. mixed legacy/historical arguments are rejected without guessing', async () => {
  let evaluateCalled = false;
  const evaluate = async () => { evaluateCalled = true; };
  await assert.rejects(
    getOhlcv({ count: 10, event_timestamp: 1000, bars_before: 1, bars_after: 1, _deps: { evaluate } }),
    (err) => err.category === 'invalid_argument' && /mix/i.test(err.message),
  );
  await assert.rejects(
    getOhlcv({ event_timestamp: 1000, _deps: { evaluate } }),
    (err) => err.category === 'invalid_argument' && /together/i.test(err.message),
  );
  assert.equal(evaluateCalled, false);
});

test('14. history exhaustion without ever finding the event fails cleanly', async () => {
  const p1 = { eventIdx: null, firstIdx: 10, lastIdx: 15, firstTime: 5000, more: true };
  const p2 = { eventIdx: null, firstIdx: 0, lastIdx: 15, firstTime: 4000, more: false };
  const helper = makeEvaluate({ probeStates: [p1, p2] });
  await assert.rejects(
    getOhlcv({ event_timestamp: 100, bars_before: 1, bars_after: 1, _deps: { evaluate: helper.evaluate } }),
    (err) => err.category === 'chart_loading',
  );
  assert.equal(helper.requestMoreDataCallCount(), 1);
});

test('15. legacy internal callers remain compatible with an unrelated _deps bag', async () => {
  // Mirrors batch.js's real call shape: a full deps object with keys that have
  // nothing to do with data.js's own DI surface. The legacy path must ignore
  // _deps entirely rather than strict-validating it and rejecting foreign keys.
  const evaluate = async (expression) => {
    if (expression.includes('bars.lastIndex')) {
      return { bars: [bar(100, 1, 2, 0.5, 1.5)], total_bars: 1, source: 'direct_bars' };
    }
    throw new Error(`Unexpected expression: ${expression}`);
  };
  const batchStyleDeps = {
    evaluate,
    getChartState: async () => ({}),
    setSymbol: async () => ({}),
    setTimeframe: async () => ({}),
    captureScreenshot: async () => ({}),
    sleep: async () => {},
  };
  const result = await getOhlcv({ count: 1, summary: true, _deps: batchStyleDeps });
  assert.equal(result.success, true);
});
