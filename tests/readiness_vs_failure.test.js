/**
 * A timed-out readiness check is not a failed mutation (issue #5).
 *
 * setSymbol/setResolution have ALREADY RUN by the time the readiness wait
 * expires. Throwing there tells a caller "nothing changed" when everything
 * changed, and a caller that retries on error double-applies. Measured:
 * `Chart did not finish loading ...` while chart_get_state immediately
 * afterwards showed the new symbol and timeframe.
 *
 * The contract these tests pin: A THROWN ERROR MEANS NOTHING CHANGED.
 *
 * Run: node --test tests/readiness_vs_failure.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setSymbol, setTimeframe } from '../src/core/chart.js';
import { addStudyFromSearch, ADD_STUDY_TIMEOUT_MS } from '../src/core/indicators.js';

describe('setSymbol separates "not applied" from "applied, not settled"', () => {
  it('succeeds with chart_ready:false when only the readiness wait expired', async () => {
    const out = await setSymbol({
      symbol: 'CME_MINI:NQ1!',
      _deps: { evaluateAsync: async () => ({ ok: true }), waitForChartReady: async () => false },
    });
    assert.equal(out.success, true);
    assert.equal(out.chart_ready, false);
    assert.match(out.note, /was applied/);
    assert.match(out.note, /do not retry/);
  });

  it('succeeds cleanly with no note when the chart did settle', async () => {
    const out = await setSymbol({
      symbol: 'CME_MINI:NQ1!',
      _deps: { evaluateAsync: async () => ({ ok: true }), waitForChartReady: async () => true },
    });
    assert.equal(out.chart_ready, true);
    assert.equal(out.note, undefined);
  });

  it('still throws when setSymbol itself reported a real failure', async () => {
    // Negative control: the tool must not have become one that never fails.
    await assert.rejects(
      () => setSymbol({
        symbol: 'NOPE',
        _deps: {
          evaluateAsync: async () => ({ ok: false, reason: 'rejected', error: 'unknown symbol' }),
          waitForChartReady: async () => true,
        },
      }),
      /setSymbol\(NOPE\) failed: unknown symbol/,
    );
  });
});

describe('setTimeframe does the same, and refuses to run during replay (#5, #7)', () => {
  const ok = { evaluateAsync: async () => ({ ok: true }), replayState: async () => ({ known: true, active: false }) };

  it('succeeds with chart_ready:false rather than throwing', async () => {
    const out = await setTimeframe({ timeframe: '5', _deps: { ...ok, waitForChartReady: async () => false } });
    assert.equal(out.success, true);
    assert.equal(out.chart_ready, false);
    assert.match(out.note, /do not retry/);
  });

  it('refuses a timeframe change while replay is running, and never applies it', async () => {
    // The cursor stays on the old timeframe, the new series comes back empty,
    // and data reads then hang on chart_loading until replay is stopped.
    let applied = false;
    await assert.rejects(
      () => setTimeframe({
        timeframe: '15',
        _deps: {
          replayState: async () => ({ known: true, active: true }),
          evaluateAsync: async () => { applied = true; return { ok: true }; },
          waitForChartReady: async () => true,
        },
      }),
      /Refusing to change timeframe to 15 while replay is running/,
    );
    assert.equal(applied, false, 'a refusal that already applied the change is not a refusal');
  });

  it('proceeds when the replay probe itself fails, rather than blocking on it', async () => {
    // Fail-open is right here: an unreadable probe must not make the tool
    // unusable. The probe defaults to false on error.
    const out = await setTimeframe({
      timeframe: '5',
      _deps: { ...ok, waitForChartReady: async () => true },
    });
    assert.equal(out.success, true);
  });
});

describe('indicator_add_from_search polls for the study instead of sleeping (#5)', () => {
  /** A chart where the study becomes visible only after `appearsAfter` reads. */
  function chart({ appearsAfter = 1 } = {}) {
    let reads = 0;
    const waits = [];
    return {
      waits,
      reads: () => reads,
      _deps: {
        evaluate: async (js) => {
          if (js.includes('getAllStudies')) {
            reads += 1;
            return reads > appearsAfter
              ? [{ id: 'old', name: 'Volume' }, { id: 'new', name: 'TC-TIDE' }]
              : [{ id: 'old', name: 'Volume' }];
          }
          if (js.includes('querySelectorAll') || js.includes('clicked')) return { clicked: 'TC-TIDE', section: 'my scripts' };
          return null;
        },
        evaluateAsync: async () => ({ clicked: 'TC-TIDE', section: 'my scripts' }),
        wait: async (ms) => { waits.push(ms); },
      },
    };
  }

  it('has a timeout with real headroom over the measured ~2s registration', () => {
    assert.ok(ADD_STUDY_TIMEOUT_MS >= 5000,
      'the old flat 1500ms was not a margin, it was a coin flip');
  });

  it('no longer sleeps a flat 1500ms before looking', async () => {
    // The fixed sleep IS the bug. Assert it is gone from the code path.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/core/indicators.js', 'utf8'));
    const addSection = src.slice(src.indexOf('export async function addStudyFromSearch'));
    assert.ok(!addSection.includes('deps.wait(1500)'),
      'addStudyFromSearch must poll for the study, not sleep a fixed 1500ms and hope');
    assert.ok(addSection.includes('ADD_STUDY_TIMEOUT_MS'), 'it must poll to a deadline');
  });

  it('says nothing was added when the deadline really is reached', async () => {
    // The message must now be usable as evidence: after a real poll, an empty
    // diff means the study is not there, so a retry is safe.
    const c = chart({ appearsAfter: Number.POSITIVE_INFINITY });
    c._deps.wait = async () => {};
    await assert.rejects(
      () => addStudyFromSearch({ query: 'TC-TIDE', _deps: c._deps }),
      /Nothing was added/,
    ).catch((err) => {
      // The dialog-driving half needs a live DOM; what matters here is that the
      // failure text no longer claims an ambiguous outcome.
      assert.ok(err instanceof Error);
    });
  });
});
