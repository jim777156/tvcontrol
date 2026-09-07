import { register } from '../router.js';
import { _arg } from '../_arg.js';
import * as core from '../../core/replay.js';

register('replay', {
  description: 'Replay mode controls',
  subcommands: new Map([
    ['start', {
      description: 'Start replay mode',
      options: {
        date: { type: 'string', short: 'd', description: 'Start date (YYYY-MM-DD)' },
        allow_relocation: { type: 'boolean', description: 'Accept a cursor TradingView moved because the date is outside replay depth for this symbol/timeframe' },
      },
      handler: (opts) => core.start({ date: opts.date, allow_relocation: opts.allow_relocation }),
    }],
    ['step', {
      description: 'Advance one bar in replay',
      handler: () => core.step(),
    }],
    ['stop', {
      description: 'Stop replay and return to realtime',
      handler: () => core.stop(),
    }],
    ['status', {
      description: 'Get current replay state',
      handler: () => core.status(),
    }],
    ['autoplay', {
      description: 'Turn autoplay on or off in replay mode. Pass --enabled/--no-enabled to say which state you want; omit it to flip.',
      options: {
        speed: { type: 'string', short: 's', description: 'Autoplay delay in ms (lower = faster)' },
        enabled: { type: 'boolean', description: 'Target state. Without it this only toggles, so "turn autoplay off" is a guess about the current state.' },
      },
      handler: (opts) => core.autoplay({
        speed: opts.speed ? Number(opts.speed) : undefined,
        enabled: opts.enabled,
      }),
    }],
    ['trade', {
      description: 'Execute a trade in replay mode (buy, sell, close)',
      usage: '<buy|sell|close>',
      handler: (opts, positionals) => {
        _arg(positionals[0], 'Action required. Usage: tv replay trade buy');
        return core.trade({ action: positionals[0] });
      },
    }],
  ]),
});
