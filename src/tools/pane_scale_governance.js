import { evaluate as pageEvaluate } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const MAX_GOVERNED_PANE_SCALES = 16;

function _invalid(message) {
  throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, message);
}

export function normalizePanePriceScaleRequests(requests) {
  if (requests === undefined) return [];
  if (!Array.isArray(requests) || requests.length === 0) {
    _invalid('pane_price_scales must be a non-empty array when supplied');
  }
  if (requests.length > MAX_GOVERNED_PANE_SCALES) {
    _invalid(`pane_price_scales cannot contain more than ${MAX_GOVERNED_PANE_SCALES} entries`);
  }

  const seen = new Set();
  return requests.map((row, position) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      _invalid(`pane_price_scales[${position}] must be an object`);
    }
    const index = row.index;
    if (!Number.isInteger(index) || index < 1) {
      _invalid(`pane_price_scales[${position}].index must be an integer greater than or equal to 1`);
    }
    if (seen.has(index)) {
      _invalid(`pane_price_scales contains duplicate pane index ${index}`);
    }
    seen.add(index);

    if (typeof row.auto_scale !== 'boolean') {
      _invalid(`pane_price_scales[${position}].auto_scale must be a boolean`);
    }
    const hasFrom = row.from !== undefined;
    const hasTo = row.to !== undefined;
    if (row.auto_scale) {
      if (hasFrom || hasTo) {
        _invalid(`pane_price_scales[${position}] cannot combine auto_scale=true with a manual range`);
      }
      return { index, auto_scale: true };
    }

    if (!hasFrom || !hasTo) {
      _invalid(`pane_price_scales[${position}] requires from and to when auto_scale=false`);
    }
    const from = Number(row.from);
    const to = Number(row.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      _invalid(`pane_price_scales[${position}] requires a finite manual range with from < to`);
    }
    return { index, auto_scale: false, from, to };
  });
}

export async function preflightPanePriceScales(
  requests,
  { evaluatePage = pageEvaluate } = {},
) {
  const normalized = normalizePanePriceScaleRequests(requests);
  if (normalized.length === 0) {
    return { success: true, pane_count: null, requested_count: 0 };
  }

  const raw = await evaluatePage(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : null;
      var requested = ${JSON.stringify(normalized)};
      if (!Array.isArray(panes)) {
        return { success: false, error: 'pane_api_unavailable' };
      }

      for (var i = 0; i < requested.length; i++) {
        var req = requested[i];
        var pane = panes[req.index];
        var scale = null;
        try {
          scale = pane && typeof pane.getMainSourcePriceScale === 'function'
            ? pane.getMainSourcePriceScale()
            : null;
        } catch (e) {}
        if (
          !scale
          || typeof scale.isAutoScale !== 'function'
          || typeof scale.getVisiblePriceRange !== 'function'
          || typeof scale.setAutoScale !== 'function'
          || (!req.auto_scale && typeof scale.setVisiblePriceRange !== 'function')
        ) {
          return {
            success: false,
            error: 'pane_price_scale_api_unavailable',
            pane_index: req.index,
          };
        }
        try {
          var autoScale = scale.isAutoScale();
          var range = scale.getVisiblePriceRange();
          if (
            typeof autoScale !== 'boolean'
            || !range
            || typeof range.from !== 'number'
            || !Number.isFinite(range.from)
            || typeof range.to !== 'number'
            || !Number.isFinite(range.to)
            || range.from >= range.to
          ) {
            return {
              success: false,
              error: 'pane_price_scale_state_invalid',
              pane_index: req.index,
            };
          }
        } catch (e) {
          return {
            success: false,
            error: 'pane_price_scale_read_failed',
            pane_index: req.index,
          };
        }
      }
      return {
        success: true,
        pane_count: panes.length,
        requested_count: requested.length,
      };
    })()
  `);

  if (raw?.success !== true) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView pane-scale preflight failed: ${raw?.error || 'unknown error'}`,
    );
  }
  return raw;
}

export async function applyPanePriceScales(
  requests,
  { evaluatePage = pageEvaluate } = {},
) {
  const normalized = normalizePanePriceScaleRequests(requests);
  if (normalized.length === 0) {
    return { success: true, requested_count: 0, rollback_complete: true };
  }

  await preflightPanePriceScales(normalized, { evaluatePage });

  const raw = await evaluatePage(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : null;
      var requested = ${JSON.stringify(normalized)};
      if (!Array.isArray(panes)) {
        return { success: false, error: 'pane_api_unavailable', rollback_complete: true };
      }

      var resolved = [];
      for (var i = 0; i < requested.length; i++) {
        var req = requested[i];
        var pane = panes[req.index];
        var scale = null;
        try {
          scale = pane && typeof pane.getMainSourcePriceScale === 'function'
            ? pane.getMainSourcePriceScale()
            : null;
        } catch (e) {}
        if (
          !scale
          || typeof scale.isAutoScale !== 'function'
          || typeof scale.getVisiblePriceRange !== 'function'
          || typeof scale.setAutoScale !== 'function'
          || (!req.auto_scale && typeof scale.setVisiblePriceRange !== 'function')
        ) {
          return {
            success: false,
            error: 'pane_price_scale_api_unavailable',
            pane_index: req.index,
            rollback_complete: true,
          };
        }
        try {
          var beforeAuto = scale.isAutoScale();
          var beforeRange = scale.getVisiblePriceRange();
          if (
            typeof beforeAuto !== 'boolean'
            || !beforeRange
            || typeof beforeRange.from !== 'number'
            || !Number.isFinite(beforeRange.from)
            || typeof beforeRange.to !== 'number'
            || !Number.isFinite(beforeRange.to)
            || beforeRange.from >= beforeRange.to
          ) {
            return {
              success: false,
              error: 'pane_price_scale_state_invalid',
              pane_index: req.index,
              rollback_complete: true,
            };
          }
          resolved.push({
            request: req,
            scale: scale,
            before_auto_scale: beforeAuto,
            before_range: { from: beforeRange.from, to: beforeRange.to },
          });
        } catch (e) {
          return {
            success: false,
            error: 'pane_price_scale_read_failed',
            pane_index: req.index,
            rollback_complete: true,
          };
        }
      }

      try {
        for (var j = 0; j < resolved.length; j++) {
          var item = resolved[j];
          if (item.request.auto_scale) {
            item.scale.setAutoScale(true);
          } else {
            item.scale.setAutoScale(false);
            item.scale.setVisiblePriceRange({
              from: item.request.from,
              to: item.request.to,
            });
          }
        }
      } catch (applyError) {
        var rollbackComplete = true;
        for (var k = resolved.length - 1; k >= 0; k--) {
          var original = resolved[k];
          try {
            if (original.before_auto_scale) {
              original.scale.setAutoScale(true);
            } else {
              original.scale.setAutoScale(false);
              original.scale.setVisiblePriceRange(original.before_range);
            }
          } catch (rollbackError) {
            rollbackComplete = false;
          }
        }
        return {
          success: false,
          error: 'pane_price_scale_apply_failed',
          rollback_complete: rollbackComplete,
        };
      }

      return {
        success: true,
        requested_count: requested.length,
        rollback_complete: true,
      };
    })()
  `);

  if (raw?.success !== true) {
    throw new ClassifiedError(
      CATEGORIES.API_UNEXPECTED,
      `TradingView pane-scale application failed: ${raw?.error || 'unknown error'}`,
    );
  }
  return raw;
}
