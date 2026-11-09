/**
 * Tide tables: lists of high and low waters, as published by the SHOM and
 * stored in local files, turned into a predictor the plugin can publish from.
 */
import type { TableExtreme, TablePredictor, TableStation } from "./types.js";

/** Mean interval between two consecutive extremes of a semi-diurnal tide (M2 / 2). */
const MEAN_HALF_CYCLE_MS = 6 * 3600_000 + 12 * 60_000 + 30_000; // 6h12m30s

const round = (value: number): number => parseFloat(value.toFixed(3));

const byTime = (a: TableExtreme, b: TableExtreme) => a.time.getTime() - b.time.getTime();

/**
 * Height between two consecutive extremes on a half cosine: the physical model
 * of the tide between a high and a low water, and a smooth form of the Rule of
 * Twelfths (1/12, 2/12, 3/12, 3/12, 2/12, 1/12 of the range per sixth of the
 * interval). `progress` is the elapsed fraction of the interval, 0 to 1.
 */
export function harmonicHeight(startHeight: number, endHeight: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return startHeight + (endHeight - startHeight) * ((1 - Math.cos(Math.PI * p)) / 2);
}

/**
 * Tide height at an instant, interpolated from a list of extremes.
 *
 * Works on absolute timestamps, never on time of day, so it stays right across
 * midnight, across days and whatever the server timezone.
 *
 * Outside the range of the extremes, it repeats the nearest half-cycle with the
 * mean interval of the table. That guess degrades quickly, so the plugin reloads
 * the table rather than relying on it.
 *
 * @returns the height in meters, or null when there is no extreme to use.
 */
export function heightFromExtremes(extremes: TableExtreme[], time: Date): number | null {
  const sorted = extremes
    .filter((e) => Number.isFinite(e.time.getTime()) && Number.isFinite(e.level))
    .sort(byTime);
  const t = time.getTime();
  if (sorted.length === 0 || !Number.isFinite(t)) return null;

  let prev: TableExtreme | undefined;
  let next: TableExtreme | undefined;
  for (const extreme of sorted) {
    const extremeTime = extreme.time.getTime();
    if (extremeTime <= t) prev = extreme;
    if (extremeTime >= t) {
      next = extreme;
      break;
    }
  }

  if (prev && next) {
    const span = next.time.getTime() - prev.time.getTime();
    if (span <= 0) return round(prev.level);
    return round(harmonicHeight(prev.level, next.level, (t - prev.time.getTime()) / span));
  }

  if (sorted.length < 2) return round(sorted[0].level);
  const halfCycle = meanHalfCycle(sorted);

  if (!next) {
    // After the last extreme
    const last = sorted[sorted.length - 1];
    const beforeLast = sorted[sorted.length - 2];
    const elapsed = t - last.time.getTime();
    const cycles = Math.floor(elapsed / halfCycle);
    const even = cycles % 2 === 0;
    const progress = (elapsed - cycles * halfCycle) / halfCycle;
    return round(
      harmonicHeight(even ? last.level : beforeLast.level, even ? beforeLast.level : last.level, progress),
    );
  }

  // Before the first extreme
  const first = sorted[0];
  const second = sorted[1];
  const remaining = first.time.getTime() - t;
  const cycles = Math.floor(remaining / halfCycle);
  const even = cycles % 2 === 0;
  const progress = 1 - (remaining - cycles * halfCycle) / halfCycle;
  return round(
    harmonicHeight(even ? second.level : first.level, even ? first.level : second.level, progress),
  );
}

/**
 * Mean interval between consecutive extremes, or the M2 half period when the
 * table has no plausible semi-diurnal gap (4 to 9 hours) to measure.
 */
function meanHalfCycle(sorted: TableExtreme[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i].time.getTime() - sorted[i - 1].time.getTime();
    if (gap >= 4 * 3600_000 && gap <= 9 * 3600_000) gaps.push(gap);
  }
  if (gaps.length === 0) return MEAN_HALF_CYCLE_MS;
  return gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
}

/**
 * The tidal coefficient in force at `time`: the one of the nearest high water
 * that has one, or null when the table gives none.
 */
