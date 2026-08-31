import { Position, ServerAPI } from "@signalk/server-api";

// TODO[TS]: Fix this in the upstream types
export type SignalKApp = ServerAPI;

export type OptionalPromise<T> = T | Promise<T>;

export type TideExtremeType = "High" | "Low";

export interface TideForecastParams {
  position: Omit<Position, "altitude">;
  date?: string;
}

export interface TideExtreme {
  time: string;
  value: number;
  type: TideExtremeType;
  /**
   * French tidal coefficient (20 = lowest neap, 120 = highest spring), when the
   * source publishes it. Only carried on High water extremes.
   */
  coefficient?: number | null;
}

export interface TideForecastResult {
  station: {
    name: string;
    position: {
      latitude: number;
      longitude: number;
    };
  }
  extremes: TideExtreme[];
}

export type TideForecastFunction = (params: TideForecastParams) => OptionalPromise<TideForecastResult>;

export interface TideSource {
  id: string;
  title: string;
  start: (props: Config) => OptionalPromise<TideForecastFunction>;
  properties?: unknown; // TODO: use schema?
}

export type Config = {
  source?: string;
  period?: number;
  worldtidesApiKey?: string;
  stormglassApiKey?: string;
  localTidesPath?: string;
  localTidesTimezone?: string;
  shomApiKey?: string;
};
