import { register } from '../router.js';
import * as core from '../../core/safe_capture.js';

register('capture-safe', {
  description: 'Isolated capture: read state, apply capture config, capture, revert, close connection',
  options: {
    symbol: { type: 'string', short: 's', description: 'Symbol to capture (omit to use whatever is currently loaded)' },
    timeframe: { type: 'string', short: 't', description: 'Timeframe (default D)' },
    months: { type: 'string', short: 'm', description: 'Months of visible history (default 6); ignored if --from/--to are both given' },
    from: { type: 'string', description: 'Explicit visible-range start, epoch seconds (requires --to; overrides --months)' },
    to: { type: 'string', description: 'Explicit visible-range end, epoch seconds (requires --from; overrides --months)' },
    add: { type: 'string', description: 'Comma-separated indicator names to add (default "Visible Range Volume Profile")' },
    remove: { type: 'string', description: 'Comma-separated indicator names to remove (default "Relative Strength Index")' },
    'add-inputs': { type: 'string', description: 'JSON object mapping an added indicator name to its input overrides, e.g. \'{"Fixed Range Volume Profile": {"first_bar_time": 1700000000000}}\'' },
    region: { type: 'string', short: 'r', description: 'Capture region (default chart)' },
    output: { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
  },
  handler: (opts) => core.captureIsolated({
    symbol: opts.symbol,
    timeframe: opts.timeframe || 'D',
    monthsBack: opts.months ? Number(opts.months) : 6,
    fromTime: opts.from ? Number(opts.from) : undefined,
    toTime: opts.to ? Number(opts.to) : undefined,
    addIndicatorNames: opts.add ? opts.add.split(',').map((s) => s.trim()) : undefined,
    removeIndicatorNames: opts.remove ? opts.remove.split(',').map((s) => s.trim()) : undefined,
    addIndicatorInputs: opts['add-inputs'] ? JSON.parse(opts['add-inputs']) : undefined,
    region: opts.region || 'chart',
    filename: opts.output,
  }),
});
