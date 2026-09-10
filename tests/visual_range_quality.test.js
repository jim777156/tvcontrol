import test from 'node:test';
import assert from 'node:assert/strict';
import * as chart from '../src/core/chart.js';
import { getVisibleRange, setVisibleRange } from '../src/core/visual_range_quality.js';

const BASE_VISUAL_STATE = {
  time_scale: { bar_spacing: 12.5, right_offset: 7.25, width: 940 },
  main_price_scale: {
    auto_scale: false,
    visible_price_range: { from: 0.991, to: 1.004 },
  },
};

function baseRange() {
  return {
    visible_range: { from: 100, to: 300 },
    bars_range: { from: 100, to: 300 },
    visual_state: BASE_VISUAL_STATE,
  };
}

function secondaryScales(autoScale = false) {
  return {
    success: true,
    pane_count: 3,
    scales: [
      { pane_index: 1, auto_scale: autoScale, from: -0.0012, to: 0.0008 },
      { pane_index: 2, auto_scale: autoScale, from: 18, to: 72 },
    ],
  };
}

test('getVisibleRange preserves base behavior unless secondary state is requested', async () => {
  let secondaryReadAttempted = false;
  const deps = {
    evaluate: async (expression) => {
      if (expression.includes('scales.push')) secondaryReadAttempted = true;
      return baseRange();
    },
  };

  const expected = await chart.getVisibleRange({ _deps: deps });
  const result = await getVisibleRange({ _deps: deps });

  assert.equal(secondaryReadAttempted, false);
  assert.deepEqual(result, expected);
});

test('getVisibleRange appends bounded secondary pane scale state when explicitly requested', async () => {
  const result = await getVisibleRange({
    include_secondary_price_scales: true,
    _deps: {
      evaluate: async (expression) => {
        if (expression.includes('scales.push')) return secondaryScales(false);
        return baseRange();
      },
    },
  });

  assert.deepEqual(result.visible_range, { from: 100, to: 300 });
  assert.deepEqual(
    result.visual_state.secondary_price_scales,
    secondaryScales(false).scales,
  );
});

test('setVisibleRange preserves base behavior when no secondary command is supplied', async () => {
  let secondaryReadAttempted = false;
  const deps = {
    sleep: async () => {},
    evaluate: async (expression) => {
      if (expression.includes('requestMoreDataAvailable')) {
        return { firstTime: 90, more: false };
      }
      if (expression.includes('scales.push')) secondaryReadAttempted = true;
      if (expression.includes('getVisibleRange')) return baseRange();
      return { success: true };
    },
  };
  const args = {
    from: 100,
    to: 300,
    right_offset: 7.25,
    _deps: deps,
  };

  const expected = await chart.setVisibleRange(args);
  const result = await setVisibleRange(args);

  assert.equal(secondaryReadAttempted, false);
  assert.deepEqual(result, expected);
});

test('setVisibleRange temporarily auto-scales every secondary study pane', async () => {
  const calls = [];
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    bar_spacing: 7.5,
    main_price_auto_scale: false,
    main_price_from: 0.98,
    main_price_to: 1.01,
    secondary_price_auto_scale: true,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        calls.push(expression);
        if (expression.includes('requestMoreDataAvailable')) {
          return { firstTime: 90, more: false };
        }
        if (expression.includes('var command = JSON.parse')) {
          return { success: true, applied: 2 };
        }
        if (expression.includes('scales.push')) return secondaryScales(true);
        if (expression.includes('getVisibleRange')) return baseRange();
        return { success: true };
      },
    },
  });

  assert.ok(calls.some((expression) => expression.includes('var command = JSON.parse')));
  assert.equal(result.visual_state.secondary_price_scales.length, 2);
  assert.ok(result.visual_state.secondary_price_scales.every((scale) => scale.auto_scale));
});

test('setVisibleRange restores captured secondary pane scale modes and ranges', async () => {
  const captured = secondaryScales(false).scales;
  const calls = [];
  const result = await setVisibleRange({
    from: 100,
    to: 300,
    right_offset: 7.25,
    secondary_price_scales: captured,
    _deps: {
      sleep: async () => {},
      evaluate: async (expression) => {
        calls.push(expression);
        if (expression.includes('requestMoreDataAvailable')) {
          return { firstTime: 90, more: false };
        }
        if (expression.includes('var command = JSON.parse')) {
          return { success: true, applied: 2 };
        }
        if (expression.includes('scales.push')) return secondaryScales(false);
        if (expression.includes('getVisibleRange')) return baseRange();
        return { success: true };
      },
    },
  });

  const applyCall = calls.find((expression) => expression.includes('var command = JSON.parse'));
  assert.ok(applyCall);
  assert.match(applyCall, /restore/);
  assert.deepEqual(result.visual_state.secondary_price_scales, captured);
});

test('setVisibleRange rejects conflicting secondary pane scale commands', async () => {
  await assert.rejects(
    setVisibleRange({
      from: 100,
      to: 300,
      secondary_price_auto_scale: true,
      secondary_price_scales: secondaryScales(false).scales,
      _deps: { evaluate: async () => {}, sleep: async () => {} },
    }),
    (error) => error.category === 'invalid_argument',
  );
});
