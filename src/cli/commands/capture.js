import { register } from '../router.js';
import * as core from '../../core/capture.js';

register('screenshot', {
  description: 'Take a screenshot of the chart',
  options: {
    region: { type: 'string', short: 'r', description: 'Region: full, chart, strategy_tester' },
    output: { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
    wait_for_render: { type: 'boolean', description: 'Wait for the chart canvas to stabilize before capture' },
    allow_hidden: { type: 'boolean', description: 'Capture even when the tab is hidden. The image may be a stale frame.' },
  },
  handler: (opts) => core.captureScreenshot({
    region: opts.region,
    filename: opts.output,
    wait_for_render: opts.wait_for_render,
    allow_hidden: opts.allow_hidden,
  }),
});
