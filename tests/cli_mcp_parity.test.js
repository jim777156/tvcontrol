/**
 * CLI/MCP parity for the SAFETY GUARDS (issue #9).
 *
 * The reporter diffed every CLI subcommand against the zod schema of the MCP
 * tool it calls. Most apparent gaps were positional arguments or renamed flags.
 * What survived had a pattern worth naming: three of the six were the guards on
 * the most destructive operations, and they were unreachable from the CLI.
 *
 * The worst shape was a hint that named a flag the CLI did not have:
 * layout_switch refuses and says "pass discard_unsaved:true", and the CLI user
 * follows the hint into a dead end. So this is executed, not audited by hand:
 * both sides are read live and compared.
 *
 * Run: node --test tests/cli_mcp_parity.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _registeredCommands } from '../src/cli/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Guards, and the CLI path that must expose each one. A guard reachable only
 * from MCP is a decision the CLI user is not allowed to make.
 */
const GUARDS = [
  { param: 'expect_title', tool: 'tab_close', cli: ['tab', 'close'] },
  { param: 'discard_unsaved', tool: 'tab_close', cli: ['tab', 'close'] },
  { param: 'discard_unsaved', tool: 'layout_switch', cli: ['layout', 'switch'] },
  { param: 'confirm_overwrite', tool: 'pine_new', cli: ['pine', 'new'] },
  { param: 'confirm_overwrite', tool: 'pine_set_source', cli: ['pine', 'set'] },
  { param: 'confirm_overwrite', tool: 'pine_open', cli: ['pine', 'open'] },
  { param: 'enabled', tool: 'replay_autoplay', cli: ['replay', 'autoplay'] },
  { param: 'allow_relocation', tool: 'replay_start', cli: ['replay', 'start'] },
  { param: 'overwrite', tool: 'state_snapshot', cli: ['state', 'snapshot'] },
  { param: 'frequency', tool: 'alert_create', cli: ['alert', 'create'] },
  { param: 'resolution', tool: 'alert_create', cli: ['alert', 'create'] },
  { param: 'allow_hidden', tool: 'capture_screenshot', cli: ['screenshot'] },
];

let tools;
let commands;

before(async () => {
  // Load every CLI command module so the registry is populated the way the
  // real `tv` binary populates it.
  const dir = join(__dirname, '..', 'src', 'cli', 'commands');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    // pathToFileURL, not the bare path. On Windows a dynamic import of
    // `C:\\...\\file.js` throws ERR_UNSUPPORTED_ESM_URL_SCHEME, this before()
    // hook died, and all 14 tests came back `cancelledByParent` on both Windows
    // runners while passing everywhere else. CI caught it; my local macOS run
    // never could.
    await import(pathToFileURL(join(dir, file)).href);
  }
  commands = _registeredCommands();

  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const out = execFileSync(process.execPath, [join(__dirname, '..', 'src', 'server.js')], {
    input: msgs, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'],
  });
  tools = out.split('\n').filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).find((f) => f.id === 2)?.result?.tools;
});

function cliOptions(path) {
  const top = commands.get(path[0]);
  if (!top) return null;
  if (path.length === 1) return Object.keys(top.options || {});
  const sub = top.subcommands?.get(path[1]);
  if (!sub) return null;
  return Object.keys(sub.options || {});
}

describe('every safety guard on an MCP tool is reachable from the CLI', () => {
  for (const guard of GUARDS) {
    it(`${guard.tool}.${guard.param} is on \`tv ${guard.cli.join(' ')}\``, () => {
      const tool = tools.find((t) => t.name === guard.tool);
      assert.ok(tool, `${guard.tool} is not registered, so this mapping is stale`);
      assert.ok(
        Object.prototype.hasOwnProperty.call(tool.inputSchema.properties || {}, guard.param),
        `${guard.tool} no longer takes ${guard.param}; update this table rather than deleting the check`,
      );
      const options = cliOptions(guard.cli);
      assert.ok(options, `\`tv ${guard.cli.join(' ')}\` does not exist`);
      assert.ok(
        options.includes(guard.param),
        `\`tv ${guard.cli.join(' ')}\` cannot pass ${guard.param}. `
        + 'A refusal that hints at a flag the CLI does not have is a dead end, not a decision.',
      );
    });
  }

  it('covers every guard the table claims to, on a real tools/list', () => {
    // Negative control: if the boot silently returned nothing, every test above
    // would still pass on the `assert.ok(tool)` line being skipped.
    assert.ok(Array.isArray(tools) && tools.length > 100, 'the server returned no usable tool list');
    assert.ok(commands.size > 10, 'the CLI registry did not load');
  });
});

describe('the guards actually reach the core function', () => {
  it('every mapped CLI handler passes its guard through by name', () => {
    // An option declared but dropped on the floor is worse than a missing one:
    // the flag is accepted, the guard is not applied, and nothing says so.
    for (const guard of GUARDS) {
      const top = commands.get(guard.cli[0]);
      const entry = guard.cli.length === 1 ? top : top.subcommands.get(guard.cli[1]);
      const handler = String(entry.handler);
      assert.ok(
        handler.includes(guard.param),
        `\`tv ${guard.cli.join(' ')}\` declares ${guard.param} but its handler never reads it`,
      );
    }
  });
});
