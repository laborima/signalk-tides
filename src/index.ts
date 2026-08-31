/*
 * Copyright 2017 Scott Bender <scott@scottbender.net> and Joachim Bakke
 * Copyright 2025 Brandon Keepers <brandon@opensoul.org>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Context, Delta, Path, Plugin, Position, Timestamp } from "@signalk/server-api";
import type { SignalKApp, Config, TideForecastResult } from "./types.js";
import { approximateTideHeightAt } from "./calculations.js";
import { toResourceCollection, toSingleResource } from "./adapter.js";
import FileCache from "./cache.js";
import createSources from "./sources/index.js";

export default function (app: SignalKApp): Plugin {
  // Interval to update tide data
  const defaultPeriod = 60; // 1 hour
  // Minimum delay between two forecast fetches triggered by an exhausted cache.
  const REFRESH_BACKOFF_MS = 15 * 60 * 1000;
  let unsubscribes: (() => void)[] = [];
  let timers: NodeJS.Timeout[] = [];

  const sources = createSources(app);

  const plugin: Plugin = {
    id: "tides",
    name: "Tides",
    description: "Tidal predictions for the vessel's position from various online sources.",
    schema: () => {
      const allSourceProperties = sources.reduce(
        (properties, source) => Object.assign(properties, source.properties ?? {}),
        {} as Record<string, unknown>
      );

      return {
        title: "Tides API",
        type: "object",
        properties: {
          source: {
            title: "Data source",
            type: "string",
            enum: sources.map(({ id }) => id),
            enumNames: sources.map(({ title }) => title),
            default: sources[0].id,
          },
          period: {
            title: "Update frequency",
            type: "number",
            description: "How often to update tide forecast (minutes)",
            default: 60,
            minimum: 1,
          },
          ...allSourceProperties,
        },
      };
    },
    start,
    stop() {
      unsubscribes.forEach((f) => f());
      unsubscribes = [];
      timers.forEach((timer) => clearInterval(timer));
      timers = [];
    },
  };

  async function start(props: Config) {
    app.debug("Starting tides-api: " + JSON.stringify(props));

    let lastForecast: TideForecastResult | null = null;
    let lastPosition: Position | null = null;
    let lastRefreshAttempt = 0;
    const cache = new FileCache(app.getDataDirPath());

    // Use the selected source, or the first one if not specified
    const source = sources.find((source) => source.id === props.source) || sources[0];

    // Load the selected source
    const provider = await source.start(props);

    // Register the source as a resource provider
    app.registerResourceProvider({
      type: "tides",
      methods: {
        async listResources(query) {
          if (!lastPosition) throw new Error("No position available");
          const forecast = await provider({ position: lastPosition, ...query });
          return toResourceCollection(forecast, source.id);
        },
        async getResource(id: string) {
          if (!lastForecast) throw new Error("No forecast available");
          const feature = toSingleResource(lastForecast, id, source.id);
          if (!feature) throw new Error(`Tide resource not found: ${id}`);
          return feature;
        },
        setResource(): never {
          throw new Error("Not implemented");
        },
        deleteResource(): never {
          throw new Error("Not implemented");
        },
      },
    });

    app.subscriptionmanager.subscribe(
      {
        context: ("vessels." + app.selfId) as Context,
        subscribe: [
          {
            path: "navigation.position" as Path,
            period: (props.period ?? defaultPeriod) * 60 * 1000,
            policy: "fixed",
          },
        ],
      },
      unsubscribes,
      (subscriptionError) => {
        app.error("Error:" + subscriptionError);
      },
      updatePosition
    );

    async function updatePosition() {
      lastPosition =
        ((app.getSelfPath("navigation.position.value") ||
          (await cache.get("position"))) as Position | undefined) || null;

      if (lastPosition) {
        await cache.set("position", lastPosition);
        await updateForecast();
      }
    }

    async function updateForecast({ publish = true }: { publish?: boolean } = {}) {
      if (!lastPosition) {
        app.debug("No position available, cannot fetch tide data");
        return;
      }

      lastRefreshAttempt = Date.now();
      try {
        lastForecast = await provider({ position: lastPosition });
        app.setPluginStatus("Updated tide forecast from " + source.title);
        if (publish) await updateTides();
      } catch (e: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app.setPluginError((e as any).message);
        // @ts-expect-error: TODO[TS] this accepts more than just a string: https://github.com/bkeepers/signalk-server/blob/d6845ee1f915e6b729d66d2b08b15dc2e0da8e51/src/interfaces/plugins.ts#L517-L519
        app.error(e);
      }
    }

    async function updateTides(now = new Date()) {
      if (!lastForecast) {
        // Nothing cached yet (no position at startup, or the first fetch failed):
        // keep trying rather than staying silent forever.
        await updatePosition();
        if (!lastForecast) return;
      }

      // Get the next two upcoming extremes
      let nextTides = lastForecast.extremes
        .filter(({ time }) => new Date(time) >= now)
        .slice(0, 2);

      // The cached forecast has expired. Without this the plugin would keep
      // publishing heightNow extrapolated from stale extremes and would never
      // refresh timeHigh/timeLow again, because updateForecast() is otherwise
      // only triggered by navigation.position deltas -- which never arrive on a
      // fixed installation with no GPS.
      // Rate-limited: if the source cannot supply future extremes (data files
      // exhausted, API quota spent), this would otherwise re-fetch every minute.
      if (nextTides.length < 2 && Date.now() - lastRefreshAttempt > REFRESH_BACKOFF_MS) {
        app.debug("Forecast exhausted at " + now.toISOString() + ", refreshing");
        await updateForecast({ publish: false });
        if (!lastForecast) return;
        nextTides = lastForecast.extremes
          .filter(({ time }) => new Date(time) >= now)
          .slice(0, 2);
      }

      const delta: Delta = {
        context: ("vessels." + app.selfId) as Context,
        updates: [
          {
            timestamp: now.toISOString() as Timestamp,
            values: [
              {
                path: "environment.tide.stationName" as Path,
                value: lastForecast.station.name,
              },
              {
                path: "environment.tide.heightNow" as Path,
                value: approximateTideHeightAt(lastForecast.extremes, now),
              },
              ...nextTides.flatMap(({ type, time, value }) => {
                return [
                  { path: `environment.tide.height${type}` as Path, value },
                  { path: `environment.tide.time${type}` as Path, value: time },
                ];
              }),
            ],
          },
        ],
      };

      app.debug("Sending delta: " + JSON.stringify(delta));
      app.handleMessage(plugin.id, delta);
    }

    // Perform initial update on startup after short delay to allow gnss position to be populated
    delay(4000).then(updatePosition);

    // Refresh the forecast from the source on its own schedule. The
    // navigation.position subscription only fires when the position changes, so
    // a moored or land-based installation would otherwise never refresh.
    const periodMs = (props.period ?? defaultPeriod) * 60 * 1000;
    timers.push(setInterval(() => { void updatePosition(); }, periodMs));

    // Publish the current height and the next extremes every minute
    timers.push(setInterval(() => { void updateTides(); }, 60 * 1000));
  }
  function delay(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  return plugin;
}
