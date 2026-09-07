import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  server.tool('capture_screenshot', 'Take a screenshot of the TradingView chart. REFUSES on a hidden tab, because a hidden tab returns the last frame it painted - a real PNG of the right chart showing stale data. region:"chart" captures the ACTIVE pane and reports which selector found it.', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full). "chart" targets the focused pane.'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    wait_for_render: z.coerce.boolean().optional().describe('Wait for the chart canvas to stabilize before capture'),
    allow_hidden: z.coerce.boolean().optional().describe('Capture even when the tab is hidden. The image may be a stale frame: only pass this if you have accepted that.'),
  }, async ({ region, filename, method, wait_for_render, allow_hidden }) => {
    try { return jsonResult(await core.captureScreenshot({ region, filename, method, wait_for_render, allow_hidden })); }
    catch (err) { return errorResult(err); }
  });
}
