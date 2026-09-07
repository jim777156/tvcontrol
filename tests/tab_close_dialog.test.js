/**
 * tab_close and the unsaved-changes dialog (issue #6).
 *
 * The dialog is its own CDP page target: not in the chart DOM, not in the
 * tab-strip shell, invisible to [role=dialog] and friends. It BLOCKS the close,
 * and tab_close reported "The close was clicked but the tab count did not drop
 * (2 -> 2)" - accurate, and completely misleading. It reads like a selector or
 * window-scoping problem, and cost the reporter most of a session concluding
 * tab_close could not reach tabs in a second Desktop window.
 *
 * Run: node --test tests/tab_close_dialog.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeTab, _findUnsavedDialog, DISCARD_BUTTON, SAVE_BUTTON } from '../src/core/tab.js';

const DIALOG_TEXT = 'Close tab? There are unsaved changes on your chart layout. '
  + 'You will lose them if you close the tab. Save and close Close without saving';
const DIALOG_BUTTONS = [SAVE_BUTTON, DIALOG_TEXT.includes('x') ? DISCARD_BUTTON : DISCARD_BUTTON, 'close-dialog-window'];

/**
 * A Desktop with two tabs where the close is blocked by the dialog until
 * "Close without saving" is clicked.
 */
function desktop({ blocked = true, dialogPresent = true } = {}) {
  const clicks = [];
  let tabs = ['TCTide', 'Scratch'];
  let stillBlocked = blocked;
  return {
    clicks,
    tabs: () => tabs,
    _deps: {
      withShell: async (fn) => fn(async (js) => {
        if (js.includes('close.click')) {
          if (!stillBlocked) tabs = tabs.filter((t) => t !== 'Scratch');
          return true;
        }
        const out = { count: tabs.length, labels: [...tabs] };
        if (js.includes('active_index')) {
          out.active_index = tabs.indexOf('Scratch');
        }
        return out;
      }),
      targets: async () => ([
        { id: 'chart-1', type: 'page' },
        { id: 'dialog-1', type: 'page' },
        { id: 'worker-1', type: 'service_worker' },
      ]),
      withTarget: async (id, fn) => fn(async (js) => {
        if (js.includes('innerText')) {
          return id === 'dialog-1' && dialogPresent
            ? { text: DIALOG_TEXT, buttons: DIALOG_BUTTONS }
            : { text: 'a normal page', buttons: [] };
        }
        const want = /want = "([^"]*)"/.exec(js)?.[1];
        clicks.push({ target: id, button: want });
        if (want === DISCARD_BUTTON) {
          stillBlocked = false;
          tabs = tabs.filter((t) => t !== 'Scratch');
          return true;
        }
        return want === 'close-dialog-window';
      }),
    },
  };
}

describe('_findUnsavedDialog searches the other page targets', () => {
  it('finds the dialog by its text, on its own target', async () => {
    const found = await _findUnsavedDialog({
      targets: [{ id: 'a', type: 'page' }, { id: 'b', type: 'page' }],
      withTarget: async (id, fn) => fn(async () => (id === 'b'
        ? { text: DIALOG_TEXT, buttons: DIALOG_BUTTONS }
        : { text: 'chart', buttons: [] })),
    });
    assert.equal(found.target_id, 'b');
    assert.deepEqual(found.buttons, DIALOG_BUTTONS);
  });

  it('ignores non-page targets and targets it cannot attach to', async () => {
    const found = await _findUnsavedDialog({
      targets: [{ id: 'w', type: 'service_worker' }, { id: 'dead', type: 'page' }],
      withTarget: async (id) => { if (id === 'dead') throw new Error('cannot attach'); return { text: DIALOG_TEXT }; },
    });
    assert.equal(found, null, 'a target we cannot read is not evidence of a dialog');
  });

  it('returns null when no dialog is open', async () => {
    const found = await _findUnsavedDialog({
      targets: [{ id: 'a', type: 'page' }],
      withTarget: async (_id, fn) => fn(async () => ({ text: 'just a chart', buttons: [] })),
    });
    assert.equal(found, null);
  });
});

describe('tab_close names the dialog instead of blaming the tab count (#6)', () => {
  it('refuses with the real reason, not "the tab count did not drop"', async () => {
    const d = desktop();
    await assert.rejects(
      () => closeTab({ _deps: d._deps }),
      (err) => {
        assert.match(err.message, /has unsaved layout changes/);
        assert.doesNotMatch(err.message, /tab count did not drop/);
        return true;
      },
    );
  });

  it('dismisses the dialog so the chart is not left blocked, and says nothing was lost', async () => {
    const d = desktop();
    await assert.rejects(() => closeTab({ _deps: d._deps }), /nothing was saved or lost/);
    assert.deepEqual(
      d.clicks.map((c) => c.button),
      ['close-dialog-window'],
      'dismissing is the only click allowed without an explicit decision',
    );
  });

  it('NEVER clicks "Save and close" on its own', async () => {
    // Saving is a decision about the operator's layout, not a way past a modal.
    const d = desktop();
    await assert.rejects(() => closeTab({ _deps: d._deps }));
    await assert.rejects(() => closeTab({ _deps: d._deps }));
    assert.ok(!d.clicks.some((c) => c.button === SAVE_BUTTON));
  });

  it('discard_unsaved:true answers with "Close without saving" and the tab really goes', async () => {
    const d = desktop();
    const out = await closeTab({ discard_unsaved: true, _deps: d._deps });
    assert.equal(out.success, true);
    assert.equal(out.closed, 'Scratch');
    assert.equal(out.tabs_after, 1);
    assert.ok(d.clicks.some((c) => c.button === DISCARD_BUTTON));
    assert.ok(!d.clicks.some((c) => c.button === SAVE_BUTTON));
  });

  it('still reports a plain count failure when there is no dialog to blame', async () => {
    // Negative control: the dialog explanation must not become the answer to
    // every failed close.
    const d = desktop({ dialogPresent: false });
    await assert.rejects(() => closeTab({ _deps: d._deps }), /tab count did not drop/);
  });

  it('closes normally, with no dialog lookup needed, when the layout is clean', async () => {
    const d = desktop({ blocked: false });
    const out = await closeTab({ _deps: d._deps });
    assert.equal(out.success, true);
    assert.deepEqual(d.clicks, [], 'a clean close must not touch any dialog');
  });
});
