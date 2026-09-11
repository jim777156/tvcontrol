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

function statefulScale({ autoScale = false, from = -0.0012, to = 0.0008 } = {}) {
  const state = { autoScale, from, to };
  return {
    state,
    isAutoScale: () => state.autoScale,
    getVisiblePriceRange: () => ({ from: state.from, to: state.to }),
    setAutoScale: (value) => { state.autoScale = value; },
    setVisiblePriceRange: (range) => {
      state.from = range.from;
      state.to = range.to;
    },
  };
}

function paneWithScale(scale) {
  return { getMainSourcePriceScale: () => scale };
}

function paneWithoutScale() {
  return { getMainSourcePriceScale: () => null };
}

function runBrowserExpression(expression, panes) {
  const fakeWindow = {
    TradingViewApi: {
      _activeChartWidgetWV: {
        value: () => ({ getPanes: () => panes }),
      },
    },
  };
  return Function('window', `return (${expression})`)(fakeWindow);
}

function browserAwareDeps(panes) {
  return {
    sleep: async () => {},
    evaluate: async (expression) => {
      if (
        expression.includes('scales.push')
        || expression.includes('var command = JSON.parse')
      ) {
        return runBrowserExpression(expression, panes);
      }
      if (expression.includes('requestMoreDataAvailable')) {
        return { firstTime: 90, more: false };
      }
      if (expression.includes('getVisibleRange')) return baseRange();
      return { success: true };
    },
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

test('getVisibleRange skips a documented no-scale pane but still captures scalable panes', async () => {
  const macdScale = statefulScale();
  const panes = [
    {},
    paneWithScale(macdScale),
    paneWithoutScale(),
  ];

  const result = await getVisibleRange({
    include_secondary_price_scales: true,
    _deps: browserAwareDeps(panes),
  });

  assert.deepEqual(result.visual_state.secondary_price_scales, [
    { pane_index: 1, auto_scale: false, from: -0.0012, to: 0.0008 },
  ]);
});

test('getVisibleRange still fails closed when a secondary pane API is actually unavailable', async () => {
  const panes = [{}, {}];

  await assert.rejects(
    getVisibleRange({
      include_secondary_price_scales: true,
      _deps: browserAwareDeps(panes),
    }),
    (error) => (
      error.category === 'api_unexpected'
      && error.message.includes('secondary_pane_api_unavailable')
    ),
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

test('setVisibleRange auto-scales scalable panes and skips documented no-scale panes', async () => {
  const macdScale = statefulScale({ autoScale: false });
  const panes = [
    {},
    paneWithScale(macdScale),
    paneWithoutScale(),
  ];

  const result = await setVisibleRange({
    from: 100,
    to: 300,
    bar_spacing: 7.5,
    main_price_auto_scale: false,
    main_price_from: 0.98,
    main_price_to: 1.01,
    secondary_price_auto_scale: true,
    _deps: browserAwareDeps(panes),
  });

  assert.equal(macdScale.state.autoScale, true);
  assert.deepEqual(result.visual_state.secondary_price_scales, [
    { pane_index: 1, auto_scale: true, from: -0.0012, to: 0.0008 },
  ]);
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

test('setVisibleRange restores captured scalable panes without requiring one scale per pane', async () => {
  const macdScale = statefulScale({ autoScale: true, from: -2, to: 2 });
  const panes = [
    {},
    paneWithScale(macdScale),
    paneWithoutScale(),
  ];
  const captured = [
    { pane_index: 1, auto_scale: false, from: -0.0012, to: 0.0008 },
  ];

  const result = await setVisibleRange({
    from: 100,
    to: 300,
    right_offset: 7.25,
    secondary_price_scales: captured,
    _deps: browserAwareDeps(panes),
  });

  assert.equal(macdScale.state.autoScale, false);
  assert.equal(macdScale.state.from, -0.0012);
  assert.equal(macdScale.state.to, 0.0008);
  assert.deepEqual(result.visual_state.secondary_price_scales, captured);
});

test('setVisibleRange restores auto-scale-only pane without a numeric-range setter', async () => {
  const state = { autoScale: false };
  const autoOnlyScale = {
    isAutoScale: () => state.autoScale,
    getVisiblePriceRange: () => null,
    setAutoScale: (value) => { state.autoScale = value; },
  };
  const panes = [
    {},
    paneWithScale(autoOnlyScale),
  ];
  const captured = [
    { pane_index: 1, auto_scale: true, from: null, to: null },
  ];

  const result = await setVisibleRange({
    from: 100,
    to: 300,
    right_offset: 7.25,
    secondary_price_scales: captured,
    _deps: browserAwareDeps(panes),
  });

  assert.equal(state.autoScale, true);
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
