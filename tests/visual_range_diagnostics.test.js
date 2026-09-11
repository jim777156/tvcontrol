import test from 'node:test';
import assert from 'node:assert/strict';
import { getVisibleRange } from '../src/core/visual_range_quality.js';

const BASE_RANGE = {
  visible_range: { from: 100, to: 300 },
  bars_range: { from: 100, to: 300 },
  visual_state: {
    time_scale: { bar_spacing: 12.5, right_offset: 7.25, width: 940 },
    main_price_scale: {
      auto_scale: false,
      visible_price_range: { from: 0.991, to: 1.004 },
    },
  },
};

function validScale() {
  return {
    isAutoScale: () => false,
    getVisiblePriceRange: () => ({ from: -0.0012, to: 0.0008 }),
  };
}

function paneWithScale(scale) {
  return { getMainSourcePriceScale: () => scale };
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

function depsFor(panes) {
  return {
    evaluate: async (expression) => {
      if (expression.includes('scales.push')) {
        return runBrowserExpression(expression, panes);
      }
      if (expression.includes('getVisibleRange')) return BASE_RANGE;
      return { success: true };
    },
  };
}

const CASES = [
  {
    name: 'missing visible range while manual scale',
    scale: {
      isAutoScale: () => false,
      getVisiblePriceRange: () => null,
    },
    expected: 'visible_range_missing',
    expectedAutoScale: false,
  },
  {
    name: 'missing visible range while auto scale',
    scale: {
      isAutoScale: () => true,
      getVisiblePriceRange: () => null,
    },
    expected: 'visible_range_missing',
    expectedAutoScale: true,
  },
  {
    name: 'non-boolean auto-scale state',
    scale: {
      isAutoScale: () => 'auto',
      getVisiblePriceRange: () => ({ from: -1, to: 1 }),
    },
    expected: 'auto_scale_not_boolean',
    expectedAutoScale: null,
  },
  {
    name: 'non-finite lower range',
    scale: {
      isAutoScale: () => false,
      getVisiblePriceRange: () => ({ from: Number.NaN, to: 1 }),
    },
    expected: 'visible_range_from_not_finite',
    expectedAutoScale: null,
  },
  {
    name: 'reversed range',
    scale: {
      isAutoScale: () => false,
      getVisiblePriceRange: () => ({ from: 2, to: 1 }),
    },
    expected: 'visible_range_order_invalid',
    expectedAutoScale: null,
  },
];

test('secondary scale state failures expose only bounded pane/predicate diagnostics', async (t) => {
  for (const diagnosticCase of CASES) {
    await t.test(diagnosticCase.name, async () => {
      const panes = [
        {},
        paneWithScale(validScale()),
        paneWithScale(diagnosticCase.scale),
      ];

      await assert.rejects(
        getVisibleRange({
          include_secondary_price_scales: true,
          _deps: depsFor(panes),
        }),
        (error) => {
          const baseMatch = (
            error.category === 'api_unexpected'
            && error.message.includes('secondary_price_scale_state_invalid')
            && error.message.includes('pane_index=2')
            && error.message.includes(`state_failure=${diagnosticCase.expected}`)
            && !error.message.includes('NaN')
            && !error.message.includes('[object Object]')
          );
          const autoScaleMatch = diagnosticCase.expectedAutoScale === null
            ? !error.message.includes('auto_scale=')
            : error.message.includes(`auto_scale=${diagnosticCase.expectedAutoScale}`);
          return baseMatch && autoScaleMatch;
        },
      );
    });
  }
});

test('secondary scale getter exceptions remain fail-closed with bounded diagnostics', async () => {
  const panes = [
    {},
    paneWithScale({
      isAutoScale: () => false,
      getVisiblePriceRange: () => { throw new Error('raw-sensitive-detail'); },
    }),
  ];

  await assert.rejects(
    getVisibleRange({
      include_secondary_price_scales: true,
      _deps: depsFor(panes),
    }),
    (error) => (
      error.category === 'api_unexpected'
      && error.message.includes('secondary_price_scale_state_invalid')
      && error.message.includes('pane_index=1')
      && error.message.includes('state_failure=visible_range_read_threw')
      && !error.message.includes('auto_scale=')
      && !error.message.includes('raw-sensitive-detail')
    ),
  );
});
