import type { Extreme } from "@slackwater/engine";

/** The prediction source chosen in the plugin settings. */
export type SourceId = "slackwater" | "local" | "shom";

export const SOURCE_IDS: SourceId[] = ["slackwater", "local", "shom"];

/**
 * A tide extreme from a tide table. Same shape as Slackwater's, so the delta
 * code reads both, plus the French tidal coefficient when the table gives one.
 */
export interface TableExtreme extends Extreme {
  /** French tidal coefficient (20 to 120), published on high waters only. */
  coefficient?: number | null;
}

export interface TableStation {
  id: string;
  name: string;
  latitude?: number;
  longitude?: number;
}

export interface TableForecast {
  station: TableStation;
  /** Kilometers from the vessel, when the station was chosen by distance. */
  distance?: number;
  datum?: string;
  extremes: TableExtreme[];
}

/**
 * A predictor built from a tide table (a list of extremes). It answers the same
 * calls as a Slackwater station predictor, so the plugin publishes from either.
 */
export interface TablePredictor {
  name: string;
  getExtremesPrediction(options: { start: Date; end: Date }): TableForecast;
  getWaterLevelAtTime(options: { time: Date }): { time: Date; level: number };
  /** The coefficient in force at `time`, or null when the table has none. */
  getCoefficientAtTime(options: { time: Date }): number | null;
}

/** A tide table source, such as local files or the SHOM API. */
export interface TableSource {
  id: Exclude<SourceId, "slackwater">;
  title: string;
  /** Loads the table around now. Throws when it has no usable data. */
  resolve(position: { latitude: number; longitude: number } | null): Promise<TablePredictor>;
}

export interface SourceConfig {
  source?: SourceId;
  /** Minutes between two reloads of the forecast. */
  period?: number;
  localTidesPath?: string;
  localTidesTimezone?: string;
  localStationName?: string;
  shomApiKey?: string;
}
