/**
 * capture_screenshot: the hidden tab and the wrong pane (issues #3, #4).
 *
 * Both produce a real PNG of the right chart that is evidence of a moment that
 * never happened, which is the worst failure shape this tool has:
 *   #3 a hidden tab returns the last frame Chromium painted for it. The DOM
 *      keeps updating, so the header, quote and clock in the image are current
 *      while the candles are frozen. Three captures 40s apart were byte-similar.
 *   #4 querySelector takes the FIRST match, so on a 2x2 layout every
 *      region:"chart" capture was pane 0 regardless of pane_focus.
 *
 * Run: node --test tests/capture_visibility.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureScreenshot } from '../src/core/capture.js';

const PNG = Buffer.from('fake-png').toString('base64');

function deps({ visibility = 'visible', bounds = null, onCapture, visibleAfterFront = false, frontThrows = null } = {}) {
  const captured = [];
  const fronts = [];
  let current = visibility;
  return {
    captured,
    fronts,
    _deps: {
      wait: async () => {},
      bringToFront: async () => {
        fronts.push(Date.now());
        if (frontThrows) throw new Error(frontThrows);
        if (visibleAfterFront) current = 'visible';
      },
      evaluate: async (js) => {
        if (js === 'document.visibilityState') return current;
        if (js.includes('chart-container')) return bounds;
        return null;
      },
      getClient: async () => ({
        Page: {
          captureScreenshot: async (params) => {
            captured.push(params);
            if (onCapture) onCapture(params);
            return { data: PNG };
          },
        },
      }),
      writeFileSync: () => {},
      waitForChartRender: async () => true,
    },
  };
}

describe('a hidden target is FRONTED, and only then refused (#3)', () => {
  it('brings the window to the front rather than refusing, and captures a live frame', async () => {
    // THE REGRESSION THIS EXISTS TO STOP.
    //
    // Measured on the operator's own machine, 2026-09-08, TradingView open and
    // working, merely sitting behind the terminal:
    //   {"vis":"hidden","hidden":true,"title":"Live stock, index, futures ..."}
    // macOS Chromium marks a fully occluded window hidden. 2.5.0 refused on
    // exactly that, so the ordinary workflow (look at the agent, not the chart)
    // broke nine screenshot-using skills.
    const d = deps({ visibility: 'hidden', visibleAfterFront: true });
    const out = await captureScreenshot({ _deps: d._deps });
    assert.equal(out.success, true);
    assert.equal(out.visibility, 'visible');
    assert.equal(out.brought_to_front, true);
    assert.equal(d.fronts.length, 1, 'it must actually raise the window, not just re-read');
    assert.equal(d.captured.length, 1);
  });

  it('does not touch the window when it is already visible', async () => {
    const d = deps({ visibility: 'visible' });
    const out = await captureScreenshot({ _deps: d._deps });
    assert.deepEqual(d.fronts, [], 'raising the window is a side effect on the desktop; do not do it needlessly');
    assert.equal(out.brought_to_front, undefined);
  });

  it('refuses only when fronting fails to make it visible', async () => {
    // Minimised, or on another Space. At that point a capture really is stale.
    const d = deps({ visibility: 'hidden', visibleAfterFront: false });
    await assert.rejects(
      () => captureScreenshot({ _deps: d._deps }),
      /still hidden after bringing it to the front/,
    );
    assert.deepEqual(d.captured, [], 'a refused capture must not reach CDP at all');
    assert.equal(d.fronts.length, 1, 'it must have tried');
  });

  it('reports why fronting failed rather than swallowing it', async () => {
    const d = deps({ visibility: 'hidden', frontThrows: 'Target closed' });
    await assert.rejects(
      () => captureScreenshot({ _deps: d._deps }),
      (err) => {
        assert.match(err.message, /still hidden after bringing it to the front/);
        assert.equal(err.details.bring_to_front_error, 'Target closed');
        return true;
      },
    );
  });

  it('refuses when visibility cannot be read at all', async () => {
    // Absence of evidence is not evidence of visibility.
    const d = deps();
    d._deps.evaluate = async () => { throw new Error('CDP disconnected'); };
    await assert.rejects(() => captureScreenshot({ _deps: d._deps }), /Could not confirm the target is visible/);
  });

  it('fronts on prerender too, not only on hidden', async () => {
    const d = deps({ visibility: 'prerender', visibleAfterFront: true });
    const out = await captureScreenshot({ _deps: d._deps });
    assert.equal(out.success, true);
    assert.equal(out.brought_to_front, true);
  });

  it('captures when the tab is visible, and records that it checked', async () => {
    // Negative control: without it, a function that always threw would pass above.
    const d = deps({ visibility: 'visible' });
    const out = await captureScreenshot({ _deps: d._deps });
    assert.equal(out.success, true);
    assert.equal(out.visibility, 'visible');
    assert.equal(d.captured.length, 1);
  });

  it('allow_hidden:true captures anyway and says the check was skipped', async () => {
    // An escape hatch that lies about having checked would be worse than none.
    const d = deps({ visibility: 'hidden' });
    const out = await captureScreenshot({ allow_hidden: true, _deps: d._deps });
    assert.equal(out.success, true);
    assert.equal(out.visibility, 'not_checked');
  });
});

describe('region:"chart" targets the active pane (#4)', () => {
  const ACTIVE = { x: 640, y: 0, width: 640, height: 400, how: 'active_pane', pane_count: 4 };

  it('clips to the active pane and says how it found it', async () => {
    const d = deps({ bounds: ACTIVE });
    const out = await captureScreenshot({ region: 'chart', _deps: d._deps });
    assert.deepEqual(d.captured[0].clip, { x: 640, y: 0, width: 640, height: 400, scale: 1 });
    assert.equal(out.pane_selected_by, 'active_pane');
    assert.equal(out.pane_count, 4);
    assert.equal(out.warning, undefined);
  });

  it('warns loudly when it had to fall back to the first of several panes', async () => {
    // This is the old behaviour. It is still the fallback, because a capture is
    // better than no capture - but it must never be silent on a multi-pane
    // layout, which is the only place it is wrong.
    const d = deps({ bounds: { ...ACTIVE, how: 'first_pane_canvas', pane_count: 4 } });
    const out = await captureScreenshot({ region: 'chart', _deps: d._deps });
    assert.match(out.warning, /FIRST of 4 panes/);
    assert.match(out.warning, /may not be the focused one/);
  });

  it('does not warn on a single-pane layout, where first and active are the same', async () => {
    const d = deps({ bounds: { ...ACTIVE, how: 'first_pane_canvas', pane_count: 1 } });
    const out = await captureScreenshot({ region: 'chart', _deps: d._deps });
    assert.equal(out.warning, undefined);
  });

  it('prefers the active selector over the first-match ones', async () => {
    // Executes the real generated page script against a stub DOM, rather than
    // trusting a mock that reimplements the ordering.
    let pageScript = '';
    const d = deps({ bounds: ACTIVE });
    d._deps.evaluate = async (js) => {
      if (js === 'document.visibilityState') return 'visible';
      pageScript = js;
      return ACTIVE;
    };
    await captureScreenshot({ region: 'chart', _deps: d._deps });
    const activeAt = pageScript.indexOf('.chart-container.active');
    const firstAt = pageScript.indexOf('[data-name="pane-canvas"]');
    assert.ok(activeAt > 0 && firstAt > 0, 'both selectors must still be present');
    assert.ok(activeAt < firstAt, 'the active-pane selector must be tried before the first-match ones');
  });

  it('falls back to an unclipped full capture when no pane can be measured', async () => {
    const d = deps({ bounds: null });
    const out = await captureScreenshot({ region: 'chart', _deps: d._deps });
    assert.equal(d.captured[0].clip, undefined);
    assert.equal(out.pane_selected_by, undefined);
  });
});
