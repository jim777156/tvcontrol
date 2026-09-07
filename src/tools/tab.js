import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  server.tool('tab_list', 'List all open TradingView chart tabs', {}, async () => {
    try { return jsonResult(await core.list()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tab_new', 'Open a new TradingView tab, optionally loading a saved layout', {
    layout: z.string().optional().describe('Saved layout name or "new" for a blank chart'),
    name: z.string().optional().describe('Symbol name to enter when layout is "new"'),
  }, async ({ layout, name }) => {
    try { return jsonResult(await core.newTab({ layout, name })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tab_close', 'Close the currently active chart tab. Names the tab it is about to close and refuses when no tab is marked active. Closing a chart tab cannot be undone through this API, so pass expect_title when it matters which one goes.', {
    expect_title: z.string().optional().describe('The active tab title must contain this, otherwise nothing is closed. Use tab_list first to see the titles.'),
    discard_unsaved: z.coerce.boolean().optional().describe('Answer TradingView unsaved-layout-changes dialog with "Close without saving" and LOSE those changes. Without this the tab stays open and the dialog is dismissed. "Save and close" is never clicked for you.'),
  }, async ({ expect_title, discard_unsaved }) => {
    try { return jsonResult(await core.closeTab({ expect_title, discard_unsaved })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  }, async ({ index }) => {
    try { return jsonResult(await core.switchTab({ index })); }
    catch (err) { return errorResult(err); }
  });
}
