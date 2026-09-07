import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor. Refuses to overwrite a buffer holding real content unless confirm_overwrite is set.', {
    source: z.string().describe('Pine Script source code to inject'),
    confirm_overwrite: z.coerce.boolean().optional().default(false).describe('Required when the editor already holds real content. Read it with pine_get_source first.'),
  }, async ({ source, confirm_overwrite }) => {
    try { return jsonResult(await core.setSource({ source, confirm_overwrite })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_compile', 'Compile the current Pine Script and add it to the chart. WARNING: this SAVES first, clicking Save and add to chart, which persists the current editor buffer to the saved script it is bound to.', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_save', 'Save the current Pine Script buffer to the saved script the editor is bound to. WARNING: this persists to the cloud and overwrites that script. Verified by reading the editor Save/Saved state; an unverified save is never reported as success.', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes WARNING: like pine_compile this SAVES the current buffer to the bound saved script before compiling.', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_new', 'Replace the Pine editor buffer with a blank template. WARNING: this does NOT create a new saved script. It overwrites whatever script the editor currently has open, and a following pine_save or pine_compile persists that overwrite to the cloud. It refuses to run when the buffer holds real content unless confirm_overwrite is set.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Template to write into the editor'),
    confirm_overwrite: z.coerce.boolean().optional().default(false).describe('Required when the editor already holds real content. Read it with pine_get_source first.'),
  }, async ({ type, confirm_overwrite }) => {
    try { return jsonResult(await core.newScript({ type, confirm_overwrite })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_open', 'Load a saved Pine Script into the editor buffer. THIS REPLACES THE BUFFER and does not guarantee the editor is bound to that script - check `binding_verified` before any pine_save. To READ a script with no buffer risk, use pine_get_script_source instead.', {
    name: z.string().describe('Name of the saved script to open (case-insensitive; exact name or title wins, an ambiguous substring is refused with candidates)'),
    confirm_overwrite: z.boolean().optional().describe('Required to replace a buffer that holds real work. Without it the call is refused rather than destroying unsaved code, same as pine_new and pine_set_source.'),
  }, async ({ name, confirm_overwrite }) => {
    try { return jsonResult(await core.openScript({ name, confirm_overwrite })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_get_script_source', 'Read a saved Pine Script\'s source over the REST API WITHOUT touching the editor buffer. Use this to compare a saved script against a local file or audit what is deployed - it cannot destroy unsaved work and cannot mis-bind the editor.', {
    name: z.string().describe('Name of the saved script (case-insensitive; an ambiguous substring is refused with candidates)'),
  }, async ({ name }) => {
    try { return jsonResult(await core.getScriptSource({ name })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts. Returns a page, not the whole library — pass name_filter to find one by name.', {
    name_filter: z.string().optional().describe('Case-insensitive substring match on script name/title. Use this when you know roughly what you are looking for.'),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50).describe('Max scripts to return (default 50, max 200)'),
    offset: z.coerce.number().int().min(0).optional().default(0).describe('Skip this many matches, for paging'),
  }, async ({ name_filter, limit, offset }) => {
    try { return jsonResult(await core.listScripts({ name_filter, limit, offset })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return errorResult(err); }
  });
}
