import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatibilityCheck } from './health.js';
import { ClassifiedError, CATEGORIES } from '../errors.js';
import { isReadonlyMode, isToolRegistered } from './readonly.js';
import { FALLBACK_TOOL_CATALOG } from './catalog_fallback.js';

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const CACHE_MS = 10_000;
let cachedProbe = null;

const FAMILY_REQUIREMENTS = Object.freeze({
  chart_get_state: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies'],
  chart_set_symbol: ['active_chart', 'chart_symbol'],
  chart_set_timeframe: ['active_chart', 'chart_resolution'],
  chart_set_type: ['active_chart'],
  chart_manage_indicator: ['active_chart', 'chart_studies'],
  chart_get_visible_range: ['active_chart', 'chart_widget_model'],
  chart_set_visible_range: ['active_chart', 'chart_widget_model'],
  chart_scroll_to_date: ['active_chart', 'chart_widget_model'],
  symbol_info: ['active_chart', 'chart_symbol'],
  data_get_ohlcv: ['main_series_bars'],
  quote_get: ['main_series_bars'],
  data_get_indicator: ['chart_studies'],
  data_get_strategy_results: ['chart_studies', 'model_data_sources'],
  data_get_trades: ['chart_studies', 'model_data_sources'],
  data_get_equity: ['chart_studies', 'model_data_sources'],
  data_get_study_values: ['chart_studies'],
  data_get_pine_lines: ['model_data_sources'],
  data_get_pine_labels: ['model_data_sources'],
  data_get_pine_tables: ['model_data_sources'],
  data_get_pine_boxes: ['model_data_sources'],
  depth_get: ['main_series'],
  draw_shape: ['model_data_sources'],
  draw_list: ['model_data_sources'],
  draw_clear: ['model_data_sources'],
  draw_remove_one: ['model_data_sources'],
  draw_get_properties: ['model_data_sources'],
  indicator_set_inputs: ['chart_studies'],
  indicator_toggle_visibility: ['chart_studies'],
  batch_run: ['active_chart', 'chart_symbol', 'chart_resolution'],
  strategy_sweep: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies', 'model_data_sources'],
  state_snapshot: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies'],
  state_restore: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies'],
  chart_vision_read: ['active_chart', 'chart_symbol', 'chart_resolution', 'chart_studies', 'main_series_bars'],
  pane_list: ['chart_widget_model'],
  pane_set_layout: ['chart_widget_model'],
  pane_focus: ['chart_widget_model'],
  pane_set_symbol: ['chart_widget_model'],
  replay_start: ['active_chart'],
  replay_step: ['active_chart'],
  replay_autoplay: ['active_chart'],
  replay_stop: ['active_chart'],
  replay_trade: ['active_chart'],
  replay_status: ['active_chart'],
  alert_create: ['main_series'],
});