export function coefficientAt(extremes: TableExtreme[], time: Date): number | null {
  const t = time.getTime();
  let best: TableExtreme | null = null;
  for (const extreme of extremes) {
    if (!extreme.high || typeof extreme.coefficient !== "number") continue;
    if (!Number.isFinite(extreme.coefficient)) continue;
    if (!best || Math.abs(extreme.time.getTime() - t) < Math.abs(best.time.getTime() - t)) {
      best = extreme;
    }
  }
  return best?.coefficient ?? null;
}

export function tableExtreme(high: boolean, time: Date, level: number, coefficient?: number | null): TableExtreme {
  return {
    time,
    level,
    high,
    low: !high,
    label: high ? "High" : "Low",
    ...(coefficient !== undefined ? { coefficient } : {}),
  };
}

/** A predictor over a fixed list of extremes. */
export function createTablePredictor(
  station: TableStation,
  extremes: TableExtreme[],
  datum?: string,
): TablePredictor {
  const sorted = extremes.slice().sort(byTime);
  return {
    name: station.name,
    getExtremesPrediction({ start, end }) {
      return {
        station,
        datum,
        extremes: sorted.filter((e) => e.time >= start && e.time <= end),
      };
    },
    getWaterLevelAtTime({ time }) {
      const level = heightFromExtremes(sorted, time);
      if (level === null) throw new Error(`No tide data for ${station.name}`);
      return { time, level };
    },
    getCoefficientAtTime({ time }) {
      return coefficientAt(sorted, time);
    },
  };
}

/**
 * The UTC instant of a wall-clock time in an IANA timezone. Around a DST change,
 * a time that does not exist moves forward and an ambiguous one takes the
 * earlier offset.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall - timezoneOffset(wall, timeZone);
  // The offset at the guess can differ from the offset at the result near a DST change
  utc = wall - timezoneOffset(utc, timeZone);
  return new Date(utc);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Milliseconds the timezone is ahead of UTC at `instant`. */
function timezoneOffset(instant: number, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(new Date(instant))) {
    if (type !== "literal") parts[type] = Number(value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Whether `timeZone` is an IANA timezone the runtime knows. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{1,2}):(\d{2})$/;
const HEIGHT = /^(-?\d+(?:\.\d+)?)\s*m?$/;

/**
 * Parses a SHOM tide table, the format of the SHOM hlt service and of the local
 * files: `{ "YYYY-MM-DD": [["tide.high", "HH:MM", "5.94m", "84"], ...] }`, times
 * in the station's local time and coefficients on high waters ("---" on lows).
 * Malformed rows are skipped and reported through `onSkip`.
 */
export function parseTideTable(
  table: unknown,
  timeZone: string,
  onSkip: (reason: string) => void = () => {},
): TableExtreme[] {
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];
  const extremes: TableExtreme[] = [];

  for (const [dayKey, rows] of Object.entries(table as Record<string, unknown>)) {
    const day = DAY_KEY.exec(dayKey);
    if (!day || !Array.isArray(rows)) continue;

    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const [typeStr, timeStr, heightStr, coefStr] = row.map((cell) => String(cell ?? "").trim());
      const high = typeStr === "tide.high";
      if (!high && typeStr !== "tide.low") {
        onSkip(`${dayKey}: unknown tide type ${JSON.stringify(typeStr)}`);
        continue;
      }
      const time = TIME.exec(timeStr);
      const height = HEIGHT.exec(heightStr);
      if (!time || !height) {
        onSkip(`${dayKey}: malformed row ${JSON.stringify(row)}`);
        continue;
      }
      const hours = Number(time[1]);
      const minutes = Number(time[2]);
      if (hours > 23 || minutes > 59) {
        onSkip(`${dayKey}: malformed time ${JSON.stringify(timeStr)}`);
        continue;
      }
      const coefficient = /^\d+$/.test(coefStr) ? Number(coefStr) : null;
      extremes.push(
        tableExtreme(
          high,
          zonedTimeToUtc(Number(day[1]), Number(day[2]), Number(day[3]), hours, minutes, timeZone),
          Number(height[1]),
          coefficient,
        ),
      );
    }
  }

  return extremes.sort(byTime);
}
