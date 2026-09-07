/**
 * replay_start silently relocated an out-of-range date (issue #7).
 *
 * Measured on CME_MINI:NQ1! at 5m: a request for 2020-12-08 put the cursor on
 * 2021-08-22 and returned {success: true, date: "2020-12-08"}. `date` echoed the
 * REQUEST and `current_date` held the truth in a different unit, with nothing
 * saying they disagreed. TradingView shows a "data point unavailable" toast that
 * the API never surfaces.
 *
 * Every read taken afterwards is then correct for a date the caller never asked
 * for. For point-in-time work that is the one failure that invalidates the whole
 * result, and it was reported as success.
 *
 * Run: node --test tests/replay_relocation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { start, _relocation, RELOCATION_TOLERANCE_DAYS } from '../src/core/replay.js';

const secs = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function replay({ landsOn = '2020-12-08T14:35:00Z' } = {}) {
  const calls = [];
  return {
    calls,
    _deps: {
      getReplayApi: async () => 'RP',
      evaluate: async (js) => {
        calls.push(js);
        if (js.includes('isReplayAvailable')) return true;
        if (js.includes('isReplayStarted')) return true;
        if (js.includes('currentDate')) return secs(landsOn);
        return null;
      },
    },
  };
}

describe('_relocation compares calendar days, not raw numbers', () => {
  it('does not call a same-day landing a relocation', () => {
    // currentDate is SECONDS and the request is a midnight date. Comparing them
    // raw would report every single call as relocated.
    const r = _relocation('2020-12-08', secs('2020-12-08T14:35:00Z'));
    assert.equal(r.relocated, false);
    assert.equal(r.days, 0);
  });

  it('measures the real gap in the incident', () => {
    const r = _relocation('2020-12-08', secs('2021-08-22T20:55:00Z'));
    assert.equal(r.relocated, true);
    assert.equal(r.days, 257);
    assert.equal(r.requested_date, '2020-12-08');
    assert.match(r.current_date, /^2021-08-22T/);
  });

  it('reports no relocation when no date was requested', () => {
    const r = _relocation(undefined, secs('2021-08-22T20:55:00Z'));
    assert.equal(r.relocated, false);
  });

  it('reports no relocation when the cursor cannot be read', () => {
    assert.equal(_relocation('2020-12-08', null).relocated, false);
    assert.equal(_relocation('2020-12-08', undefined).relocated, false);
  });
});

describe('replay_start refuses a cursor that landed somewhere else (#7)', () => {
  it('throws, names both dates, and stops replay', async () => {
    const r = replay({ landsOn: '2021-08-22T20:55:00Z' });
    await assert.rejects(
      () => start({ date: '2020-12-08', _deps: r._deps }),
      (err) => {
        assert.match(err.message, /could not reach 2020-12-08/);
        assert.match(err.message, /relocated the cursor to 2021-08-22/);
        assert.match(err.message, /Replay was stopped/);
        return true;
      },
    );
    assert.ok(r.calls.some((js) => js.includes('stopReplay')),
      'a caller left inside a replay session pointing at the wrong date is the bug, not the fix');
  });

  it('allow_relocation:true proceeds but still reports the truth', async () => {
    const r = replay({ landsOn: '2021-08-22T20:55:00Z' });
    const out = await start({ date: '2020-12-08', allow_relocation: true, _deps: r._deps });
    assert.equal(out.success, true);
    assert.equal(out.relocated, true);
    assert.equal(out.requested_date, '2020-12-08');
    assert.match(out.current_date_iso, /^2021-08-22/);
    assert.match(out.warning, /not the requested 2020-12-08/);
    assert.ok(!r.calls.some((js) => js.includes('stopReplay')));
  });

  it('succeeds silently when the cursor landed on the requested day', async () => {
    // Negative control. Without it, a function that always threw would pass.
    const r = replay({ landsOn: '2020-12-08T14:35:00Z' });
    const out = await start({ date: '2020-12-08', _deps: r._deps });
    assert.equal(out.success, true);
    assert.equal(out.relocated, false);
    assert.equal(out.warning, undefined);
  });

  it('tolerates a weekend or holiday landing without throwing, but says it moved', async () => {
    // Asking for a Saturday and landing on the Monday is not a depth limit.
    const r = replay({ landsOn: '2020-12-07T14:35:00Z' });
    const out = await start({ date: '2020-12-05', _deps: r._deps });
    assert.equal(out.success, true);
    assert.equal(out.relocated, true);
    assert.equal(out.days_away, 2);
    assert.ok(out.days_away <= RELOCATION_TOLERANCE_DAYS);
  });

  it('throws once the gap passes the tolerance', async () => {
    const r = replay({ landsOn: '2020-12-15T14:35:00Z' });
    await assert.rejects(() => start({ date: '2020-12-05', _deps: r._deps }), /could not reach/);
  });

  it('does not throw when no date was requested at all', async () => {
    const r = replay({ landsOn: '2015-01-02T14:35:00Z' });
    const out = await start({ _deps: r._deps });
    assert.equal(out.success, true);
    assert.equal(out.relocated, false);
  });
});
