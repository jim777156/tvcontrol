/**
 * pine_open: the binding, the buffer guard, and the ambiguity (issues #11, #10).
 *
 * #11 is the one that destroyed scripts. setValue() is a text mutation: it put
 * the target's source into whatever buffer was open and left the editor bound
 * to the PREVIOUS script, while returning {success: true, name: <target>}. A
 * following pine_save wrote the opened script's code over the previous one.
 *
 * The check that feels obvious - compare the buffer against a known copy of the
 * target - passes on the broken behaviour, because the text really is the
 * target's. It proves the fetch, not the binding. These tests assert on the
 * binding instead.
 *
 * Run: node --test tests/pine_open_binding.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openScript, getScriptSource } from '../src/core/pine.js';

const SOURCE_LINES = 515;

/** A page-side result as the injected evaluateAsync would return it. */
function pageResult(over = {}) {
  return {
    found: true,
    name: 'Trading-OS NQ HMM 5m Scorelab Ledger Replay v20260516',
    title: null,
    id: 'USER;2c7b8546b6ea45baa64952bdc10c5550',
    version: 3,
    lines: SOURCE_LINES,
    title_before: 'SuperTrend + Composite Squeeze 2TF',
    title_after: 'Trading-OS NQ HMM 5m Scorelab Ledger Replay v20260516',
    title_selector: '[data-name="scriptTitle"]',
    ...over,
  };
}

function deps(over = {}) {
  return {
    ensurePineEditorOpen: async () => true,
    assertBufferSafeToReplace: async () => ({ skipped: false }),
    evaluateAsync: async () => pageResult(),
    ...over,
  };
}

describe('pine_open guards the buffer before it touches anything (#10)', () => {
  it('refuses when the buffer holds real work, and never reaches the fetch', async () => {
    // Refusing AFTER the buffer is gone is not a guard. Assert the order, not
    // just the error: the page call must never happen.
    let fetched = false;
    await assert.rejects(
      () => openScript({
        name: 'anything',
        _deps: deps({
          assertBufferSafeToReplace: async () => { throw new Error('The Pine editor currently holds 785 lines'); },
          evaluateAsync: async () => { fetched = true; return pageResult(); },
        }),
      }),
      /785 lines/,
    );
    assert.equal(fetched, false, 'the buffer guard must run before the source is fetched or injected');
  });

  it('passes confirm_overwrite through to the same guard the siblings use', async () => {
    let seen;
    await openScript({
      name: 'x',
      confirm_overwrite: true,
      _deps: deps({ assertBufferSafeToReplace: async (confirm) => { seen = confirm; return { skipped: true }; } }),
    });
    assert.equal(seen, true);
  });

  it('names itself to the guard, so the refusal says which tool was refused', async () => {
    let what;
    await openScript({ name: 'x', _deps: deps({ assertBufferSafeToReplace: async (_c, w) => { what = w; return {}; } }) });
    assert.equal(what, 'pine_open');
  });
});

