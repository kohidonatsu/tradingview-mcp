/**
 * Safe, revert-guaranteed chart capture.
 *
 * The visual layer needs to point the chart at a specific symbol, auto-fit
 * the price scale, widen the visible range, and add/remove indicators
 * before capturing — but none of that may be left behind on the user's
 * real chart. This module reads the full current state first, applies the
 * capture configuration, captures, and reverts everything it touched,
 * wrapped in try/finally so a crash mid-capture still triggers the revert.
 * If revert itself can't fully undo everything, the original state is
 * written to disk (state_recovery/) and logged loudly rather than silently
 * left half-changed.
 *
 * Layout-switch isolation (core/ui.js::layoutSwitch, fixed 2026-07-30) is
 * the better long-term answer when a dedicated capture layout is used —
 * this module is the safety net that applies regardless of which chart
 * it's pointed at, including the user's own primary layout.
 */
import { evaluate, disconnect } from '../connection.js';
import * as chartCore from './chart.js';
import * as dataCore from './data.js';
import * as captureCore from './capture.js';
import * as indicatorsCore from './indicators.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECOVERY_DIR = join(dirname(dirname(__dirname)), 'state_recovery');

// ── Price scale (not exposed as a chart.js function — priceScale() lives
//    a few levels deeper than anything chart.js already reaches) ──────────

/**
 * Poll directly for the exact signal that distinguishes a chart that has
 * genuinely finished loading price data from one that merely isn't showing
 * a loading spinner (found 2026-08-01: wait.js's waitForChartReady — a DOM
 * heuristic checking for a loading spinner + stable [class*="bar"] element
 * count — reported "ready" while priceScale().priceRange() was still null
 * and the resulting screenshot was blank; a manual 8s sleep-then-check
 * confirmed priceRange() eventually becomes non-null once real data has
 * loaded, so poll that directly instead of trusting the DOM heuristic).
 */
async function waitForPriceRangeReady(timeoutMs = 15000, pollMs = 300) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var pr = chart._chartWidget.model().mainSeries().priceScale().priceRange();
          return !!pr;
        } catch (e) {
          return false;
        }
      })()
    `);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false; // caller decides whether to proceed anyway or surface a clear error
}

async function readPriceScale() {
  // Stashes the live PriceRange instance's own constructor on a page
  // global so restorePriceScale can build a new instance later that
  // passes setPriceRange's internal type check (a plain duck-typed
  // {minValue(),maxValue()} object is rejected — verified 2026-07-30).
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var ps = chart._chartWidget.model().mainSeries().priceScale();
      var pr = ps.priceRange();
      if (!pr) {
        throw new Error('priceScale().priceRange() is null — chart is still loading; call waitForPriceRangeReady() first');
      }
      window.__tvscoutPriceRangeCtor = pr.constructor;
      return { isAutoScale: ps.isAutoScale(), min: pr.minValue(), max: pr.maxValue() };
    })()
  `);
}

async function resetScaleAutoFit() {
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      chart._chartWidget.model().mainSeries().priceScale().resetScale();
      return true;
    })()
  `);
}

async function restorePriceScale(state) {
  if (!state) return { ok: false, error: 'no price-scale state to restore' };
  if (state.isAutoScale) {
    await resetScaleAutoFit();
    return { ok: true, mode: 'auto' };
  }
  // Fixed 2026-07-30: setPriceRange() alone does NOT turn off auto-scale —
  // verified directly: called with isAutoScale still true, the manual
  // range visibly applied for well under a second and then silently
  // reverted to the auto-computed range on the next recalculation pass.
  // The actual toggle lives on the scale's *properties* tree
  // (ps.properties().autoScale, a WatchedValue-style property with its
  // own .setValue()), not on the PriceScale object itself — it must be
  // set to false BEFORE setPriceRange or the manual range never sticks.
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var ps = chart._chartWidget.model().mainSeries().priceScale();
      if (!window.__tvscoutPriceRangeCtor) return { ok: false, error: 'price-range constructor reference lost' };
      ps.properties().autoScale.setValue(false);
      var range = new window.__tvscoutPriceRangeCtor(${state.min}, ${state.max});
      ps.setPriceRange(range);
      return { ok: true, mode: 'manual', isAutoScaleNow: ps.isAutoScale() };
    })()
  `);
}

