import { evaluate as _evaluate, safeString } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import * as chart from './chart.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const MAX_SECONDARY_PANES = 12;

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    sleep: deps?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

function _finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function _normalizeScaleSnapshot(value) {
  if (!Array.isArray(value) || value.length > MAX_SECONDARY_PANES) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      `secondary_price_scales must be an array of at most ${MAX_SECONDARY_PANES} pane states`,
    );
  }
  const seen = new Set();
  return value.map((item) => {
    const paneIndex = item?.pane_index;
    const autoScale = item?.auto_scale;
    const from = item?.from;
    const to = item?.to;
    if (
      !Number.isInteger(paneIndex)
      || paneIndex < 1
      || seen.has(paneIndex)
      || typeof autoScale !== 'boolean'
      || !_finite(from)
      || !_finite(to)
      || from >= to
    ) {
      throw new ClassifiedError(
        CATEGORIES.INVALID_ARGUMENT,
        'secondary_price_scales contains an invalid or duplicate pane state',
      );
    }
    seen.add(paneIndex);
    return { pane_index: paneIndex, auto_scale: autoScale, from, to };
  });
}

async function _readSecondaryPriceScales(evaluate) {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : null;
      if (!Array.isArray(panes)) return { success: false, error: 'pane_api_unavailable' };
      if (panes.length - 1 > ${MAX_SECONDARY_PANES}) {
        return { success: false, error: 'secondary_pane_limit_exceeded' };
      }
      var scales = [];
      for (var i = 1; i < panes.length; i++) {
        var pane = panes[i];
        var scale = pane && typeof pane.getMainSourcePriceScale === 'function'
          ? pane.getMainSourcePriceScale()
          : null;
        if (
          !scale
          || typeof scale.isAutoScale !== 'function'
          || typeof scale.getVisiblePriceRange !== 'function'
        ) {
          return { success: false, error: 'secondary_price_scale_api_unavailable', pane_index: i };
        }
        var range = scale.getVisiblePriceRange();
        var autoScale = scale.isAutoScale();
        if (
          typeof autoScale !== 'boolean'
          || !range
          || typeof range.from !== 'number'
          || !Number.isFinite(range.from)
          || typeof range.to !== 'number'
          || !Number.isFinite(range.to)
          || range.from >= range.to
        ) {
          return { success: false, error: 'secondary_price_scale_state_invalid', pane_index: i };
        }
        scales.push({
          pane_index: i,
          auto_scale: autoScale,
          from: range.from,
          to: range.to,
        });
      }
      return { success: true, pane_count: panes.length, scales: scales };
    })()
  `);
  if (result?.success !== true || !Array.isArray(result.scales)) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView secondary pane price-scale read failed: ${result?.error || 'unknown error'}`,
    );
  }
  return result.scales;
}

async function _applySecondaryPriceScales(evaluate, { autoScale, restoreScales }) {
  const command = autoScale === true
    ? { mode: 'auto' }
    : { mode: 'restore', scales: restoreScales };
  const encoded = safeString(JSON.stringify(command));
  const result = await evaluate(`
    (function() {
      var command = JSON.parse(${encoded});
      var chart = ${CHART_API};
      var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : null;
      if (!Array.isArray(panes)) return { success: false, error: 'pane_api_unavailable' };
      if (command.mode === 'auto') {
        for (var i = 1; i < panes.length; i++) {
          var autoPane = panes[i];
          var autoScale = autoPane && typeof autoPane.getMainSourcePriceScale === 'function'
            ? autoPane.getMainSourcePriceScale()
            : null;
          if (!autoScale || typeof autoScale.setAutoScale !== 'function') {
            return { success: false, error: 'secondary_price_scale_autoscale_unavailable', pane_index: i };
          }
          autoScale.setAutoScale(true);
        }
        return { success: true, applied: Math.max(0, panes.length - 1) };
      }
      if (command.mode === 'restore') {
        if (!Array.isArray(command.scales) || command.scales.length !== Math.max(0, panes.length - 1)) {
          return { success: false, error: 'secondary_price_scale_restore_count_mismatch' };
        }
        for (var j = 0; j < command.scales.length; j++) {
          var wanted = command.scales[j];
          var restorePane = panes[wanted.pane_index];
          var restoreScale = restorePane && typeof restorePane.getMainSourcePriceScale === 'function'
            ? restorePane.getMainSourcePriceScale()
            : null;
          if (
            !restoreScale
            || typeof restoreScale.setAutoScale !== 'function'
            || typeof restoreScale.setVisiblePriceRange !== 'function'
          ) {
            return { success: false, error: 'secondary_price_scale_restore_unavailable', pane_index: wanted.pane_index };
          }
          if (wanted.auto_scale) {
            restoreScale.setAutoScale(true);
          } else {
            restoreScale.setAutoScale(false);
            restoreScale.setVisiblePriceRange({ from: wanted.from, to: wanted.to });
          }
        }
        return { success: true, applied: command.scales.length };
      }
      return { success: false, error: 'secondary_price_scale_mode_invalid' };
    })()
  `);
  if (result?.success !== true) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView secondary pane price-scale application failed: ${result?.error || 'unknown error'}`,
    );
  }
  return result;
}

function _withSecondaryState(baseResult, scales) {
  return {
    ...baseResult,
    visual_state: {
      ...baseResult.visual_state,
      secondary_price_scales: scales,
    },
  };
}

export async function getVisibleRange({ include_secondary_price_scales = false, _deps } = {}) {
  const baseResult = await chart.getVisibleRange({ _deps });
  if (include_secondary_price_scales !== true) return baseResult;

  const { evaluate } = _resolve(_deps);
  const scales = await _readSecondaryPriceScales(evaluate);
  return _withSecondaryState(baseResult, scales);
}

export async function setVisibleRange({
  from,
  to,
  bar_spacing,
  right_offset,
  main_price_auto_scale,
  main_price_from,
  main_price_to,
  secondary_price_auto_scale,
  secondary_price_scales,
  _deps,
}) {
  if (secondary_price_auto_scale !== undefined && typeof secondary_price_auto_scale !== 'boolean') {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'secondary_price_auto_scale must be a boolean',
    );
  }
  if (secondary_price_auto_scale === false) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'secondary_price_auto_scale only supports true; use secondary_price_scales for exact restoration',
    );
  }
  if (secondary_price_auto_scale === true && secondary_price_scales !== undefined) {
    throw new ClassifiedError(
      CATEGORIES.INVALID_ARGUMENT,
      'secondary_price_auto_scale cannot be combined with secondary_price_scales',
    );
  }
  const normalizedScales = secondary_price_scales === undefined
    ? undefined
    : _normalizeScaleSnapshot(secondary_price_scales);

  const { evaluate, sleep } = _resolve(_deps);
  const baseResult = await chart.setVisibleRange({
    from,
    to,
    bar_spacing,
    right_offset,
    main_price_auto_scale,
    main_price_from,
    main_price_to,
    _deps,
  });

  if (secondary_price_auto_scale === true) {
    await _applySecondaryPriceScales(evaluate, { autoScale: true });
    await sleep(300);
  } else if (normalizedScales !== undefined) {
    await _applySecondaryPriceScales(evaluate, {
      autoScale: false,
      restoreScales: normalizedScales,
    });
    await sleep(300);
  } else {
    return baseResult;
  }

  const scales = await _readSecondaryPriceScales(evaluate);
  return _withSecondaryState(baseResult, scales);
}
