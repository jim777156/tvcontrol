/**
 * STARTUP RESILIENCE — the server must boot when it cannot read its own source.
 *
 * The incident, 2026-09-08: Windows users running the bundled server from
 * C:\Program Files\ got `-32000: Connection closed` and a stderr line reading
 * `EPERM reading ...\node_modules\@ferroxlabs\...`. Cause: src/server.js scanned
 * src/tools/ at module load to derive its own tool count. Program Files ACLs and
 * Defender's Controlled Folder Access deny directory ENUMERATION to a
 * non-elevated process while still allowing a known file to be opened — so the
 * readdirSync threw, at import time, before the MCP server object existed. There
 * was no protocol channel left to report the failure on, so the client saw a
 * dead pipe.
 *
 * chmod 0111 on a directory reproduces that exact asymmetry on POSIX: traversal
 * and known-path opens succeed, readdir throws EACCES. That is what the
 * end-to-end test below spawns against.
 *
 * Run: node --test tests/startup_resilience.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { discoverToolCatalog, discoverToolCatalogDetailed, getCapabilityMatrix } from '../src/core/capabilities.js';
import { FALLBACK_TOOL_CATALOG, FALLBACK_VERSION } from '../src/core/catalog_fallback.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const eperm = (path) => {
  const err = new Error(`EPERM: operation not permitted, scandir '${path}'`);
  err.code = 'EPERM';
  throw err;
};

describe('the generated fallback catalog cannot go stale', () => {
  it('matches what a live scan of src/tools finds', () => {
    // Without this, the fallback silently freezes at whatever the catalog was
    // on the day it was generated, and a Windows user gets a server missing
    // every tool added since. Regenerate: node scripts/gen_tool_catalog.js
    const scan = discoverToolCatalogDetailed();
    assert.equal(scan.source, 'scan', `the scan itself failed: ${scan.error}`);
    assert.deepEqual(
      [...FALLBACK_TOOL_CATALOG],
      scan.tools,
      'src/core/catalog_fallback.js is stale — run: node scripts/gen_tool_catalog.js'
    );
  });

  it('matches the version in package.json', () => {
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    assert.equal(
      FALLBACK_VERSION,
      version,
      'src/core/catalog_fallback.js is stale — run: node scripts/gen_tool_catalog.js'
    );
  });
});

describe('discoverToolCatalog degrades instead of throwing', () => {
  it('reports source "scan" when the directory is readable', () => {
    // Negative control. Without it, a function that ALWAYS returned the
    // fallback would satisfy every test below.
    const result = discoverToolCatalogDetailed();
    assert.equal(result.source, 'scan');
    assert.equal(result.error, null);
  });

  it('falls back when readdirSync throws EPERM', () => {
    const result = discoverToolCatalogDetailed({
      _deps: { readdirSync: () => eperm('C:\\Program Files\\Wayland\\resources\\bundled-tvcontrol') },
    });
    assert.equal(result.source, 'fallback');
    assert.match(result.error, /EPERM/);
    assert.deepEqual(result.tools, [...FALLBACK_TOOL_CATALOG]);
    assert.ok(result.tools.length > 100, 'a fallback that serves no tools is not a fallback');
  });

  it('falls back when a single file read throws EPERM mid-scan', () => {
    // Program Files can also deny the file itself. A half-read catalog would be
    // worse than the frozen one: it would look like tools had been removed.
    const result = discoverToolCatalogDetailed({
      _deps: {
        readdirSync: () => ['chart.js', 'health.js'],
        readFileSync: (path) => (String(path).endsWith('health.js') ? eperm(path) : 'server.tool("chart_get_state"'),
      },
    });
    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.tools, [...FALLBACK_TOOL_CATALOG]);
  });

  it('treats an empty scan as a failed read, not as a package with no tools', () => {
    const result = discoverToolCatalogDetailed({ _deps: { readdirSync: () => [] } });
    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.tools, [...FALLBACK_TOOL_CATALOG]);
  });

  it('keeps the array-returning signature its callers rely on', () => {
    const names = discoverToolCatalog({ _deps: { readdirSync: () => eperm('x') } });
    assert.ok(Array.isArray(names));
    assert.deepEqual(names, [...FALLBACK_TOOL_CATALOG]);
  });
});

describe('the capability matrix admits when it is running on the fallback', () => {
  it('says catalog_source: fallback and carries the error', async () => {
    const matrix = await getCapabilityMatrix({
      probe: false,
      _deps: { readdirSync: () => eperm('C:\\Program Files\\Wayland') },
    });
    assert.equal(matrix.catalog_source, 'fallback');
    assert.match(matrix.catalog_error, /EPERM/);
    assert.equal(matrix.tool_count, FALLBACK_TOOL_CATALOG.length);
  });

  it('says catalog_source: scan when it really scanned', async () => {
    const matrix = await getCapabilityMatrix({ probe: false });
    assert.equal(matrix.catalog_source, 'scan');
    assert.equal(matrix.catalog_error, undefined);
  });
});

/**
 * Spawn a server and drive initialize -> initialized -> tools/list, keeping
 * stdout and stderr apart. A fallback that works in a unit test but dies at
 * module load has fixed nothing, so this runs the real entrypoint.
 */
