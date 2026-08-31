import type { TideExtreme } from './types.js';

/** Mean interval between two consecutive extremes of a semi-diurnal tide (M2 / 2). */
const MEAN_HALF_CYCLE_MS = 6 * 3600_000 + 12 * 60_000 + 30_000; // 6h12m30s

const round = (value: number): number => parseFloat(value.toFixed(3));

const byTime = (a: TideExtreme, b: TideExtreme) =>
  new Date(a.time).getTime() - new Date(b.time).getTime();

/**
 * Height between two consecutive extremes, using the harmonic (cosine) model.
 *
 * The tide between a high and a low water follows a half cosine, which is both
 * the physical model and a smooth version of the seafarer's rule of twelfths.
 * `progress` is the fraction of the half-cycle elapsed (0 at `start`, 1 at `end`).
 */
function harmonicHeight(startHeight: number, endHeight: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return startHeight + (endHeight - startHeight) * ((1 - Math.cos(Math.PI * p)) / 2);
}

/**
 * Approximate the tide height at an arbitrary instant from a list of extremes.
 *
 * Interpolation is done on absolute timestamps (never on time-of-day), so it is
 * correct across midnight, across day boundaries and whatever the server timezone.
 *
 * When `time` falls outside the range covered by `extremes`, the nearest known
 * half-cycle is projected with the mean semi-diurnal period. That extrapolation
 * degrades quickly, so callers should refresh the forecast rather than rely on it.
 *
 * @returns the height in metres, or null if the extremes cannot support a guess.
 */
export function approximateTideHeightAt(extremes: TideExtreme[], time: Date): number | null {
  if (!extremes || extremes.length === 0) return null;

  const sorted = extremes
    .filter((e) => Number.isFinite(new Date(e.time).getTime()) && Number.isFinite(e.value))
    .sort(byTime);

  if (sorted.length === 0) return null;

  const t = time.getTime();
  if (!Number.isFinite(t)) return null;

  let prev: TideExtreme | undefined;
  let next: TideExtreme | undefined;

  for (const extreme of sorted) {
    const extremeTime = new Date(extreme.time).getTime();
    if (extremeTime <= t) prev = extreme;
    if (extremeTime >= t) {
      next = extreme;
      break;
    }
  }

  // Nominal case: `time` sits between two known extremes.
  if (prev && next) {
    const prevTime = new Date(prev.time).getTime();
    const nextTime = new Date(next.time).getTime();
    const span = nextTime - prevTime;
    if (span <= 0) return round(prev.value);
    return round(harmonicHeight(prev.value, next.value, (t - prevTime) / span));
  }

  // Outside the known window: project the nearest half-cycle forward or backward.
  if (sorted.length < 2) return round(sorted[0].value);

  const halfCycle = meanHalfCycle(sorted);

  if (!next) {
    // After the last known extreme.
    const last = sorted[sorted.length - 1];
    const beforeLast = sorted[sorted.length - 2];
    const lastTime = new Date(last.time).getTime();
    const elapsed = t - lastTime;
    const cycles = Math.floor(elapsed / halfCycle);
    const startHeight = cycles % 2 === 0 ? last.value : beforeLast.value;
    const endHeight = cycles % 2 === 0 ? beforeLast.value : last.value;
    const progress = (elapsed - cycles * halfCycle) / halfCycle;
    return round(harmonicHeight(startHeight, endHeight, progress));
  }

  // Before the first known extreme.
  const first = sorted[0];
  const second = sorted[1];
  const firstTime = new Date(first.time).getTime();
  const remaining = firstTime - t;
  const cycles = Math.floor(remaining / halfCycle);
  const endHeight = cycles % 2 === 0 ? first.value : second.value;
  const startHeight = cycles % 2 === 0 ? second.value : first.value;
  const progress = 1 - (remaining - cycles * halfCycle) / halfCycle;
  return round(harmonicHeight(startHeight, endHeight, progress));
}

/**
 * Mean interval between consecutive extremes, falling back to the M2 half-period
 * when the sample is too small or obviously wrong (gaps from missing data).
 */
function meanHalfCycle(sorted: TideExtreme[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = new Date(sorted[i].time).getTime() - new Date(sorted[i - 1].time).getTime();
    // Keep plausible semi-diurnal gaps only (4h..9h).
    if (gap >= 4 * 3600_000 && gap <= 9 * 3600_000) gaps.push(gap);
  }
  if (gaps.length === 0) return MEAN_HALF_CYCLE_MS;
  return gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
}

/**
 * True when the tide is rising at `time`, i.e. the next extreme is a high water.
 * Returns null when it cannot be determined.
 */
export function isRisingAt(extremes: TideExtreme[], time: Date): boolean | null {
  const t = time.getTime();
  const next = extremes
    .slice()
    .sort(byTime)
    .find((e) => new Date(e.time).getTime() >= t);
  return next ? next.type === 'High' : null;
}