// A SERVER THAT CANNOT READ ITS OWN SOURCE STILL HAS TO SERVE TOOLS.
//
// Measured 2026-09-08: Windows users running the bundled server out of
// C:\Program Files\ lost it at module load with `EPERM reading
// ...\node_modules\@ferroxlabs\...` and saw only `-32000: Connection closed`.
// Restrictive ACLs and Controlled Folder Access deny directory ENUMERATION to a
// non-elevated process well before they deny anything else, and this scan was
// the first thing that ran — before the server object existed, so there was no
// protocol channel left to report the failure on.
//
// The scan stays primary, because a derived count is the only kind that cannot
// drift. When it throws, fall back to the catalog generated at publish time
// (scripts/gen_tool_catalog.js) and SAY SO in `source`. A fallback that reports
// itself as a scan would be exactly the silent success this scan was written to
// end.
//
// An empty scan counts as a failure too: a tools directory that reads as zero
// tools is a failed read, not a package with no tools.
export function discoverToolCatalogDetailed({ _deps } = {}) {
  const deps = {
    readdirSync: _deps?.readdirSync || readdirSync,
    readFileSync: _deps?.readFileSync || readFileSync,
    toolsDir: _deps?.toolsDir || TOOLS_DIR,
  };
  const names = new Set();
  let failure = null;
  try {
    for (const file of deps.readdirSync(deps.toolsDir).filter((value) => value.endsWith('.js')).sort()) {
      const source = deps.readFileSync(join(deps.toolsDir, file), 'utf8');
      for (const match of source.matchAll(/server\.tool\s*\(\s*['"]([^'"]+)['"]/g)) names.add(match[1]);
    }
  } catch (err) {
    // Node's fs messages already lead with the code (`EACCES: permission denied, scandir ...`).
    failure = err?.message || String(err);
  }
  if (!failure && names.size === 0) failure = `no tools found in ${deps.toolsDir}`;
  if (failure) return { tools: [...FALLBACK_TOOL_CATALOG], source: 'fallback', error: failure };
  return { tools: [...names].sort(), source: 'scan', error: null };
}

export function discoverToolCatalog(options = {}) {
  return discoverToolCatalogDetailed(options).tools;
}

export function requiredCapabilitiesForTool(name) {
  if (FAMILY_REQUIREMENTS[name]) return [...FAMILY_REQUIREMENTS[name]];
  if (name.startsWith('chart_')) return ['active_chart'];
  return [];
}

async function _probe(deps, force = false) {
  const now = deps.now();
  if (!force && cachedProbe && now - cachedProbe.at < CACHE_MS) return cachedProbe.value;
  const value = await deps.compatibilityCheck();
  cachedProbe = { at: now, value };
  return value;
}

export async function getCapabilityMatrix({ probe = true, force = false, _deps } = {}) {
  const deps = {
    compatibilityCheck: _deps?.compatibilityCheck || compatibilityCheck,
    catalog: _deps?.catalog || (() => discoverToolCatalogDetailed({ _deps })),
    now: _deps?.now || Date.now,
  };
  // An injected catalog is a bare array; the real one carries its provenance.
  const scanned = deps.catalog();
  const catalogNames = Array.isArray(scanned) ? scanned : scanned.tools;
  const catalogSource = Array.isArray(scanned) ? 'scan' : scanned.source;
  const catalogError = Array.isArray(scanned) ? null : scanned.error;
  let live = null;
  let probeError = null;
  if (probe) {
    try { live = await _probe(deps, force); }
    catch (err) { probeError = err?.category || CATEGORIES.CDP_DISCONNECTED; }
  }
  const checks = live?.checks || null;
  const tools = catalogNames.map((name) => {
    const requires = requiredCapabilitiesForTool(name);
    const missing = checks ? requires.filter((capability) => checks[capability] !== true) : [];
    // Same predicate the server registers by, so the matrix cannot claim a tool is
    // available in a session where the server never registered it.
    const registered = isToolRegistered(name);
    return {
      tool: name,
      requires,
      status: !registered ? 'disabled' : (checks ? (missing.length === 0 ? 'available' : 'blocked') : 'unknown'),
      ...(missing.length > 0 ? { missing } : {}),
      registered,
      registered_by_default: name !== 'ui_evaluate',
    };
  });
  return {
    success: true,
    readonly_mode: isReadonlyMode(),
    probe_status: checks ? 'available' : (probe ? 'unavailable' : 'not_requested'),
    ...(probeError ? { probe_error_category: probeError } : {}),
    desktop_version: live?.desktop_version || null,
    // 'fallback' means src/tools/ could not be read and this list is the one
    // frozen at publish time. It is the honest answer to "is this matrix
    // derived from what is actually installed?"
    catalog_source: catalogSource,
    ...(catalogError ? { catalog_error: catalogError } : {}),
    tool_count: tools.length,
    registered: tools.filter((tool) => tool.registered).length,
    available: tools.filter((tool) => tool.status === 'available').length,
    blocked: tools.filter((tool) => tool.status === 'blocked').length,
    unknown: tools.filter((tool) => tool.status === 'unknown').length,
    disabled: tools.filter((tool) => tool.status === 'disabled').length,
    tools,
  };
}

export function gateToolHandler(name, handler, { _deps } = {}) {
  const requires = requiredCapabilitiesForTool(name);
  if (requires.length === 0) return handler;
  const deps = {
    compatibilityCheck: _deps?.compatibilityCheck || compatibilityCheck,
    now: _deps?.now || Date.now,
  };
  return async (...args) => {
    let live;
    try { live = await _probe(deps); }
    catch (_) { return handler(...args); }
    const checks = live?.checks;
    if (!checks) return handler(...args);
    const missing = requires.filter((capability) => checks[capability] !== true);
    if (missing.length > 0) {
      throw new ClassifiedError(
        CATEGORIES.TV_UI_CHANGED,
        `${name} is unavailable because TradingView is missing required capabilities: ${missing.join(', ')}`,
        { hint: 'Run tv capabilities and tv compatibility. Update TVControl or TradingView, then retry after the compatibility canary is green.' },
      );
    }
    return handler(...args);
  };
}

export function _resetCapabilityCacheForTests() {
  cachedProbe = null;
}