describe('pine_open reports the binding, not the fetch (#11)', () => {
  it('claims opened only when the panel title matches what was loaded', async () => {
    const out = await openScript({ name: 'Scorelab', _deps: deps() });
    assert.equal(out.opened, true);
    assert.equal(out.binding_verified, true);
    assert.equal(out.editor_bound_to, 'Trading-OS NQ HMM 5m Scorelab Ledger Replay v20260516');
    assert.equal(out.lines, SOURCE_LINES);
  });

  it('THROWS when the editor is still bound to the previous script', async () => {
    // The measured incident, exactly: title stays on SuperTrend, buffer holds
    // the other script. Reporting success here is what overwrote live work.
    await assert.rejects(
      () => openScript({
        name: 'Scorelab',
        _deps: deps({ evaluateAsync: async () => pageResult({ title_after: 'SuperTrend + Composite Squeeze 2TF' }) }),
      }),
      (err) => {
        assert.match(err.message, /still bound to "SuperTrend \+ Composite Squeeze 2TF"/);
        assert.match(err.message, /would write this code over that script/);
        return true;
      },
    );
  });

  it('does not throw when the title simply cannot be read, but refuses to claim opened', async () => {
    // A selector that moves in a future TradingView build must degrade to
    // "unknown", never to a confident wrong answer, and never to a tool that
    // stops working for everyone.
    const out = await openScript({
      name: 'Scorelab',
      _deps: deps({ evaluateAsync: async () => pageResult({ title_after: null, title_selector: null }) }),
    });
    assert.equal(out.opened, false);
    assert.equal(out.binding_verified, false);
    assert.equal(out.editor_bound_to, null);
    assert.match(out.warning, /NOT confirmed/);
    assert.match(out.hint, /pine_get_script_source/);
  });

  it('tolerates the modified-marker TradingView appends to a dirty title', async () => {
    const out = await openScript({
      name: 'Scorelab',
      _deps: deps({ evaluateAsync: async () => pageResult({ title_after: 'Trading-OS NQ HMM 5m Scorelab Ledger Replay v20260516 *' }) }),
    });
    assert.equal(out.opened, true);
  });

  it('accepts a title that matches the in-code title rather than the list name', async () => {
    // Measured on the reporting account: 20 of 53 scripts have a list name and
    // an in-code title that disagree. Either is a legitimate binding.
    const out = await openScript({
      name: 'Scorelab',
      _deps: deps({ evaluateAsync: async () => pageResult({ title: 'TV/TOS Parity Strategy', title_after: 'TV/TOS Parity Strategy' }) }),
    });
    assert.equal(out.opened, true);
  });
});

describe('an ambiguous name is reported, not resolved (#10)', () => {
  it('refuses when a substring hits more than one script, and names the candidates', async () => {
    const candidates = [
      { name: 'Scorelab A', title: 'Parity', script_id: 'USER;a' },
      { name: 'Scorelab B', title: 'Parity', script_id: 'USER;b' },
    ];
    await assert.rejects(
      () => openScript({
        name: 'scorelab',
        _deps: deps({
          evaluateAsync: async () => ({
            error: 'ambiguous: "scorelab" is a substring of 2 saved scripts',
            candidates,
            hint: 'Use pine_list_scripts with name_filter and pass a full name.',
          }),
        }),
      }),
      /ambiguous: "scorelab" is a substring of 2 saved scripts/,
    );
  });

  it('refuses when four saved scripts share one exact title', async () => {
    // The state the reporting account was actually in, caused by this same bug.
    await assert.rejects(
      () => openScript({
        name: 'parity strategy',
        _deps: deps({ evaluateAsync: async () => ({ error: 'ambiguous: 4 saved scripts match "parity strategy" exactly' }) }),
      }),
      /4 saved scripts match/,
    );
  });
});

