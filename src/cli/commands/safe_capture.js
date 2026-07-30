import { register } from '../router.js';
import * as core from '../../core/safe_capture.js';

register('capture-safe', {
  description: 'Isolated capture: read state, apply capture config, capture, revert, close connection',
  options: {
    symbol: { type: 'string', short: 's', description: 'Symbol to capture (omit to use whatever is currently loaded)' },
    timeframe: { type: 'string', short: 't', description: 'Timeframe (default D)' },
    months: { type: 'string', short: 'm', description: 'Months of visible history (default 6)' },
    add: { type: 'string', description: 'Comma-separated indicator names to add (default "Visible Range Volume Profile")' },
    remove: { type: 'string', description: 'Comma-separated indicator names to remove (default "Relative Strength Index")' },
    region: { type: 'string', short: 'r', description: 'Capture region (default chart)' },
    output: { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
  },
  handler: (opts) => core.captureIsolated({
    symbol: opts.symbol,
    timeframe: opts.timeframe || 'D',
    monthsBack: opts.months ? Number(opts.months) : 6,
    addIndicatorNames: opts.add ? opts.add.split(',').map((s) => s.trim()) : undefined,
    removeIndicatorNames: opts.remove ? opts.remove.split(',').map((s) => s.trim()) : undefined,
    region: opts.region || 'chart',
    filename: opts.output,
  }),
});
