import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPanePriceScales,
  normalizePanePriceScaleRequests,
  preflightPanePriceScales,
} from '../src/tools/pane_scale_governance.js';
import { READONLY_TOOLS } from '../src/core/readonly.js';

function classifiedInvalid(error) {
  return error?.category === 'invalid_argument';
}

test('pane-scale requests are bounded, secondary-only, unique, and structurally complete', () => {
  assert.deepEqual(
    normalizePanePriceScaleRequests([
      { index: 1, auto_scale: true },
      { index: 2, auto_scale: false, from: -2, to: 3 },
    ]),
    [
      { index: 1, auto_scale: true },
      { index: 2, auto_scale: false, from: -2, to: 3 },
    ],
  );

  for (const bad of [
    [],
    [{ index: 0, auto_scale: true }],
    [{ index: 1, auto_scale: true }, { index: 1, auto_scale: true }],
    [{ index: 1, auto_scale: false }],
    [{ index: 1, auto_scale: false, from: 2, to: 1 }],
    [{ index: 1, auto_scale: true, from: 0, to: 1 }],
  ]) {
    assert.throws(() => normalizePanePriceScaleRequests(bad), classifiedInvalid);
  }

  assert.throws(
    () => normalizePanePriceScaleRequests(
      Array.from({ length: 17 }, (_, offset) => ({ index: offset + 1, auto_scale: true })),
    ),
    classifiedInvalid,
  );
});

test('preflight is read-only and checks all requested pane APIs before mutation', async () => {
  const expressions = [];
  const result = await preflightPanePriceScales(
    [
      { index: 1, auto_scale: true },
      { index: 2, auto_scale: false, from: 10, to: 20 },
    ],
    {
      evaluatePage: async (expression) => {
        expressions.push(expression);
        return { success: true, pane_count: 4, requested_count: 2 };
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(expressions.length, 1);
  assert.match(expressions[0], /getMainSourcePriceScale/);
  assert.match(expressions[0], /isAutoScale/);
  assert.match(expressions[0], /getVisiblePriceRange/);
  assert.doesNotMatch(expressions[0], /\.setAutoScale\(/);
  assert.doesNotMatch(expressions[0], /\.setVisiblePriceRange\(/);
});

test('application performs a separate preflight then applies auto and manual secondary scales', async () => {
  const expressions = [];
  const result = await applyPanePriceScales(
    [
      { index: 1, auto_scale: true },
      { index: 2, auto_scale: false, from: 12, to: 81 },
    ],
    {
      evaluatePage: async (expression) => {
        expressions.push(expression);
        if (expressions.length === 1) {
          return { success: true, pane_count: 4, requested_count: 2 };
        }
        return { success: true, requested_count: 2, rollback_complete: true };
      },
    },
  );

  assert.equal(result.success, true);
  assert.equal(expressions.length, 2);
  assert.doesNotMatch(expressions[0], /\.setAutoScale\(/);
  assert.match(expressions[1], /setAutoScale\(true\)/);
  assert.match(expressions[1], /setAutoScale\(false\)/);
  assert.match(expressions[1], /setVisiblePriceRange/);
  assert.match(expressions[1], /rollbackComplete/);
});

test('failed pane application is surfaced as a governed API error after rollback attempt', async () => {
  let call = 0;
  await assert.rejects(
    applyPanePriceScales(
      [{ index: 1, auto_scale: true }],
      {
        evaluatePage: async () => {
          call += 1;
          if (call === 1) return { success: true, pane_count: 4, requested_count: 1 };
          return {
            success: false,
            error: 'pane_price_scale_apply_failed',
            rollback_complete: true,
          };
        },
      },
    ),
    (error) => error?.category === 'api_unexpected'
      && /pane-scale application failed/.test(error.message),
  );
});

test('C1-B2 reuses the existing viewport tool and preserves the 59-tool readonly surface', () => {
  assert.equal(READONLY_TOOLS.length, 59);
  assert.deepEqual(
    READONLY_TOOLS.filter((name) => name.includes('visible_range')).sort(),
    ['chart_get_visible_range', 'chart_set_visible_range'],
  );
});