describe('pine_get_script_source cannot touch the editor', () => {
  it('returns the source and says the editor was not touched', async () => {
    const out = await getScriptSource({
      name: 'Scorelab',
      _deps: {
        evaluateAsync: async () => ({
          found: true, name: 'Scorelab', title: null, id: 'USER;x', version: 2,
          lines: 3, source_code: '//@version=6\nindicator("X")\nplot(close)',
        }),
      },
    });
    assert.equal(out.editor_touched, false);
    assert.equal(out.source_code, '//@version=6\nindicator("X")\nplot(close)');
    assert.equal(out.script_id, 'USER;x');
  });

  it('generates a page script with no editor mutation in it at all', async () => {
    // The read-only claim is a claim about the code that runs in the page, so
    // assert on that code. A setValue reaching this path is the whole risk.
    let script = '';
    await getScriptSource({
      name: 'x',
      _deps: {
        evaluateAsync: async (js) => { script = js; return { found: true, name: 'x', id: 'y', version: 1, lines: 1, source_code: 'a' }; },
      },
    });
    assert.ok(!script.includes('setValue'), 'pine_get_script_source must never call editor.setValue');
    assert.ok(!script.includes('findMonacoEditor'), 'pine_get_script_source must not even look for the editor');
    assert.match(script, /pine-facade\/get\//, 'it still has to fetch the source');
  });

  it('refuses an ambiguous name rather than guessing', async () => {
    await assert.rejects(
      () => getScriptSource({ name: 'p', _deps: { evaluateAsync: async () => ({ error: 'ambiguous: "p" is a substring of 9 saved scripts' }) } }),
      /ambiguous/,
    );
  });
});

describe('the page-side lookup is EXECUTED, not described', () => {
  // Three tests in an earlier round of this project passed while asserting the
  // bug, because their mocks reimplemented the page logic instead of running
  // it. So run it: build the real generated script and evaluate it against a
  // stub fetch and a stub DOM.
  const SCRIPTS = [
    { scriptName: 'Scorelab Ledger Replay', scriptTitle: 'Parity Strategy', scriptIdPart: 'USER;a', version: 3 },
    { scriptName: 'Scorelab Ledger Replay v2', scriptTitle: 'Parity Strategy', scriptIdPart: 'USER;b', version: 1 },
    { scriptName: 'SuperTrend + Composite Squeeze 2TF', scriptTitle: 'SuperTrend', scriptIdPart: 'USER;c', version: 9 },
  ];

  async function runPageScript(name, { withSource = false, title = 'SuperTrend', scripts = SCRIPTS } = {}) {
    const { _findScriptScript } = await import('../src/core/pine.js');
    const js = _findScriptScript(name, withSource);
    const fetchStub = (url) => Promise.resolve({
      json: () => Promise.resolve(
        url.includes('/list/') ? scripts : { source: '//@version=6\nindicator("X")\nplot(close)' }
      ),
    });
    // A Monaco stand-in that satisfies FIND_MONACO's real fiber walk, so the
    // injection path executes rather than bailing out before the title read.
    const written = [];
    const editorStub = { getDomNode: () => monacoNode, setValue: (v) => written.push(v) };
    const monacoNode = {
      getBoundingClientRect: () => ({ width: 800, height: 600 }),
      contains: (n) => n === monacoNode,
      __reactFiber$stub: {
        memoizedProps: { value: { monacoEnv: { editor: { getEditors: () => [editorStub] } } } },
        return: null,
      },
    };
    const documentStub = {
      querySelector: (sel) => (sel === '[data-name="scriptTitle"]' && title !== null ? { textContent: title } : null),
      querySelectorAll: (sel) => (sel === '.monaco-editor.pine-editor-monaco' ? [monacoNode] : []),
    };
    documentStub.__written = written;
    const out = await new Function('fetch', 'document', `return (${js});`)(fetchStub, documentStub);
    return { ...out, __written: written };
  }

  it('takes an exact name match over two substring hits', async () => {
    const out = await runPageScript('supertrend + composite squeeze 2tf');
    assert.equal(out.error, undefined);
    assert.equal(out.id, 'USER;c');
  });

  it('refuses a substring that hits two scripts, and lists them', async () => {
    const out = await runPageScript('scorelab');
    assert.match(out.error, /ambiguous/);
    assert.equal(out.candidates.length, 2);
    assert.deepEqual(out.candidates.map((c) => c.script_id), ['USER;a', 'USER;b']);
  });

  it('refuses when the same exact title is shared by two saved scripts', async () => {
    const out = await runPageScript('parity strategy');
    assert.match(out.error, /2 saved scripts match .* exactly/);
  });

  it('reads the panel title back after injecting, from the real generated code', async () => {
    const out = await runPageScript('supertrend + composite squeeze 2tf', { title: 'SuperTrend' });
    assert.equal(out.title_after, 'SuperTrend');
    assert.equal(out.title_selector, '[data-name="scriptTitle"]');
  });

  it('reports a null title rather than inventing one when no selector matches', async () => {
    const out = await runPageScript('supertrend + composite squeeze 2tf', { title: null });
    assert.equal(out.title_after, null);
  });

  it('the withSource variant returns source_code and reads no title at all', async () => {
    const out = await runPageScript('supertrend + composite squeeze 2tf', { withSource: true });
    assert.match(out.source_code, /plot\(close\)/);
    assert.equal(out.title_after, undefined);
    assert.deepEqual(out.__written, [], 'the read-only path must not write to the editor');
  });

  it('the open path really does write the fetched source into the editor', async () => {
    // Negative control for the assertion above.
    const out = await runPageScript('supertrend + composite squeeze 2tf');
    assert.equal(out.__written.length, 1);
    assert.match(out.__written[0], /plot\(close\)/);
  });
});
