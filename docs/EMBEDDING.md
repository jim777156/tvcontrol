# Embedding tvcontrol in a host application

This is the spawn contract for anyone bundling the MCP server inside a desktop app
(Wayland Desktop, an Electron host, an IDE extension). Getting it wrong produces
`MCP error -32000: Connection closed` with no usable diagnostic, because a server that
dies before its first JSON-RPC frame has no channel to explain itself on.

## The contract, in one line

Spawn **your own runtime binary** with an **absolute path** to `src/server.js`:

```js
const { spawn } = require('node:child_process');
const path = require('node:path');

const server = spawn(
  process.execPath,                                   // the Node/Electron binary you already ship
  [path.join(APP_RESOURCES, 'bundled-tvcontrol',
             'node_modules', '@ferroxlabs', 'tvcontrol', 'src', 'server.js')],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },  // Electron hosts only
  },
);
```

That is the whole fix for the two failure modes below. Everything else here explains why.

## Do not spawn the `tvcontrol` bin by name

`bin.tvcontrol` exists for `npx` and for hand-written MCP configs. It is the wrong entry
point for a bundled host, on both platforms:

- **POSIX.** The installed bin is a symlink to `src/server.js`, whose shebang is
  `#!/usr/bin/env node`. If you spawn it with a scrubbed environment, `env` searches the
  PATH *you* passed. Measured: `env -i HOME=... PATH=/usr/bin:/bin tvcontrol` exits **127**
  with `env: node: No such file or directory`. Node installed through nvm, fnm, volta or
  asdf is never on a bare PATH, and that is the common case on a developer machine.
- **Windows.** npm generates a `.cmd` shim that calls bare `node`, taking the interpreter
  from the shebang (`cmd-shim` reads it verbatim). Same dependency, same failure, and the
  shim swallows the reason.

The server cannot fix this from inside the package. The kernel resolves the shebang before
a single line of our code runs, and changing that shebang to a shell that self-locates node
would make the Windows `.cmd` shim invoke `sh`, which is worse. **The host holds the only
runtime it can be sure exists: its own.** Use it.

## Do not install into a directory the app cannot enumerate

Under `C:\Program Files\`, ACLs and Defender's Controlled Folder Access deny directory
**enumeration** to a non-elevated process while still allowing a known file to be opened.
Through 2.4.7 the server scanned its own `src/tools/` at module load and died on `EPERM`
before the MCP object existed. Every affected user saw only `-32000: Connection closed`.

**Fixed in 2.4.8**: both startup reads fail soft, the server falls back to the catalog
generated at publish time, and it reports the degradation on stderr. Require **>= 2.4.8**
for any Program Files install. You can confirm a session is not degraded by calling
`tv_capability_matrix` and checking `catalog_source` is `"scan"`, not `"fallback"`.

Preferring a per-user writable location (`%LOCALAPPDATA%`) still avoids the whole class.

## stdout is the protocol channel

Nothing but JSON-RPC frames may reach stdout. The server writes its disclaimer, its
warnings and every diagnostic to **stderr**, and a test asserts zero non-JSON lines on
stdout. If you wrap the spawn, keep that separation: one stray line of log text on stdout
closes the connection for the client.

## Environment

- `ELECTRON_RUN_AS_NODE=1` is **required** when `process.execPath` is Electron, or the
  binary boots your app instead of the script.
- `TV_MCP_TELEMETRY=0` disables local telemetry.
- `TV_MCP_READONLY=1` registers only the tools that cannot mutate the user's TradingView
  account. Mutating tools are absent from `tools/list`, not merely refused.
- `TV_MCP_ADVANCED=1` registers `ui_evaluate` (arbitrary page JS). Off by default.

Do **not** scrub the environment on the assumption it makes the spawn hermetic. It does
the opposite here: it removes the PATH the shebang needs. Pass `process.env` through, and
if you must restrict it, use `process.execPath` as above so PATH stops mattering.

## Verifying an embed

Drive one handshake and check three things: the process stays alive, `tools/list` returns
the full catalog, and stdout carried nothing but JSON.

```
initialize -> notifications/initialized -> tools/list
```

Expect `serverInfo.version` to match the version you bundled and 112 tools on 2.4.8.
A count that is short by one usually means `ui_evaluate` is correctly gated, not a fault.
