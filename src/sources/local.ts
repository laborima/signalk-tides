/**
 * Tide tables read from local files, one per month, named MM_YYYY.json, in the
 * SHOM format (see parseTideTable). Works offline and without a position.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { nearestStation } from "slackwater";
import { MAX_STATION_KM } from "../calculations.js";
import { createTablePredictor, isValidTimeZone, parseTideTable } from "./table.js";
import type { SourceConfig, TableExtreme, TablePredictor, TableSource } from "./types.js";

const DAY_MS = 24 * 3600_000;
/** Timezone of the tables when neither the settings nor a nearby station give one. */
export const FALLBACK_TIMEZONE = "Europe/Paris";

export interface LocalSourceOptions {
  debug: (message: string) => void;
  error: (message: string) => void;
  now?: () => Date;
}

export default function createLocalSource(
  config: SourceConfig,
  { debug, error, now = () => new Date() }: LocalSourceOptions,
): TableSource {
  const ttl = Math.max(1, config.period ?? 60) * 60_000;
  let timezone: string | null = null;
  let cached: { loadedAt: number; day: string; predictor: TablePredictor } | null = null;

  // The tables give times in the station's local time, not the server's (which
  // runs in UTC in Docker). The station does not move, so resolve it once.
  async function resolveTimezone(position: { latitude: number; longitude: number } | null) {
    if (timezone) return timezone;

    const configured = config.localTidesTimezone?.trim();
    if (configured) {
      if (isValidTimeZone(configured)) return (timezone = configured);
      error(`Unknown timezone ${configured} for local tide files, ignoring it`);
    }

    if (position) {
      try {
        const station = await nearestStation({ ...position, maxDistance: MAX_STATION_KM });
        if (station.timezone && isValidTimeZone(station.timezone)) {
          debug(`Local tide files use the timezone of ${station.name}: ${station.timezone}`);
          return (timezone = station.timezone);
        }
      } catch (e: unknown) {
        debug(`Could not resolve the timezone from the position: ${e instanceof Error ? e.message : e}`);
      }
      debug(`Using ${FALLBACK_TIMEZONE} for local tide files`);
      return (timezone = FALLBACK_TIMEZONE);
    }

    // Without a position, keep trying on the next load
    debug(`No position yet, using ${FALLBACK_TIMEZONE} for local tide files`);
    return FALLBACK_TIMEZONE;
  }

  async function readMonth(dir: string, month: string, zone: string): Promise<TableExtreme[]> {
    const file = join(dir, `${month}.json`);
    try {
      const content = await readFile(file, "utf-8");
      return parseTideTable(JSON.parse(content), zone, (reason) =>
        debug(`Skipping a row of ${file}: ${reason}`),
      );
    } catch (e: unknown) {
      debug(`Could not read local tide file ${file}: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  return {
    id: "local",
    title: "Local files",

    async resolve(position) {
      const dir = config.localTidesPath?.trim();
      if (!dir) throw new Error("Local tides path not configured");

      const time = now();
      const day = time.toISOString().slice(0, 10);
      if (cached && cached.day === day && time.getTime() - cached.loadedAt < ttl) {
        return cached.predictor;
      }

      const zone = await resolveTimezone(position);

      // One day back, so the height between midnight and the first extreme of the
      // day is interpolated rather than guessed, and a week and a day ahead.
      const start = new Date(time.getTime() - DAY_MS);
      const end = new Date(time.getTime() + 8 * DAY_MS);
      const months = new Set<string>();
      for (let t = start.getTime() - DAY_MS; t <= end.getTime() + DAY_MS; t += DAY_MS) {
        const d = new Date(t);
        months.add(`${String(d.getUTCMonth() + 1).padStart(2, "0")}_${d.getUTCFullYear()}`);
      }

      const extremes = (await Promise.all([...months].map((month) => readMonth(dir, month, zone))))
        .flat()
        .filter((e) => e.time >= start && e.time <= end);

      if (!extremes.some((e) => e.time >= time)) {
        throw new Error(`No upcoming tides in the local files of ${dir}`);
      }

      const station = {
        id: `local:${basename(dir)}`,
        name: config.localStationName?.trim() || basename(dir),
        ...(position ? { latitude: position.latitude, longitude: position.longitude } : {}),
      };
      debug(`Loaded ${extremes.length} tides from ${dir} (${zone})`);
      const predictor = createTablePredictor(station, extremes, "CD");
      // Until a position resolves the timezone, the fallback is only provisional
      if (timezone) cached = { loadedAt: time.getTime(), day, predictor };
      return predictor;
    },
  };
}
