/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
  };
}

export async function start({ date, allow_relocation = false, _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not available for the current symbol/timeframe', { hint: 'Switch to a symbol/timeframe that supports replay (most stocks/futures, daily and below).' });

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (date) {
    const ts = new Date(date).getTime();
    if (isNaN(ts)) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, `Invalid date: "${date}". Use YYYY-MM-DD format.`);
    await evaluate(`${rp}.selectDate(${ts}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectFirstAvailableDate()`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await new Promise(r => setTimeout(r, 250));
  }

  if (!started) {
    // Capture (don't swallow) the cleanup failure so a half-entered replay
    // that also failed to stop carries the reason as the error's cause.
    let cleanupErr;
    try { await evaluate(`${rp}.stopReplay()`); } catch (e) { cleanupErr = e; }
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      'Replay failed to start. The selected date may not have data for this timeframe.',
      { hint: 'Try a more recent date or a higher timeframe (e.g., Daily).', ...(cleanupErr ? { cause: cleanupErr } : {}) },
    );
  }

  // ISSUE #7: AN OUT-OF-RANGE DATE IS SILENTLY RELOCATED.
  //
  // Measured: replay_start on CME_MINI:NQ1! at 5m for 2020-12-08 put the cursor
  // on 2021-08-22 and returned {success: true, date: "2020-12-08"}. `date`
  // echoed the REQUEST; `current_date` was the truth, in a different unit, and
  // nothing said they disagreed. TradingView shows a "data point unavailable,
  // the chart was moved to the first point available for playback" toast that
  // the API never surfaces.
  //
  // Every read taken afterwards is then correct for a date the caller did not
  // ask for, which for point-in-time work invalidates the entire result. It is
  // per symbol, not a global depth rule: the same 5m request on
  // COINBASE:ETHUSD reaches 2020 and returns genuine bars.
  const relocation = _relocation(date, currentDate);

  if (relocation.relocated && relocation.days > RELOCATION_TOLERANCE_DAYS && !allow_relocation) {
    // Stop replay rather than leave the caller in a session pointing at a date
    // they did not ask for and may not notice.
    let cleanupErr;
    try { await evaluate(`${rp}.stopReplay()`); } catch (e) { cleanupErr = e; }
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `Replay could not reach ${relocation.requested_date} for this symbol and timeframe: TradingView relocated the cursor to ${relocation.current_date}, ${relocation.days} days away. Replay was stopped.`,
      {
        hint: 'Replay depth is per symbol and per timeframe. Use a higher timeframe or a later date, or pass allow_relocation:true to accept the relocated cursor.',
        requested_date: relocation.requested_date,
        current_date: relocation.current_date,
        days_away: relocation.days,
        ...(cleanupErr ? { cause: cleanupErr } : {}),
      },
    );
  }

  return {
    success: true,
    replay_started: true,
    // Kept for compatibility, but it is the request. `current_date` is the truth.
    date: date || '(first available)',
    requested_date: relocation.requested_date,
    current_date: currentDate,
    current_date_iso: relocation.current_date,
    relocated: relocation.relocated,
    ...(relocation.relocated
      ? {
        days_away: relocation.days,
        warning: `The cursor is on ${relocation.current_date}, not the requested ${relocation.requested_date}. Any point-in-time read is for the date the cursor is actually on.`,
      }
      : {}),
  };
}

// A weekend or a holiday run legitimately moves the cursor a few days. Beyond
// that it is a depth limit, and a depth limit is not a rounding error.
export const RELOCATION_TOLERANCE_DAYS = 4;

/**
 * Compare what was asked for against where the cursor actually landed.
 *
 * currentDate is TradingView's replay cursor in SECONDS. Comparing it to a
 * requested midnight timestamp in milliseconds is how a unit mismatch becomes a
 * false "relocated" on every single call, so both sides are normalised to a
 * calendar day in UTC before they are compared.
 */