function handshake(serverPath, { cwd, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd,
      env: { TV_MCP_NO_CDP: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let buffer = '';
    const lines = [];
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error(`no tools/list within 30s; stderr: ${stderr.slice(0, 800)}`)), 30_000);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      err ? reject(err) : resolve(value);
    }
    function send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); }

    child.on('error', finish);
    child.on('exit', (code) => finish(
      new Error(`server exited with ${code} before answering; stderr: ${stderr.slice(0, 800)}`)));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        lines.push(line);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          finish(null, { response: msg, stderr, stdoutLines: lines, serverInfo: undefined });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'tvcontrol-tests', version: '1.0.0' } },
    });
    void stdout;
  });
}

/** A throwaway copy of the package, so a chmod can never touch the real tree. */
function stagePackage() {
  const dir = mkdtempSync(join(tmpdir(), 'tvcontrol-eperm-'));
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), readFileSync(join(ROOT, 'package.json')));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

describe('the real server boots when src/tools cannot be enumerated', () => {
  it('completes an MCP handshake and lists the full catalog anyway', async (t) => {
    const dir = stagePackage();
    const toolsDir = join(dir, 'src', 'tools');
    try {
      // 0111: traverse and open a known file, but no listing. The POSIX shape of
      // the Program Files ACL that killed the server.
      chmodSync(toolsDir, 0o111);
      try {
        readdirSync(toolsDir);
        chmodSync(toolsDir, 0o755);
        return t.skip('this process can list a 0111 directory (running as root?) — cannot reproduce the denial');
      } catch (err) {
        assert.ok(['EACCES', 'EPERM'].includes(err.code), `expected a permission denial, got ${err.code}`);
      }

      const { response, stderr, stdoutLines } = await handshake(join(dir, 'src', 'server.js'), { cwd: tmpdir() });

      assert.equal(response.error, undefined, `tools/list failed: ${JSON.stringify(response.error)}`);
      assert.equal(
        response.result.tools.length,
        FALLBACK_TOOL_CATALOG.length - 1,
        'the degraded server must still publish the whole catalog minus the gated tool'
      );
      assert.match(stderr, /cannot scan src\/tools/, 'the degradation must be reported on stderr');
      const junk = stdoutLines.filter((line) => { try { JSON.parse(line); return false; } catch { return true; } });
      assert.deepEqual(junk, [], 'the warning must go to stderr, never onto the protocol channel');
    } finally {
      chmodSync(toolsDir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not report a scan failure when the directory is readable', async () => {
    // Negative control for the assertion above: proves the chmod caused it, and
    // that the normal path is still the scan.
    const dir = stagePackage();
    try {
      const { response, stderr } = await handshake(join(dir, 'src', 'server.js'), { cwd: tmpdir() });
      assert.equal(response.error, undefined);
      assert.doesNotMatch(stderr, /cannot scan src\/tools/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
