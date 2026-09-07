import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new tab, optionally loading a saved layout',
      options: {
        layout: { type: 'string', short: 'l', description: 'Saved layout name or "new"' },
        name: { type: 'string', short: 'n', description: 'Symbol name when layout is "new"' },
      },
      handler: (opts) => core.newTab({ layout: opts.layout, name: opts.name }),
    }],
    ['close', {
      description: 'Close the current tab',
      options: {
        expect_title: { type: 'string', short: 't', description: 'Refuse unless the active tab title contains this. Closing a chart tab cannot be undone.' },
        discard_unsaved: { type: 'boolean', description: 'Answer the unsaved-layout dialog with "Close without saving" and LOSE those changes' },
      },
      handler: (opts) => core.closeTab({ expect_title: opts.expect_title, discard_unsaved: opts.discard_unsaved }),
    }],
    ['switch', {
      description: 'Switch to a tab by index',
      usage: '<index>',
      handler: (opts, positionals) => {
        _arg(positionals[0] !== undefined, 'Index required. Usage: tv tab switch 0');
        return core.switchTab({ index: positionals[0] });
      },
    }],
  ]),
});
