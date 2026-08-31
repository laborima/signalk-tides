import type { SignalKApp, TideForecastParams, TideForecastResult, TideSource } from "../types.js";
import path from 'path';
import fs from 'fs/promises';
import moment from 'moment-timezone';
import tzlookup from 'tz-lookup';

export default function (app: SignalKApp): TideSource {
  return {
    id: 'local',
    title: 'Local Files',
    properties: {
      localTidesPath: {
        type: 'string',
        title: 'Path to local tides folder',
        description: 'Directory containing tide JSON files (e.g. /home/node/.signalk/tides)'
      },
      localTidesTimezone: {
        type: 'string',
        title: 'Timezone of local tide files',
        description: 'IANA timezone the HH:MM values in the JSON files are expressed in. Leave empty to derive it from the vessel position.'
      }
    },

    start({ localTidesPath, localTidesTimezone } = {}) {
      app.debug("Using Local Tides from " + localTidesPath);

      return async ({ position, date = new Date().toISOString() }: TideForecastParams): Promise<TideForecastResult> => {
        if (!localTidesPath) {
            throw new Error('Local tides path not configured');
        }

        // Tide times in the JSON files are local times at the station, not
        // server time (the server may run in UTC, e.g. in Docker). Unless a
        // timezone is configured, derive it from the position.
        let timezone = localTidesTimezone;
        if (!timezone) {
            try {
                timezone = tzlookup(position.latitude, position.longitude);
            } catch (err: any) {
                app.debug(`Could not resolve timezone from position: ${err.message}`);
                timezone = 'Europe/Paris';
            }
        }
        app.debug(`Using timezone ${timezone} for local tide files`);

        const startDate = moment(date);
        const endDate = moment(date).add(7, 'days'); // Standard range seems to be a week
        const extremes: any[] = [];

        // We might need data from multiple months
        let currentMonth = moment(startDate);
        // Limit the loop to avoid infinite loops if something goes wrong, e.g. 2 months max
        const limitDate = moment(endDate).add(1, 'month');

        while (currentMonth.isBefore(limitDate)) {
            const fileName = `${currentMonth.format('MM_YYYY')}.json`;
            const filePath = path.join(localTidesPath, fileName);
            
            try {
                const fileContent = await fs.readFile(filePath, 'utf-8');
                const json = JSON.parse(fileContent);
                
                // Format: { "YYYY-MM-DD": [ ["tide.low", "HH:MM", "HEIGHT", "COEF"], ... ] }
                for (const dayKey in json) {
                    const dayDate = moment.tz(dayKey, timezone);
                    // Filter for relevant days
                    if (dayDate.isSameOrAfter(startDate, 'day') && dayDate.isSameOrBefore(endDate, 'day')) {
                        const dayTides = json[dayKey];
                        for (const tide of dayTides) {
                            // ["tide.low", "11:38", "1.45m", "---"] / ["tide.high", "17:23", "6.2m", "91"]
                            const [typeStr, timeStr, heightStr, coefStr] = tide;
                            const type = typeStr === 'tide.high' ? 'High' : 'Low';
                            // heightStr is like "1.45m", need to parse float
                            const value = parseFloat(heightStr.replace('m', ''));

                            // Construct full date time
                            const [hours, minutes] = timeStr.split(':');
                            const time = dayDate.clone().hour(parseInt(hours)).minute(parseInt(minutes)).second(0).toISOString();

                            // Tidal coefficient, published only on high waters ("---" on lows)
                            const coefficient = Number.parseInt(coefStr, 10);

                            extremes.push({
                                type,
                                value,
                                time,
                                coefficient: Number.isFinite(coefficient) ? coefficient : null
                            });
                        }
                    }
                }

            } catch (err: any) {
                // Ignore missing files, just log debug
                 // If the start date file is missing, it might be an issue, but let's just debug log
                app.debug(`Could not read or parse local tide file ${filePath}: ${err.message}`);
            }

            // Move to next month
            const nextMonth = currentMonth.clone().add(1, 'month');
            if (nextMonth.isSame(currentMonth)) break; // Safety break
            currentMonth = nextMonth;
            
             // If we have covered past the end date, stop
             if (currentMonth.isAfter(endDate) && currentMonth.date() === 1) {
                 // But wait, if we are in Jan 30 and want 7 days, we need Feb.
                 // The while condition handles it: currentMonth < limitDate.
                 // But we can optimize: if currentMonth (start of month) is > endDate, we can stop.
                 if (currentMonth.isAfter(endDate)) break;
             }
        }

        extremes.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

        const stationName = path.basename(localTidesPath);

        return {
          station: {
            name: stationName,
            position: {
              latitude: position.latitude,
              longitude: position.longitude,
            },
          },
          extremes
        };
      };
    }
  }
}
