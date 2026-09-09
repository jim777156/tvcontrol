import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/chart.js';
import { evaluate as pageEvaluate } from '../connection.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import {
  applyPanePriceScales,
  normalizePanePriceScaleRequests,
  preflightPanePriceScales,
} from './pane_scale_governance.js';

const paneScaleRequestSchema = z.object({
  index: z.number().int().min(1),
  auto_scale: z.boolean(),
  from: z.number().optional(),
  to: z.number().optional(),
});

function _emptyPaneScaleObservation(error) {
  return {
    pane_count: null,
    readable_count: 0,
    complete: false,
    panes: [],
    error,
  };
}

function _sanitizePaneScaleObservation(payload) {
  if (
    !payload
    || typeof payload !== 'object'
    || !Number.isInteger(payload.pane_count)
    || payload.pane_count < 0
    || !Array.isArray(payload.panes)
    || payload.panes.length !== payload.pane_count
  ) {
    return _emptyPaneScaleObservation('invalid_pane_scale_observability_payload');
  }

  const panes = [];
  let readableCount = 0;
  for (let expectedIndex = 0; expectedIndex < payload.panes.length; expectedIndex += 1) {
    const row = payload.panes[expectedIndex];
    if (
      !row
      || typeof row !== 'object'
      || row.index !== expectedIndex
      || typeof row.available !== 'boolean'
    ) {
      return _emptyPaneScaleObservation('invalid_pane_scale_observability_payload');
    }

    const sourceName = typeof row.source_name === 'string' && row.source_name.trim()
      ? row.source_name.trim()
      : null;

    if (row.available) {
      const range = row.visible_price_range;
      if (
        typeof row.auto_scale !== 'boolean'
        || !range
        || typeof range !== 'object'
        || typeof range.from !== 'number'
        || !Number.isFinite(range.from)
        || typeof range.to !== 'number'
        || !Number.isFinite(range.to)
        || range.from >= range.to
      ) {
        return _emptyPaneScaleObservation('invalid_pane_scale_observability_payload');
      }
      panes.push({
        index: expectedIndex,
        source_name: sourceName,
        available: true,
        auto_scale: row.auto_scale,
        visible_price_range: { from: range.from, to: range.to },
      });
      readableCount += 1;
      continue;
    }

    panes.push({
      index: expectedIndex,
      source_name: sourceName,
      available: false,
      auto_scale: null,
      visible_price_range: null,
      error: typeof row.error === 'string' && row.error
        ? row.error
        : 'pane_price_scale_unavailable',
    });
  }

  return {
    pane_count: payload.pane_count,
    readable_count: readableCount,
    complete: readableCount === payload.pane_count,
    panes,
  };
}

/**
 * Observe every internal TradingView pane's main-source price scale.
 *
 * This is deliberately read-only. C1-B1 exists to determine whether indicator
 * panes such as MACD/RSI are already in auto-scale mode during historical
 * reconstruction or are carrying a manual/stale range. Failure to observe one
 * pane must not break the commissioned visible-range read, so unreadable panes
 * are reported explicitly rather than turning chart_get_visible_range into a
 * new failure mode.
 */