export function _relocation(requestedDate, currentDate) {
  // Number(null) is 0, which is finite and reads as 1970. A cursor we could not
  // read must stay unknown, not become the epoch and then a 50-year relocation.
  const seconds = (currentDate === null || currentDate === undefined || currentDate === '')
    ? NaN
    : Number(currentDate);
  const asIso = (v) => (Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null);
  const currentIso = asIso(seconds);
  if (!requestedDate || !currentIso) {
    return { relocated: false, days: 0, requested_date: requestedDate || null, current_date: currentIso };
  }
  const requestedMs = new Date(requestedDate).getTime();
  if (!Number.isFinite(requestedMs)) {
    return { relocated: false, days: 0, requested_date: requestedDate, current_date: currentIso };
  }
  const DAY = 86_400_000;
  const requestedDay = Math.floor(requestedMs / DAY);
  const landedDay = Math.floor(seconds * 1000 / DAY);
  const days = Math.abs(landedDay - requestedDay);
  return {
    relocated: days > 0,
    days,
    requested_date: new Date(requestedDay * DAY).toISOString().slice(0, 10),
    current_date: currentIso,
  };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  let advanced = false;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    // Type guard: currentDate can transiently read back null/undefined; only a
    // real, different value counts as advanced — otherwise we'd "advance" to
    // undefined and return it as the new date.
    if (currentDate != null && currentDate !== before) { advanced = true; break; }
  }
  if (!advanced) {
    // Didn't advance within the poll window — likely end-of-data. Best-effort
    // confirm via the replay API so the caller learns stepping is exhausted.
    // Guarded: returns null if the method isn't present on this TV build, in
    // which case we simply omit at_end (only runs on the already-slow path).
    const ended = await evaluate(`
      (function(){
        try {
          var r = ${rp};
          function u(v){ return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
          if (typeof r.isReplayFinished === 'function') return !!u(r.isReplayFinished());
          if (typeof r.isReplayEnded === 'function') return !!u(r.isReplayEnded());
          if (typeof r.isLastBar === 'function') return !!u(r.isLastBar());
          return null;
        } catch(e){ return null; }
      })()
    `);
    return { success: true, action: 'step', current_date: currentDate, advanced: false, ...(ended === true ? { at_end: true } : {}) };
  }
  return { success: true, action: 'step', current_date: currentDate, advanced: true };
}

export async function autoplay({ speed, enabled, _deps } = {}) {
  // VALIDATE EVERYTHING BEFORE MUTATING ANYTHING.
  //
  // This validated `speed` up here and `enabled` further down, AFTER
  // changeAutoplayDelay had already been applied. autoplay({speed: 100,
  // enabled: "yes"}) therefore wrote the delay, which this function's own
  // comment notes is persisted to the cloud account, and only then threw
  // INVALID_ARGUMENT. A rejected call that half-applied itself is worse than
  // either outcome on its own.
  //
  // The `speed > 0` gate also meant a non-numeric speed skipped validation
  // entirely and silently did nothing while reporting success.
  if (speed !== undefined) {
    if (typeof speed !== 'number' || !Number.isFinite(speed)) {
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        `speed must be a number; received ${JSON.stringify(speed)}`,
        { hint: `Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}. This is a DELAY in ms, so larger is slower.` },
      );
    }
    if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed)) {
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        `Invalid autoplay delay ${speed}ms.`,
        { hint: `Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}` },
      );
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'enabled must be a boolean (true or false), or omitted to flip the current state',
    );
  }

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }

  // This was a bare toggleAutoplay(), so "turn autoplay OFF" could not be
  // expressed at all: asking for off flipped it ON, and the honest return then
  // reported autoplay_active:true for a call that meant the opposite. Accept an
  // explicit target and only toggle when it is not already there.
  const wasOn = !!(await evaluate(wv(`${rp}.isAutoplayStarted()`)));
  const want = enabled === undefined ? !wasOn : enabled;
  if (wasOn !== want) {
    await evaluate(`${rp}.toggleAutoplay()`);
  }

  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  if (!!isAutoplay !== want) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `Autoplay was asked to be ${want ? 'on' : 'off'} but it is ${isAutoplay ? 'on' : 'off'}`,
      { hint: 'Confirm replay is still running with replay_status, then retry.' },
    );
  }
  return {
    success: true,
    autoplay_active: !!isAutoplay,
    was_active: wasOn,
    changed: wasOn !== !!isAutoplay,
    delay_ms: currentDelay,
    verified: true,
  };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await evaluate(`${rp}.stopReplay()`);
  return { success: true, action: 'replay_stopped' };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new ClassifiedError(CATEGORIES.REPLAY_NOT_STARTED, 'Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, ...st, position: pos, realized_pnl: pnl };
}
