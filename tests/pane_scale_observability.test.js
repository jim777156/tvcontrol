import test from 'node:test';
import assert from 'node:assert/strict';

import { readPanePriceScales } from '../src/tools/chart.js';
import { READONLY_TOOLS } from '../src/core/readonly.js';

const THREE_PANE_STATE = {
  pane_count: 3,
  panes: [
    {
      index: 0,
      source_name: 'Euro / U.S. Dollar',
      available: true,
      auto_scale: false,
      visible_price_range: { from: 1.157, to: 1.166 },
    },
    {
      index: 1,
      source_name: 'MACD',
      available: true,
      auto_scale: true,
      visible_price_range: { from: -0.0008, to: 0.0005 },
    },
    {
      index: 2,
      source_name: 'Relative Strength Index',
      available: true,
      auto_scale: true,
      visible_price_range: { from: 20, to: 80 },
    },
  ],
};

test('readPanePriceScales projects every readable pane scale without mutation', async () => {
  let expression = '';
  const result = await readPanePriceScales({
    evaluatePage: async (value) => {
      expression = value;
      return THREE_PANE_STATE;
    },
  });

  assert.deepEqual(result, {
    pane_count: 3,
    readable_count: 3,
    complete: true,
    panes: THREE_PANE_STATE.panes,
  });

  assert.match(expression, /getPanes/);
  assert.match(expression, /getMainSourcePriceScale/);
  assert.match(expression, /isAutoScale/);
  assert.match(expression, /getVisiblePriceRange/);
  assert.doesNotMatch(expression, /setAutoScale/);
  assert.doesNotMatch(expression, /setVisiblePriceRange/);
  assert.doesNotMatch(expression, /setBarSpacing/);
  assert.doesNotMatch(expression, /setRightOffset/);
});

test('readPanePriceScales reports an unreadable indicator pane without failing the whole read', async () => {
  const result = await readPanePriceScales({
    evaluatePage: async () => ({
      pane_count: 3,
      panes: [
        THREE_PANE_STATE.panes[0],
        {
          index: 1,
          source_name: 'MACD',
          available: false,
          auto_scale: null,
          visible_price_range: null,
          error: 'pane_price_scale_api_unavailable',
        },
        THREE_PANE_STATE.panes[2],
      ],
    }),
  });

  assert.equal(result.pane_count, 3);
  assert.equal(result.readable_count, 2);
  assert.equal(result.complete, false);
  assert.deepEqual(result.panes[1], {
    index: 1,
    source_name: 'MACD',
    available: false,
    auto_scale: null,
    visible_price_range: null,
    error: 'pane_price_scale_api_unavailable',
  });
});

test('readPanePriceScales fails soft on an invalid or unavailable browser observation', async () => {
  const malformed = await readPanePriceScales({
    evaluatePage: async () => ({ pane_count: 2, panes: [{ index: 0 }] }),
  });
  assert.deepEqual(malformed, {
    pane_count: null,
    readable_count: 0,
    complete: false,
    panes: [],
    error: 'invalid_pane_scale_observability_payload',
  });

  const unavailable = await readPanePriceScales({
    evaluatePage: async () => { throw new Error('browser unavailable'); },
  });
  assert.deepEqual(unavailable, {
    pane_count: null,
    readable_count: 0,
    complete: false,
    panes: [],
    error: 'pane_price_scale_read_failed',
  });
});

test('C1-B1 does not add a child tool to the commissioned read-only surface', () => {
  assert.equal(READONLY_TOOLS.length, 59);
  assert.equal(READONLY_TOOLS.filter((name) => name === 'chart_get_visible_range').length, 1);
});