export async function readPanePriceScales({ evaluatePage = pageEvaluate } = {}) {
  try {
    const raw = await evaluatePage(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var panes = typeof chart.getPanes === 'function' ? chart.getPanes() : null;
        if (!Array.isArray(panes)) {
          return { pane_count: null, panes: [], error: 'pane_api_unavailable' };
        }

        var rows = [];
        for (var i = 0; i < panes.length; i++) {
          var pane = panes[i];
          var sourceName = null;
          try {
            var source = pane && typeof pane.getMainSource === 'function'
              ? pane.getMainSource()
              : null;
            if (source) {
              try {
                var meta = typeof source.metaInfo === 'function' ? source.metaInfo() : null;
                if (meta) {
                  sourceName = String(meta.shortDescription || meta.description || meta.id || '') || null;
                }
              } catch (e) {}
              if (!sourceName) {
                try {
                  sourceName = typeof source.title === 'function'
                    ? String(source.title() || '') || null
                    : null;
                } catch (e) {}
              }
            }
          } catch (e) {}

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
          ) {
            rows.push({
              index: i,
              source_name: sourceName,
              available: false,
              auto_scale: null,
              visible_price_range: null,
              error: 'pane_price_scale_api_unavailable',
            });
            continue;
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
              rows.push({
                index: i,
                source_name: sourceName,
                available: false,
                auto_scale: null,
                visible_price_range: null,
                error: 'pane_price_scale_state_invalid',
              });
              continue;
            }
            rows.push({
              index: i,
              source_name: sourceName,
              available: true,
              auto_scale: autoScale,
              visible_price_range: { from: range.from, to: range.to },
            });
          } catch (e) {
            rows.push({
              index: i,
              source_name: sourceName,
              available: false,
              auto_scale: null,
              visible_price_range: null,
              error: 'pane_price_scale_read_failed',
            });
          }
        }

        return { pane_count: panes.length, panes: rows };
      })()
    `);
    return _sanitizePaneScaleObservation(raw);
  } catch (err) {
    return _emptyPaneScaleObservation('pane_price_scale_read_failed');
  }
}

export function registerChartTools(server) {
  server.tool('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {}, async () => {
    try { return jsonResult(await core.getState()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.setSymbol({ symbol })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
  }, async ({ timeframe }) => {
    try { return jsonResult(await core.setTimeframe({ timeframe })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  }, async ({ chart_type }) => {
    try { return jsonResult(await core.setType({ chart_type })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().optional().describe('Full indicator name (required for add): "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work.'),
    entity_id: z.string().optional().describe('Entity ID to remove (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g. \'{"length": 20}\')'),
  }, async ({ action, indicator, entity_id, inputs }) => {
    try {
      if (action === 'add' && !indicator) throw new ClassifiedError(CATEGORIES.INVALID_ARGUMENT, 'indicator is required for add action');
      return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs }));
    }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_get_visible_range', 'Get the visible date range (unix timestamps), bars range, and read-only pane scale state on the chart', {}, async () => {
    try {
      const result = await core.getVisibleRange();
      const paneScales = await readPanePriceScales();
      return jsonResult({
        ...result,
        visual_state: {
          ...result.visual_state,
          pane_price_scales: paneScales.panes,
          pane_price_scale_observability: {
            pane_count: paneScales.pane_count,
            readable_count: paneScales.readable_count,
            complete: paneScales.complete,
            ...(paneScales.error ? { error: paneScales.error } : {}),
          },
        },
      });
    }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_set_visible_range', 'Zoom the chart and optionally govern readable secondary pane scales', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
    bar_spacing: z.coerce.number().optional().describe('Optional time-scale bar spacing; must be finite and greater than 0'),
    right_offset: z.coerce.number().optional().describe('Optional time-scale right offset; must be finite'),
    main_price_auto_scale: z.boolean().optional().describe('Optional main source price-scale auto/manual mode'),
    main_price_from: z.coerce.number().optional().describe('Optional manual main source price range lower bound'),
    main_price_to: z.coerce.number().optional().describe('Optional manual main source price range upper bound'),
    pane_price_scales: z.array(paneScaleRequestSchema).max(16).optional().describe(
      'Optional governed secondary pane scales by zero-based pane index. Index 0 is reserved for the main price scale. Use auto_scale=true with no range, or auto_scale=false with from/to.',
    ),
  }, async ({
    from,
    to,
    bar_spacing,
    right_offset,
    main_price_auto_scale,
    main_price_from,
    main_price_to,
    pane_price_scales,
  }) => {
    try {
      const governedPanes = normalizePanePriceScaleRequests(pane_price_scales);
      if (governedPanes.length > 0) {
        await preflightPanePriceScales(governedPanes);
      }
      const result = await core.setVisibleRange({
        from,
        to,
        bar_spacing,
        right_offset,
        main_price_auto_scale,
        main_price_from,
        main_price_to,
      });
      if (governedPanes.length > 0) {
        await applyPanePriceScales(governedPanes);
      }
      return jsonResult(result);
    }
    catch (err) { return errorResult(err); }
  });

  server.tool('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  }, async ({ date }) => {
    try { return jsonResult(await core.scrollToDate({ date })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {}, async () => {
    try { return jsonResult(await core.symbolInfo()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES1!")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  }, async ({ query, type }) => {
    try { return jsonResult(await core.symbolSearch({ query, type })); }
    catch (err) { return errorResult(err); }
  });
}
