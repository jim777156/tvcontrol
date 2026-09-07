/**
 * THE EMBEDDING CONTRACT — docs/EMBEDDING.md is shipped, correct, and honest.
 *
 * Two failure modes killed real embeds and neither could report itself, because
 * both happen before the server's first JSON-RPC frame:
 *   - EPERM enumerating src/tools under C:\Program Files\ (fixed in 2.4.8)
 *   - exit 127, `env: node: No such file or directory`, when a host spawns the
 *     `tvcontrol` bin with a scrubbed PATH. That one CANNOT be fixed inside the
 *     package: the kernel resolves `#!/usr/bin/env node` before our code runs,
 *     and pointing the shebang at a shell that self-locates node would make
 *     npm's Windows .cmd shim invoke `sh` (cmd-shim reads the shebang verbatim).
 *     The host must spawn process.execPath. That instruction is the deliverable,
 *     so these tests treat it as one.
 *
 * Run: node --test tests/embedding_contract.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('docs/EMBEDDING.md', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'EMBEDDING.md'), 'utf8');

  it('is actually shipped in the tarball', () => {
    // A contract that only exists in the repo is not a contract with a host
    // author, who has an installed package and no checkout.
    assert.ok(pkg.files.includes('docs/EMBEDDING.md'),
      'docs/EMBEDDING.md is missing from package.json files — host authors will never see it');
  });

  it('names process.execPath as the runtime to spawn', () => {
    assert.match(doc, /process\.execPath/,
      'the one instruction that removes the PATH class must be in the document');
  });

  it('names the entry point that npx and Wayland resolve', () => {
    assert.match(doc, /src\/server\.js/);
    assert.equal(pkg.bin.tvcontrol, 'src/server.js',
      'the document points at src/server.js; bin.tvcontrol must agree');
  });

  it('states the exit code and message a host author will actually see', () => {
    // Without the literal string, nobody searching their own logs finds this page.
    assert.match(doc, /127/);
    assert.match(doc, /env: node: No such file or directory/);
  });

  it('states the minimum version for a Program Files install', () => {
    // 2.4.8 is the release where the startup reads stopped being fatal. A doc
    // that omits it sends someone to install 2.4.6 into the directory that
    // breaks it.
    assert.match(doc, />=\s*2\.4\.8/);
  });

  it('says stdout is the protocol channel', () => {
    assert.match(doc, /stdout/);
    assert.match(doc, /stderr/);
  });
});

describe('examples/mcp-config.example.json', () => {
  const raw = readFileSync(join(ROOT, 'examples', 'mcp-config.example.json'), 'utf8');

  it('is valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  it('points every server entry at the MCP server, not the human CLI', () => {
    // Pointing a host at src/cli/index.js puts a usage block on the protocol
    // channel and the client sees a parse failure, not a wrong tool.
    const config = JSON.parse(raw);
    const entries = Object.entries(config.mcpServers);
    assert.ok(entries.length >= 1);
    for (const [name, entry] of entries) {
      assert.ok(entry.args?.[0]?.endsWith('src/server.js'),
        `${name} does not spawn src/server.js`);
    }
  });

  it('offers an absolute-node variant for hosts without node on PATH', () => {
    const config = JSON.parse(raw);
    const absolute = Object.values(config.mcpServers).filter((entry) => entry.command !== 'node');
    assert.ok(absolute.length >= 1,
      'every example says `node`, which is the exact assumption that exits 127');
  });
});
