import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleRange, setVisibleRange } from '../src/core/chart.js';
import { READONLY_TOOLS } from '../src/core/readonly.js';

const VISUAL_STATE = {
  time_scale: { bar_spacing: 12.5, right_offset: 7.25, width: 940 },
  main_price_scale: {
    auto_scale: false,
    visible_price_range: { from: 0.991, to: 1.004 },
  },
};

function rangeResponse(from = 100, to = 300, visualState = VISUAL_STATE) {
  return {
    visible_range: { from, to },
    bars_range: { from, to },
    visual_state: visualState,
  };
}

test('setVisibleRange requests older bars until the requested start is loaded', async () => {
  const states = [
    { firstTime: 200, more: true },
    { firstTime: 150, more: true },
    { firstTime: 90, more: true },
  ];
  let requests = 0;
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        if (expression.includes('requestMoreDataAvailable')) return states.shift();
        if (expression.includes('requestMoreData(1000)')) { requests += 1; return true; }
        if (expression.includes('zoomToBarsRange')) return undefined;
        if (expression.includes('getVisibleRange')) return rangeResponse();
        throw new Error(`Unexpected expression: ${expression}`);
      },
    },
  });

  assert.equal(requests, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(result.history, {
    requests: 2,
    earliest_loaded: 90,
    reached_from: true,
    exhausted: false,
  });
});

test('setVisibleRange reports a partial range honestly when history is exhausted', async () => {
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        if (expression.includes('requestMoreDataAvailable')) return { firstTime: 200, more: false };
        if (expression.includes('zoomToBarsRange')) return undefined;
        if (expression.includes('getVisibleRange')) return rangeResponse(200, 300);
        throw new Error(`Unexpected expression: ${expression}`);
      },
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.complete, false);
  assert.equal(result.history.exhausted, true);
  assert.match(result.note, /could not load the entire requested range/i);
});

test('setVisibleRange rejects inverted ranges', async () => {
  await assert.rejects(
    setVisibleRange({ from: 300, to: 100, _deps: { evaluate: async () => {} } }),
    (error) => error.category === 'invalid_argument',
  );
});

test('getVisibleRange preserves legacy fields and projects the bounded visual state', async () => {
  const result = await getVisibleRange({
    _deps: { evaluate: async () => rangeResponse(10, 20) },
  });

  assert.deepEqual(result.visible_range, { from: 10, to: 20 });
  assert.deepEqual(result.bars_range, { from: 10, to: 20 });
  assert.deepEqual(result.visual_state, VISUAL_STATE);
});

test('setVisibleRange applies optional bar spacing and right offset', async () => {
  const calls = [];
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    bar_spacing: 14.5,
    right_offset: 3.25,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        calls.push(expression);
        if (expression.includes('requestMoreDataAvailable')) return { firstTime: 90, more: false };
        if (expression.includes('setBarSpacing') || expression.includes('setRightOffset')) return { success: true };
        if (expression.includes('getVisibleRange')) return rangeResponse();
        return undefined;
      },
    },
  });

  assert.equal(result.success, true);
  assert.ok(calls.some((expression) => expression.includes('setBarSpacing(14.5)')));
  assert.ok(calls.some((expression) => expression.includes('setRightOffset(3.25)')));
});

test('setVisibleRange applies auto-scale without forcing a manual price range', async () => {
  const calls = [];
  await setVisibleRange({
    from: 100,
    to: 300,
    main_price_auto_scale: true,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        calls.push(expression);
        if (expression.includes('requestMoreDataAvailable')) return { firstTime: 90, more: false };
        if (expression.includes('setAutoScale')) return { success: true };
        if (expression.includes('getVisibleRange')) return rangeResponse();
        return undefined;
      },
    },
  });

  const visualApply = calls.find((expression) => expression.includes('setAutoScale(true)'));
  assert.ok(visualApply);
  assert.ok(!visualApply.includes('setVisiblePriceRange'));
});

test('setVisibleRange applies a manual price range and disables auto-scale', async () => {
  const calls = [];
  await setVisibleRange({
    from: 100,
    to: 300,
    main_price_from: 10,
    main_price_to: 20,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        calls.push(expression);
        if (expression.includes('requestMoreDataAvailable')) return { firstTime: 90, more: false };
        if (expression.includes('setVisiblePriceRange')) return { success: true };
        if (expression.includes('getVisibleRange')) return rangeResponse();
        return undefined;
      },
    },
  });

  const visualApply = calls.find((expression) => expression.includes('setVisiblePriceRange'));
  assert.ok(visualApply);
  assert.ok(visualApply.includes('setAutoScale(false)'));
  assert.ok(visualApply.includes('from: 10'));
  assert.ok(visualApply.includes('to: 20'));
});

test('setVisibleRange rejects malformed partial and invalid visual inputs', async () => {
  const deps = { evaluate: async () => {}, sleep: async () => {} };
  await assert.rejects(
    setVisibleRange({ from: 100, to: 300, main_price_from: 10, _deps: deps }),
    (error) => error.category === 'invalid_argument',
  );
  await assert.rejects(
    setVisibleRange({ from: 100, to: 300, bar_spacing: 0, _deps: deps }),
    (error) => error.category === 'invalid_argument',
  );
  await assert.rejects(
    setVisibleRange({ from: 100, to: 300, main_price_auto_scale: true, main_price_from: 10, main_price_to: 20, _deps: deps }),
    (error) => error.category === 'invalid_argument',
  );
});

test('the read-only child surface remains exactly 59 tools with no new viewport tool', () => {
  assert.equal(READONLY_TOOLS.length, 59);
  assert.deepEqual(
    READONLY_TOOLS.filter((name) => name.includes('visible_range')).sort(),
    ['chart_get_visible_range', 'chart_set_visible_range'],
  );
});
