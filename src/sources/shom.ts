/**
 * Tide tables from the SHOM API (services.data.shom.fr), for the harbor nearest
 * the vessel. Needs an API key and a network connection.
 */
import { FALLBACK_TIMEZONE } from "./local.js";
import { createTablePredictor, parseTideTable, tableExtreme } from "./table.js";
import type { SourceConfig, TableExtreme, TablePredictor, TableSource } from "./types.js";

const HARBORS_URL = "https://services.data.shom.fr/spm/harbors";
const HLT_URL = "https://services.data.shom.fr/spm/hlt";
const DAY_MS = 24 * 3600_000;

interface Harbor {
  cst: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface ShomSourceOptions {
  debug: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** Great-circle distance in kilometers. */
export function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Reads an hlt response: either a SHOM tide table keyed by day, in French local
 * time, or a list of `{ dt, hauteur, type }` entries with absolute times.
 */
export function parseHlt(data: unknown, onSkip: (reason: string) => void = () => {}): TableExtreme[] {
  const record = data as Record<string, unknown> | null;
  const entries = Array.isArray(data) ? data : (record?.hlt ?? record?.data);
  if (!Array.isArray(entries)) return parseTideTable(data, FALLBACK_TIMEZONE, onSkip);

  const extremes: TableExtreme[] = [];
  for (const entry of entries as Record<string, unknown>[]) {
    const type = String(entry?.type ?? "").toUpperCase();
    const high = ["PM", "HIGH", "HW"].includes(type);
    const low = ["BM", "LOW", "LW"].includes(type);
    const time = new Date(String(entry?.dt ?? ""));
    const level = Number(entry?.hauteur);
    if ((!high && !low) || !Number.isFinite(time.getTime()) || !Number.isFinite(level)) {
      onSkip(`malformed entry ${JSON.stringify(entry)}`);
      continue;
    }
    const coefficient = Number(entry?.coefficient ?? entry?.coef);
    extremes.push(tableExtreme(high, time, level, high && Number.isFinite(coefficient) ? coefficient : null));
  }
  return extremes.sort((a, b) => a.time.getTime() - b.time.getTime());
}

export default function createShomSource(
  config: SourceConfig,
  { debug, fetch = globalThis.fetch, now = () => new Date() }: ShomSourceOptions,
): TableSource {
  const ttl = Math.max(1, config.period ?? 60) * 60_000;
  let harbors: Harbor[] | null = null;
  let cached: { loadedAt: number; harbor: string; predictor: TablePredictor } | null = null;

  async function getJson(url: URL, what: string): Promise<unknown> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`SHOM ${what} request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async function loadHarbors(apiKey: string): Promise<Harbor[]> {
    const url = new URL(HARBORS_URL);
    url.searchParams.set("apikey", apiKey);
    const data = await getJson(url, "harbor list");
    if (!Array.isArray(data)) throw new Error("SHOM harbor list is not a list");
    return (data as Record<string, unknown>[])
      .map((h) => ({
        cst: String(h.cst ?? ""),
        name: String(h.name ?? h.libelle ?? h.cst ?? ""),
        latitude: Number(h.latitude),
        longitude: Number(h.longitude),
      }))
      .filter((h) => h.cst && Number.isFinite(h.latitude) && Number.isFinite(h.longitude));
  }

  return {
    id: "shom",
    title: "SHOM",

    async resolve(position) {
      const apiKey = config.shomApiKey?.trim();
      if (!apiKey) throw new Error("SHOM API key not configured");
      if (!position) throw new Error("No position available to find a SHOM harbor");

      harbors ??= await loadHarbors(apiKey);
      if (harbors.length === 0) throw new Error("SHOM harbor list is empty");

      let harbor = harbors[0];
      let distance = distanceKm(position, harbor);
      for (const candidate of harbors) {
        const d = distanceKm(position, candidate);
        if (d < distance) [harbor, distance] = [candidate, d];
      }

      const time = now();
      if (cached && cached.harbor === harbor.cst && time.getTime() - cached.loadedAt < ttl) {
        return cached.predictor;
      }

      const start = new Date(time.getTime() - DAY_MS);
      const url = new URL(HLT_URL);
      url.searchParams.set("harborName", harbor.cst);
      url.searchParams.set("duration", "week");
      url.searchParams.set("datref", start.toISOString().slice(0, 10));
      url.searchParams.set("nbDays", "9");
      url.searchParams.set("apikey", apiKey);
      debug(`SHOM: loading tides of ${harbor.name} (${harbor.cst}), ${distance.toFixed(1)} km away`);

      const extremes = parseHlt(await getJson(url, "tide"), (reason) => debug(`SHOM: skipping ${reason}`));
      if (!extremes.some((e) => e.time >= time)) {
        throw new Error(`No upcoming tides from SHOM for ${harbor.name}`);
      }

      const predictor = createTablePredictor(
        {
          id: `shom:${harbor.cst}`,
          name: `${harbor.name} (SHOM)`,
          latitude: harbor.latitude,
          longitude: harbor.longitude,
        },
        extremes,
        "CD",
      );
      cached = { loadedAt: time.getTime(), harbor: harbor.cst, predictor };
      return predictor;
    },
  };
}
