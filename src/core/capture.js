/**
 * Core screenshot/capture logic.
 */
import { getClient, evaluate, getChartCollection } from '../connection.js';
import { waitForChartRender } from '../wait.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ClassifiedError, CATEGORIES } from '../errors.js';

const SCREENSHOT_DIR = process.env.TV_MCP_SCREENSHOT_DIR
  || join(homedir(), '.tv-mcp', 'screenshots');

/**
 * A HIDDEN TAB RETURNS THE LAST FRAME IT PAINTED.
 *
 * Issue #3, measured on Desktop 3.3.0: Chromium suspends canvas compositing for
 * a background tab, so Page.captureScreenshot hands back a real PNG of the right
 * chart showing the WRONG DATA. It is the worst failure shape available here -
 * plausible, silent, and it survives review. The DOM keeps updating underneath,
 * so the header, the quote and the status-bar clock in the image are current
 * while the candles and the price axis are frozen. Three consecutive captures
 * 40s apart were byte-similar frozen charts whose only moving element was a
 * clock.
 *
 * An agent building a report treats the PNG as evidence. So refuse, rather than
 * hand back evidence of a moment that never happened.
 */
async function _assertTargetVisible(evaluateImpl) {
  let state;
  try {
    state = await evaluateImpl('document.visibilityState');
  } catch (_) {
    // Absence of evidence is not evidence of visibility.
    state = null;
  }
  if (state === 'visible') return state;
  throw new ClassifiedError(
    CATEGORIES.CHART_LOADING,
    state === null
      ? 'Could not confirm the target tab is visible, so the capture was refused: a hidden tab returns the last frame it painted, which looks like a valid chart of the wrong data'
      : `Target tab is ${state}, not visible. A capture would return the last frame it painted - the right chart showing stale data.`,
    { hint: 'Front the tab with tab_switch first, or pass allow_hidden:true if you have accepted that the image may be stale.' },
  );
}

export async function captureScreenshot({
  region = 'full', filename, method, wait_for_render = false, allow_hidden = false, _deps,
} = {}) {
  const evaluateImpl = _deps?.evaluate || evaluate;
  const getClientImpl = _deps?.getClient || getClient;
  const getChartCollectionImpl = _deps?.getChartCollection || getChartCollection;
  const waitForChartRenderImpl = _deps?.waitForChartRender || waitForChartRender;
  const writeFileSyncImpl = _deps?.writeFileSync || writeFileSync;

  let visibility = 'not_checked';
  if (!allow_hidden) {
    visibility = await _assertTargetVisible(evaluateImpl);
  }

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (wait_for_render) {
    const settled = await waitForChartRenderImpl();
    if (!settled) {
      throw new ClassifiedError(CATEGORIES.CHART_LOADING, 'Chart did not reach a stable rendered state before screenshot');
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fname = (filename || `tv_${region}_${ts}`).replace(/[\/\\]/g, '_').replace(/\.\./g, '_');
  const filePath = join(SCREENSHOT_DIR, `${fname}.png`);

  if (method === 'api') {
    try {
      const colPath = await getChartCollectionImpl();
      await evaluateImpl(`${colPath}.takeScreenshot()`);
      return {
        success: true, method: 'api',
        note: 'takeScreenshot() triggered — TradingView will save/show the screenshot via its own UI',
      };
    } catch {
      // Fall through to CDP method
    }
  }

  const client = await getClientImpl();
  let clip = undefined;

  let paneSelected = null;
  if (region === 'chart') {
    // ISSUE #4: querySelector TAKES THE FIRST MATCH.
    //
    // On a 2x2 layout every region:"chart" capture was pane 0, whatever
    // pane_focus said. It bit hardest with replay running on the active pane:
    // the image showed a live pane while the analysis was of a 2017 bar, and
    // both looked entirely reasonable.
    //
    // TradingView marks the focused pane with an `active` class. Prefer it,
    // fall back to the old selectors, and REPORT which one answered so a
    // caller can tell a targeted capture from a best-effort one.
    const bounds = await evaluateImpl(`
      (function() {
        var tries = [
          ['active_pane', '.chart-container.active'],
          ['active_widget', '[class*="chart-container"][class*="active"]'],
          ['first_pane_canvas', '[data-name="pane-canvas"]'],
          ['first_chart_container', '[class*="chart-container"]'],
          ['first_canvas', 'canvas']
        ];
        var panes = document.querySelectorAll('[class*="chart-container"]');
        for (var i = 0; i < tries.length; i++) {
          var el = document.querySelector(tries[i][1]);
          if (!el) continue;
          var rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) continue;
          return {
            x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            how: tries[i][0], pane_count: panes.length
          };
        }
        return null;
      })()
    `);
    if (bounds) {
      clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
      paneSelected = { how: bounds.how, pane_count: bounds.pane_count };
    }
  } else if (region === 'strategy_tester') {
    const bounds = await evaluateImpl(`
      (function() {
        var el = document.querySelector('[data-name="backtesting"]')
          || document.querySelector('[class*="strategyReport"]');
        if (!el) return null;
        var rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })()
    `);
    if (bounds) clip = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scale: 1 };
  }

  const params = { format: 'png' };
  if (clip) params.clip = clip;

  const { data } = await client.Page.captureScreenshot(params);
  writeFileSyncImpl(filePath, Buffer.from(data, 'base64'));

  return {
    success: true, method: 'cdp', file_path: filePath, region,
    size_bytes: Buffer.from(data, 'base64').length,
    visibility,
    ...(paneSelected
      ? {
        pane_selected_by: paneSelected.how,
        pane_count: paneSelected.pane_count,
        // Say it plainly rather than let a caller assume the focused pane.
        ...(paneSelected.how.startsWith('first_') && paneSelected.pane_count > 1
          ? { warning: `No active pane could be identified, so this is the FIRST of ${paneSelected.pane_count} panes, which may not be the focused one.` }
          : {}),
      }
      : {}),
  };
}
