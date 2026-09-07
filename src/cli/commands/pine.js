import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
        confirm_overwrite: { type: 'boolean', description: 'Required to replace a buffer holding real work. The refusal hint names this flag.' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        _arg(source, 'No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source, confirm_overwrite: opts.confirm_overwrite });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      handler: () => core.smartCompile(),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      handler: () => core.compile(),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        _arg(source, 'No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        _arg(source, 'No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      handler: () => core.save(),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      usage: '[indicator|strategy|library]',
      options: {
        confirm_overwrite: { type: 'boolean', description: 'Required to replace a buffer holding real work. The refusal hint names this flag.' },
      },
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type, confirm_overwrite: opts.confirm_overwrite });
      },
    }],
    ['open', {
      description: 'Load a saved Pine Script into the editor buffer. Check binding_verified before saving; use "tv pine source" to read one safely.',
      usage: '<script_name>',
      options: {
        confirm_overwrite: { type: 'boolean', description: 'Required to replace a buffer holding real work' },
      },
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' '), confirm_overwrite: opts.confirm_overwrite });
      },
    }],
    ['source', {
      description: 'Read a saved Pine Script WITHOUT touching the editor buffer',
      usage: '<script_name>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Script name required. Usage: tv pine source "My Script"');
        return core.getScriptSource({ name: positionals.join(' ') });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      // listScripts pages at 50 now. Without these flags the CLI could not
      // reach script 51, and next_offset was advice it had no way to take.
      options: {
        filter: { type: 'string', description: 'Only scripts whose name or title contains this text' },
        limit: { type: 'string', description: 'Maximum scripts to return (1-200; default 50)' },
        offset: { type: 'string', description: 'Pagination offset' },
      },
      handler: (opts) => core.listScripts({
        name_filter: opts.filter,
        ...(opts.limit != null ? { limit: Number(opts.limit) } : {}),
        ...(opts.offset != null ? { offset: Number(opts.offset) } : {}),
      }),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