// Study-identity metadata captured alongside real parameters by
// getIndicator() — these describe WHICH indicator it is, not a tunable
// setting, and must never be sent back through setInputs (see the
// createStudy note below for why this distinction matters here).
const _META_INPUT_KEYS = new Set(['pineId', 'pineVersion', 'pineFeatures']);

function inputsArrayToObject(inputs) {
  if (!Array.isArray(inputs)) return undefined;
  const obj = {};
  for (const { id, value } of inputs) {
    if (_META_INPUT_KEYS.has(id)) continue;
    obj[id] = value;
  }
  return Object.keys(obj).length > 0 ? obj : undefined;
}

// ── Chart-grid guard ────────────────────────────────────────────────────

/**
 * The capture region crop (core/capture.js, region=chart) selects the
 * FIRST DOM element matching a chart-pane class — correct only when the
 * current layout is a single chart. If the layout is actually a multi-chart
 * grid (found 2026-07-30: TVScout's own saved layout can end up in this
 * state — 3 chart widgets, ids 1/2/4, all showing the same symbol at
 * different resolutions), that crop silently grabs whichever pane happens
 * to be first in DOM order, which can be much smaller than the full chart
 * area, producing a squashed, unusable screenshot with no error at all.
 * Check chart-widget count up front and fail loudly instead.
 */
async function countChartWidgets() {
  const result = await evaluate(
    `Object.keys(window.TradingViewApi._chartWidgetCollection.chartsSymbols()).length`
  );
  return typeof result === 'number' ? result : null;
}

// ── Full state snapshot ─────────────────────────────────────────────────

/**
 * Everything this routine might touch, captured with enough detail to
 * restore it exactly: symbol, timeframe, visible range, price-scale mode
 * (+ exact manual range if not auto), and every indicator with its full
 * input settings (not just id/name).
 */
export async function readFullState() {
  const base = await chartCore.getState();
  const rangeResult = await chartCore.getVisibleRange();
  const priceScale = await readPriceScale();

  const studies = [];
  for (const s of base.studies) {
    const info = await dataCore.getIndicator({ entity_id: s.id });
    studies.push({ id: s.id, name: s.name, visible: info.visible, inputs: info.inputs });
  }

  return {
    captured_at: new Date().toISOString(),
    symbol: base.symbol,
    resolution: base.resolution,
    chartType: base.chartType,
    visibleRange: rangeResult.visible_range,
    priceScale,
    studies,
  };
}

// ── Apply / revert ───────────────────────────────────────────────────────

/**
 * Applies the capture-ready configuration. Mutates `bookkeeping` IN PLACE
 * (rather than returning it only at the end) so that if this throws
 * partway through, the caller's revert step still sees exactly what had
 * already been changed — not a stale empty bookkeeping object.
 */
