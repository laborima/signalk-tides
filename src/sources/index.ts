import createLocalSource from "./local.js";
import createShomSource from "./shom.js";
import { SOURCE_IDS, type SourceConfig, type SourceId, type TableSource } from "./types.js";

export interface SourceContext {
  debug: (message: string) => void;
  error: (message: string) => void;
}

/** The configured source, falling back to Slackwater for a missing or unknown one. */
export function sourceId(config: SourceConfig): SourceId {
  return config.source && SOURCE_IDS.includes(config.source) ? config.source : "slackwater";
}

/** The tide table source for the settings, or null to predict with Slackwater. */
export function createTableSource(config: SourceConfig, context: SourceContext): TableSource | null {
  switch (sourceId(config)) {
    case "local":
      return createLocalSource(config, context);
    case "shom":
      return createShomSource(config, context);
    default:
      return null;
  }
}

/** Settings of the sources, merged into the plugin schema. */
export const sourceSchemaProperties = {
  source: {
    type: "string",
    title: "Tide source",
    description:
      "Slackwater predicts offline from harmonic constants. Local files and SHOM read published tide tables, which also give the French tidal coefficient.",
    default: "slackwater",
    enum: SOURCE_IDS,
    enumNames: ["Slackwater (offline predictions)", "Local files", "SHOM"],
  },
  period: {
    type: "number",
    title: "Forecast refresh (minutes)",
    description: "How often to reload the tide forecast, for every source.",
    default: 60,
    minimum: 1,
  },
  localTidesPath: {
    type: "string",
    title: "Local files: tides folder",
    description:
      "Folder of monthly tide tables named MM_YYYY.json (e.g. /home/node/.signalk/tides/larochelle). Used by the Local files source.",
  },
  localTidesTimezone: {
    type: "string",
    title: "Local files: timezone",
    description:
      "IANA timezone of the times in the files (e.g. Europe/Paris). Leave empty to use the timezone of the nearest tide station.",
  },
  localStationName: {
    type: "string",
    title: "Local files: station name",
    description: "Name published for the station. Defaults to the folder name.",
  },
  shomApiKey: {
    type: "string",
    title: "SHOM: API key",
    description: "Key for services.data.shom.fr. Used by the SHOM source.",
  },
};
