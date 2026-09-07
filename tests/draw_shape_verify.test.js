/**
 * draw_shape: an unknown name became a flag and reported success (issue #8).
 *
 * Measured: `draw_shape --type not_a_real_shape` returned
 * {success: true, shape: "not_a_real_shape", entity_id: "5wpj58"} and
 * draw_get_properties on that id said name: "flag". TradingView falls back to a
 * default for a name it does not recognise, and the result echoed the name that
 * was ASKED FOR rather than the one that was created - the response built from
 * the request instead of from a read.
 *
 * Run: node --test tests/draw_shape_verify.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawShape, _shapeNameMatches } from '../src/core/drawing.js';

const POINT = { time: 1700000000, price: 100 };

/**
 * A stub chart that behaves the way TradingView does: it accepts any shape
 * string and creates something, naming it `fallback` when the name is unknown.
 */
function chart({ known = ['rectangle', 'trend_line'], fallback = 'flag', removable = true } = {}) {
  const shapes = [{ id: 'pre1', name: 'rectangle' }];
  const calls = [];
  return {
    shapes,
    calls,
    _deps: {
      getChartApi: async () => 'API',
      evaluate: async (js) => {
        if (js.includes('getAllShapes')) {
          return js.includes('s.name')
            ? shapes.map((s) => ({ id: s.id, name: s.name }))
            : shapes.map((s) => s.id);
        }
        if (js.includes('createShape') || js.includes('createMultipointShape')) {
          const requested = /shape: "([^"]*)"/.exec(js)?.[1];
          calls.push({ create: requested });
          shapes.push({ id: 'new1', name: known.includes(requested) ? requested : fallback });
          return null;
        }
        if (js.includes('removeEntity')) {
          const id = /removeEntity\("([^"]*)"\)/.exec(js)?.[1];
          calls.push({ remove: id });
          if (removable) {
            const at = shapes.findIndex((s) => s.id === id);
            if (at >= 0) shapes.splice(at, 1);
          }
          return null;
        }
        return null;
      },
    },
  };
}

describe('draw_shape verifies what was created, not what was asked for', () => {
  it('returns the created name alongside the requested one', async () => {
    const c = chart();
    const out = await drawShape({ shape: 'rectangle', point: POINT, point2: { time: 1700003600, price: 110 }, _deps: c._deps });
    assert.equal(out.success, true);
    assert.equal(out.entity_id, 'new1');
    assert.equal(out.shape_created, 'rectangle');
    assert.equal(out.shape_verified, true);
  });

  it('REFUSES an unknown shape name instead of reporting the flag as a success', async () => {
    const c = chart();
    await assert.rejects(
      () => drawShape({ shape: 'not_a_real_shape', point: POINT, _deps: c._deps }),
      (err) => {
        assert.match(err.message, /not a shape TradingView recognises/);
        assert.match(err.message, /fell back to "flag"/);
        return true;
      },
    );
  });

  it('removes the wrong drawing it caused, and says so', async () => {
    const c = chart();
    await assert.rejects(() => drawShape({ shape: 'not_a_real_shape', point: POINT, _deps: c._deps }));
    assert.deepEqual(c.calls.map((k) => k.remove).filter(Boolean), ['new1']);
    assert.deepEqual(c.shapes.map((s) => s.id), ['pre1'], 'the fallback drawing must not be left on the chart');
  });

  it('says the drawing is still there when the cleanup could not remove it', async () => {
    // Claiming a cleanup that did not happen is the same silent success in
    // miniature. The operator needs to know a stray flag is on their chart.
    const c = chart({ removable: false });
    await assert.rejects(
      () => drawShape({ shape: 'not_a_real_shape', point: POINT, _deps: c._deps }),
      /STILL ON THE CHART as new1/,
    );
  });

  it('never removes a drawing it did not create', async () => {
    // Setup-verified cleanup: the removal is reached only via a verified id.
    const c = chart();
    await assert.rejects(() => drawShape({ shape: 'not_a_real_shape', point: POINT, _deps: c._deps }));
    assert.ok(c.shapes.some((s) => s.id === 'pre1'), 'the pre-existing drawing must survive');
  });

  it('throws when nothing new appeared at all', async () => {
    const c = chart();
    c._deps.evaluate = async (js) => (js.includes('getAllShapes')
      ? [{ id: 'pre1', name: 'rectangle' }]
      : null);
    await assert.rejects(
      () => drawShape({ shape: 'rectangle', point: POINT, _deps: c._deps }),
      /no new drawing appeared/,
    );
  });

  it('accepts TradingView\'s own spelling of a name it does recognise', async () => {
    // horizontal_line comes back as horzline on 3.3.0. Reporting that as a
    // fallback would break the most common call in the tool.
    const c = chart({ known: [], fallback: 'horzline' });
    const out = await drawShape({ shape: 'horizontal_line', point: POINT, _deps: c._deps });
    assert.equal(out.success, true);
    assert.equal(out.shape_created, 'horzline');
  });

  it('reports shape_verified:false rather than passing when the name is unreadable', async () => {
    const c = chart({ known: [], fallback: null });
    const out = await drawShape({ shape: 'rectangle', point: POINT, _deps: c._deps });
    assert.equal(out.success, true);
    assert.equal(out.shape_verified, false);
  });
});

describe('_shapeNameMatches', () => {
  it('matches TradingView spellings without matching different shapes', () => {
    assert.equal(_shapeNameMatches('horizontal_line', 'horzline'), true);
    assert.equal(_shapeNameMatches('vertical_line', 'vertline'), true);
    assert.equal(_shapeNameMatches('long_position', 'riskrewardlong'), true);
    assert.equal(_shapeNameMatches('rectangle', 'rectangle'), true);
    assert.equal(_shapeNameMatches('rectangle', 'flag'), false);
    assert.equal(_shapeNameMatches('not_a_real_shape', 'flag'), false);
    assert.equal(_shapeNameMatches('trend_line', 'flag'), false);
    assert.equal(_shapeNameMatches('long_position', 'shortposition'), false);
    assert.equal(_shapeNameMatches('rectangle', ''), false);
  });
});