async function applyCaptureState(originalState, opts, bookkeeping) {
  const { symbol, timeframe, monthsBack, fromTime, toTime, addIndicatorNames, removeIndicatorNames, addIndicatorInputs = {} } = opts;

  if (symbol) {
    const normalize = (s) => String(s).replace(/^[A-Z]+:/, '').toUpperCase();
    if (normalize(originalState.symbol) !== normalize(symbol)) {
      await chartCore.setSymbol({ symbol });
    }
  }
  if (timeframe && originalState.resolution !== timeframe) {
    await chartCore.setTimeframe({ timeframe });
  }

  for (const targetName of removeIndicatorNames) {
    const match = originalState.studies.find((s) => s.name === targetName);
    if (!match) continue;
    await chartCore.manageIndicator({ action: 'remove', indicator: '', entity_id: match.id });
    bookkeeping.removed.push(match); // full original {id, name, visible, inputs}
  }

  for (const indicatorName of addIndicatorNames) {
    const before = await evaluate(
      `window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return s.id;})`
    );
    await chartCore.manageIndicator({ action: 'add', indicator: indicatorName });
    const after = await evaluate(
      `window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return s.id;})`
    );
    const newIds = (after || []).filter((id) => !(before || []).includes(id));
    bookkeeping.added.push(...newIds);

    // createStudy's own inputs argument does NOT apply overrides at creation
    // time (see the identical note in revertState below) — apply requested
    // input overrides via a separate setInputs() call against the new
    // entity, same as the existing re-add-after-revert workaround.
    const overrides = addIndicatorInputs[indicatorName];
    if (overrides && newIds.length > 0) {
      await indicatorsCore.setInputs({ entity_id: newIds[0], inputs: overrides });
    }
  }

  // An explicit [fromTime, toTime] window (epoch seconds) takes precedence
  // over monthsBack — used for a tight capture around a specific structure
  // (e.g. RC's n1->n3 swing) rather than "N months back from now".
  let from, to;
  if (fromTime != null && toTime != null) {
    from = fromTime;
    to = toTime;
  } else {
    to = Math.floor(Date.now() / 1000);
    from = to - Math.round(monthsBack * 30.4 * 86400);
  }
  await chartCore.setVisibleRange({ from, to });

  await resetScaleAutoFit();
  // The symbol/indicator/range changes above can each briefly invalidate
  // the price series before it re-renders with real data — poll for the
  // same concrete signal used before readFullState (see
  // waitForPriceRangeReady) rather than a blind sleep, which was found
  // 2026-08-01 to sometimes fire before candles had actually drawn,
  // producing a blank (but "successful") screenshot.
  await waitForPriceRangeReady();
  await new Promise((r) => setTimeout(r, 300)); // small settle margin after data is confirmed ready
}

/**
 * Best-effort revert of exactly what applyCaptureState changed, plus the
 * global symbol/timeframe/range/scale restore. Never throws — collects
 * and returns an array of per-step error strings instead, so the caller
 * can always tell whether the revert was clean.
 */
async function revertState(originalState, bookkeeping) {
  const errors = [];

  for (const id of bookkeeping.added) {
    try {
      await chartCore.manageIndicator({ action: 'remove', indicator: '', entity_id: id });
      const remaining = await evaluate(
        `window.TradingViewApi._activeChartWidgetWV.value().getAllStudies().map(function(s){return s.id;})`
      );
      if ((remaining || []).includes(id)) {
        errors.push(`remove added indicator ${id}: removeEntity reported success but study is still present`);
      }
    } catch (e) {
      errors.push(`remove added indicator ${id}: ${e.message}`);
    }
  }

  for (const removedStudy of bookkeeping.removed) {
    try {
      // Fixed 2026-07-30: createStudy's inputs argument (the manageIndicator
      // 'add' path's 4th createStudy param) does NOT apply parameter
      // overrides at creation time — verified directly: passing the exact
      // captured inputs (even filtered to plain in_N keys, no pineId/
      // pineVersion metadata) still produced zero new studies, i.e. a
      // silently failed add. Recreating with NO inputs (defaults) succeeds
      // reliably; captured non-default settings must be applied as a
      // SEPARATE setInputs() call afterward, against the new entity_id —
      // matching how the existing `tv indicator set` command already works
      // as a distinct step from `tv indicator add`.
      const addResult = await chartCore.manageIndicator({ action: 'add', indicator: removedStudy.name });
      if (!addResult?.success || !addResult?.entity_id) {
        errors.push(`re-add ${removedStudy.name}: manageIndicator add reported no new study created`);
        continue;
      }
      const overrides = inputsArrayToObject(removedStudy.inputs);
      if (overrides) {
        const setResult = await indicatorsCore.setInputs({ entity_id: addResult.entity_id, inputs: overrides });
        if (!setResult?.success) {
          errors.push(`re-add ${removedStudy.name}: recreated (id ${addResult.entity_id}) but setInputs did not report success`);
        }
      }
    } catch (e) {
      errors.push(`re-add ${removedStudy.name}: ${e.message}`);
    }
  }

  try {
    if (originalState.symbol) await chartCore.setSymbol({ symbol: originalState.symbol });
  } catch (e) {
    errors.push(`restore symbol: ${e.message}`);
  }

  try {
    if (originalState.resolution) await chartCore.setTimeframe({ timeframe: originalState.resolution });
  } catch (e) {
    errors.push(`restore timeframe: ${e.message}`);
  }

  try {
    if (originalState.visibleRange?.from && originalState.visibleRange?.to) {
      await chartCore.setVisibleRange({ from: originalState.visibleRange.from, to: originalState.visibleRange.to });
    }
  } catch (e) {
    errors.push(`restore visible range: ${e.message}`);
  }

  try {
    const r = await restorePriceScale(originalState.priceScale);
    if (r && r.ok === false) errors.push(`restore price scale: ${r.error}`);
  } catch (e) {
    errors.push(`restore price scale: ${e.message}`);
  }

  return errors;
}

