/**
 * The tides resource of a tide table source, as a Signal K resource collection
 * of GeoJSON features, one per UTC day. Extremes keep the `{ type, value, time,
 * coefficient }` shape that clients of the earlier sources-based plugin read.
 */
import type { TablePredictor } from "./sources/types.js";

const DAY_MS = 24 * 3600_000;

export interface TideResourceExtreme {
  type: string;
  value: number;
  time: string;
  coefficient: number | null;
}

export interface TideFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] } | null;
  properties: {
    name: string;
    source: string;
    datum: string;
    units: "m";
    date: string;
    extremes: TideResourceExtreme[];
    heightNow: number | null;
    coefficient: number | null;
    timestamp: string;
  };
}

export type TideResourceCollection = Record<string, TideFeature>;

function resourceId(stationName: string, date: string): string {
  const slug = stationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `urn:mrn:signalk:uuid:tides:${slug}:${date}`;
}

/** A week of tides from the start of the current UTC day. */
export function toResourceCollection(
  predictor: TablePredictor,
  sourceId: string,
  now: Date = new Date(),
): TideResourceCollection {
  const start = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const forecast = predictor.getExtremesPrediction({
    start,
    end: new Date(now.getTime() + 7 * DAY_MS),
  });
  const { station } = forecast;
  const today = now.toISOString().slice(0, 10);
  const geometry =
    station.latitude !== undefined && station.longitude !== undefined
      ? { type: "Point" as const, coordinates: [station.longitude, station.latitude] as [number, number] }
      : null;

  const byDay = new Map<string, TideResourceExtreme[]>();
  for (const extreme of forecast.extremes) {
    const time = extreme.time.toISOString();
    const day = time.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push({
      type: extreme.label,
      value: extreme.level,
      time,
      coefficient: extreme.coefficient ?? null,
    });
    byDay.set(day, list);
  }

  const collection: TideResourceCollection = {};
  for (const [date, extremes] of byDay) {
    let heightNow: number | null = null;
    if (date === today) {
      try {
        heightNow = predictor.getWaterLevelAtTime({ time: now }).level;
      } catch {
        heightNow = null;
      }
    }
    collection[resourceId(station.name, date)] = {
      type: "Feature",
      geometry,
      properties: {
        name: station.name,
        source: sourceId,
        datum: forecast.datum ?? "CD",
        units: "m",
        date,
        extremes,
        heightNow,
        coefficient: date === today ? predictor.getCoefficientAtTime({ time: now }) : null,
        timestamp: now.toISOString(),
      },
    };
  }
  return collection;
}