function writeRecoveryFile(originalState, bookkeeping, errors) {
  mkdirSync(RECOVERY_DIR, { recursive: true });
  const fname = `recovery_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const filePath = join(RECOVERY_DIR, fname);
  writeFileSync(
    filePath,
    JSON.stringify({ written_at: new Date().toISOString(), errors, bookkeeping, original_state: originalState }, null, 2)
  );
  return filePath;
}

// ── Main entry point ─────────────────────────────────────────────────────

export async function captureIsolated({
  symbol,
  timeframe = 'D',
  monthsBack = 6,
  fromTime,
  toTime,
  addIndicatorNames = ['Visible Range Volume Profile'],
  removeIndicatorNames = ['Relative Strength Index'],
  addIndicatorInputs = {},
  region = 'chart',
  filename,
} = {}) {
  let originalState = null;
  let afterState = null;
  let captureResult = null;
  let revertErrors = [];
  let recoveryFilePath = null;
  const bookkeeping = { added: [], removed: [] };

  try {
    const chartWidgetCount = await countChartWidgets();
    if (chartWidgetCount !== null && chartWidgetCount > 1) {
      return {
        success: false,
        capture: {
          success: false,
          error: `layout has ${chartWidgetCount} chart panes, expected 1 — the ` +
            `region=chart crop would grab the wrong (possibly tiny) pane. Fix the ` +
            `layout to a single chart before capturing.`,
        },
        revert_errors: [],
        recovery_file: null,
        original_state: null,
        after_state: null,
      };
    }

    // A layout switch to a just-recreated/rarely-used chart (e.g. TVScout
    // right after closing extra panes, found 2026-08-01) can leave the
    // widget's model mid-load for a few seconds: priceScale().priceRange()
    // returns null until data finishes loading, which crashes readFullState
    // (readPriceScale dereferences it unconditionally). waitForChartReady()
    // (wait.js's DOM-heuristic poll) was tried first here and found
    // insufficient — it reported "ready" while priceRange() was still null
    // and produced a blank screenshot; waitForPriceRangeReady() polls the
    // exact signal directly instead.
    await waitForPriceRangeReady();

    originalState = await readFullState();

    try {
      await applyCaptureState(originalState, { symbol, timeframe, monthsBack, fromTime, toTime, addIndicatorNames, removeIndicatorNames, addIndicatorInputs }, bookkeeping);
      captureResult = await captureCore.captureScreenshot({ region, filename });
    } finally {
      // Runs even if applyCaptureState or captureScreenshot threw —
      // bookkeeping reflects whatever had actually been done by that point.
      revertErrors = await revertState(originalState, bookkeeping);
      if (revertErrors.length > 0) {
        recoveryFilePath = writeRecoveryFile(originalState, bookkeeping, revertErrors);
        console.error(
          `[safe_capture] REVERT INCOMPLETE — ${revertErrors.length} error(s). ` +
            `Original state written to ${recoveryFilePath} for manual restoration. ` +
            `Errors: ${revertErrors.join(' | ')}`
        );
      }
    }

    afterState = await readFullState();
  } finally {
    // CDP's WebSocket connection otherwise keeps the Node event loop (and
    // thus the process) alive indefinitely — confirmed the hard way: an
    // earlier investigation this week left an orphaned node process
    // running for over an hour after its actual work had finished.
    await disconnect();
  }

  return {
    success: !!captureResult?.success && revertErrors.length === 0,
    capture: captureResult,
    revert_errors: revertErrors,
    recovery_file: recoveryFilePath,
    original_state: originalState,
    after_state: afterState,
  };
}
