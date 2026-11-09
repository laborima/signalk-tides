import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, Position, ServerAPI } from '@signalk/server-api';
import createPlugin from '../src/index.js';
import createLocalSource from '../src/sources/local.js';
import { parseHlt } from '../src/sources/shom.js';
import {
  coefficientAt,
  harmonicHeight,
  heightFromExtremes,
  parseTideTable,
  tableExtreme,
  zonedTimeToUtc,
} from '../src/sources/table.js';
import type { TablePredictor } from '../src/sources/types.js';
import type { TideResourceCollection } from '../src/adapter.js';

// Two weeks of La Rochelle tables, copied from the cirrus files, across the end
// of daylight saving time on 2026-10-25
const FIXTURES = join(__dirname, 'fixtures', 'larochelle');
const LA_ROCHELLE: Position = { latitude: 46.1591, longitude: -1.1517 };
const NOW = new Date('2026-11-09T07:21:00Z');
const PARIS = 'Europe/Paris';

const at = (iso: string) => new Date(iso);

function source(config: Record<string, unknown> = {}, now = NOW) {
  return createLocalSource(
    { localTidesPath: FIXTURES, localTidesTimezone: PARIS, ...config },
    { debug: vi.fn(), error: vi.fn(), now: () => now },
  );
}

function upcoming(predictor: TablePredictor, now = NOW) {
  return predictor
    .getExtremesPrediction({ start: now, end: new Date(now.getTime() + 7 * 86400_000) })
    .extremes;
}

describe('zonedTimeToUtc', () => {
  it('converts winter and summer local times', () => {
    expect(zonedTimeToUtc(2026, 11, 9, 10, 31, PARIS)).toEqual(at('2026-11-09T09:31:00Z'));
    expect(zonedTimeToUtc(2026, 7, 15, 12, 0, PARIS)).toEqual(at('2026-07-15T10:00:00Z'));
  });

  it('uses the right offset on the day daylight saving time ends', () => {
    // 2026-10-25: 03:00 CEST becomes 02:00 CET
    expect(zonedTimeToUtc(2026, 10, 25, 1, 0, PARIS)).toEqual(at('2026-10-24T23:00:00Z'));
    expect(zonedTimeToUtc(2026, 10, 25, 3, 34, PARIS)).toEqual(at('2026-10-25T02:34:00Z'));
    expect(zonedTimeToUtc(2026, 10, 25, 15, 53, PARIS)).toEqual(at('2026-10-25T14:53:00Z'));
  });

  it('moves a time that does not exist forward', () => {
    // 2026-03-29: 02:00 CET becomes 03:00 CEST
    expect(zonedTimeToUtc(2026, 3, 29, 2, 30, PARIS)).toEqual(at('2026-03-29T01:30:00Z'));
  });
});

describe('parseTideTable', () => {
  it('reads times in the station timezone, heights and coefficients', () => {
    const extremes = parseTideTable(
      {
        '2026-11-09': [
          ['tide.low', '10:31', '1.43m', '---'],
          ['tide.high', '04:05', '5.94m', '84'],
        ],
      },
      PARIS,
    );

    expect(extremes).toEqual([
      tableExtreme(true, at('2026-11-09T03:05:00Z'), 5.94, 84),
      tableExtreme(false, at('2026-11-09T09:31:00Z'), 1.43, null),
    ]);
    expect(extremes[0].label).toBe('High');
    expect(extremes[1].label).toBe('Low');
  });

  it('skips malformed rows instead of reading a wrong height', () => {
    // A real row of the 2026-01 La Rochelle file: parseFloat would read 12 m
    const onSkip = vi.fn();
    const extremes = parseTideTable(
      {
        '2026-01-21': [
          ['tide.high', '06:09', '5.7m', '75'],
          ['tide.low', '12:28', '12:28m', '---'],
          ['tide.low', '--:--', '---', '---'],
          ['tide.slack', '13:00', '3m', '---'],
        ],
        'not a day': [['tide.high', '06:09', '5.7m', '75']],
      },
      PARIS,
      onSkip,
    );

    expect(extremes).toHaveLength(1);
    expect(extremes[0].level).toBe(5.7);
    expect(onSkip).toHaveBeenCalledTimes(3);
  });

  it('returns nothing for something that is not a table', () => {
    expect(parseTideTable(null, PARIS)).toEqual([]);
    expect(parseTideTable([1, 2], PARIS)).toEqual([]);
  });
});

describe('heightFromExtremes', () => {
  const low = tableExtreme(false, at('2026-11-09T21:50:00Z'), 1.46);
  const high = tableExtreme(true, at('2026-11-10T03:32:00Z'), 5.96);
  const range = high.level - low.level;
  const span = high.time.getTime() - low.time.getTime();
  const after = (fraction: number) => new Date(low.time.getTime() + span * fraction);

  it('gives the extreme heights at the extremes', () => {
    expect(heightFromExtremes([low, high], low.time)).toBe(1.46);
    expect(heightFromExtremes([low, high], high.time)).toBe(5.96);
  });

  it('follows the Rule of Twelfths between two extremes', () => {
    // 3/12 of the range after two sixths, 6/12 at half time, 9/12 after four sixths
    expect(heightFromExtremes([low, high], after(2 / 6))).toBeCloseTo(low.level + range * 3 / 12, 2);
    expect(heightFromExtremes([low, high], after(3 / 6))).toBeCloseTo(low.level + range * 6 / 12, 2);
    expect(heightFromExtremes([low, high], after(4 / 6))).toBeCloseTo(low.level + range * 9 / 12, 2);
    // The cosine is the smooth form of the twelfths: within 2 % of the range on each sixth
    const twelfths = [0, 1, 3, 6, 9, 11, 12];
    for (let sixth = 0; sixth <= 6; sixth += 1) {
      expect(Math.abs(harmonicHeight(0, 1, sixth / 6) - twelfths[sixth] / 12)).toBeLessThan(0.02);
    }
  });

  it('interpolates across midnight on absolute times', () => {
    // Low at 22:50 and high at 04:32, local time: midnight is in between
    const midnight = at('2026-11-09T23:00:00Z');
    const height = heightFromExtremes([high, low], midnight)!;
    const progress = (midnight.getTime() - low.time.getTime()) / span;
    expect(height).toBeCloseTo(harmonicHeight(low.level, high.level, progress), 3);
    expect(height).toBeGreaterThan(low.level);
    expect(height).toBeLessThan(low.level + range / 2);

    // Rising steadily from the low to the high, through midnight
    let previous = low.level;
    for (let minutes = 10; minutes < span / 60_000; minutes += 10) {
      const h = heightFromExtremes([low, high], new Date(low.time.getTime() + minutes * 60_000))!;
      expect(h).toBeGreaterThanOrEqual(previous);
      previous = h;
    }
  });

  it('repeats the last half-cycle after the table ends', () => {
    const later = new Date(high.time.getTime() + span);
    expect(heightFromExtremes([low, high], later)).toBeCloseTo(low.level, 1);
  });

  it('returns null without extremes', () => {
    expect(heightFromExtremes([], NOW)).toBeNull();
  });
});

describe('coefficientAt', () => {
  it('takes the coefficient of the nearest high water', () => {
    const extremes = [
      tableExtreme(true, at('2026-11-09T03:05:00Z'), 5.94, 84),
      tableExtreme(false, at('2026-11-09T09:31:00Z'), 1.43, null),
      tableExtreme(true, at('2026-11-09T15:22:00Z'), 5.89, 80),
    ];
    expect(coefficientAt(extremes, at('2026-11-09T07:00:00Z'))).toBe(84);
    expect(coefficientAt(extremes, at('2026-11-09T10:00:00Z'))).toBe(80);
    expect(coefficientAt(extremes.slice(1, 2), NOW)).toBeNull();
  });
});

describe('local source', () => {
  it('loads the next tides of La Rochelle', async () => {
    const predictor = await source().resolve(null);
    const [first, second] = upcoming(predictor);

    expect(predictor.name).toBe('larochelle');
    expect(first).toMatchObject({ label: 'Low', level: 1.43, time: at('2026-11-09T09:31:00Z') });
    expect(second).toMatchObject({ label: 'High', level: 5.89, time: at('2026-11-09T15:22:00Z'), coefficient: 84 });
    expect(predictor.getCoefficientAtTime({ time: NOW })).toBe(84);

    // Falling from the 03:05Z high (5.94 m) to the 09:31Z low (1.43 m)
    const { level } = predictor.getWaterLevelAtTime({ time: NOW });
    const progress = (NOW.getTime() - at('2026-11-09T03:05:00Z').getTime()) / (6 * 3600_000 + 26 * 60_000);
    expect(level).toBeCloseTo(harmonicHeight(5.94, 1.43, progress), 3);
    expect(level).toBeCloseTo(2.58, 2);
  });

  it('keeps the previous day, so the height after midnight is interpolated', async () => {
    const justAfterMidnight = at('2026-11-09T23:30:00Z'); // 00:30 in Paris
    const predictor = await source({}, justAfterMidnight).resolve(null);
    // Low 22:50 local (21:50Z) on 9 November, high 04:32 local (03:32Z) on 10 November
    const progress =
      (justAfterMidnight.getTime() - at('2026-11-09T21:50:00Z').getTime()) /
      (at('2026-11-10T03:32:00Z').getTime() - at('2026-11-09T21:50:00Z').getTime());
    expect(predictor.getWaterLevelAtTime({ time: justAfterMidnight }).level).toBeCloseTo(
      harmonicHeight(1.46, 5.96, progress),
      3,
    );
  });

  it('reads across months and the end of daylight saving time', async () => {
    const predictor = await source({}, at('2026-10-24T12:00:00Z')).resolve(null);
    const extremes = upcoming(predictor, at('2026-10-24T12:00:00Z'));

    // 16:18 CEST on the 24th, 03:34 CET on the 25th, and on into November
    expect(extremes[0]).toMatchObject({ label: 'High', time: at('2026-10-24T14:18:00Z'), coefficient: 82 });
    expect(extremes[2]).toMatchObject({ label: 'High', time: at('2026-10-25T02:34:00Z'), coefficient: 87 });

    // A week from the end of October reads the November file too
    const endOfMonth = at('2026-10-30T12:00:00Z');
    const acrossMonths = upcoming(await source({}, endOfMonth).resolve(null), endOfMonth);
    expect(acrossMonths[0].time.getTime()).toBeLessThan(at('2026-10-31T00:00:00Z').getTime());
    expect(acrossMonths.at(-1)!.time.getTime()).toBeGreaterThan(at('2026-11-06T00:00:00Z').getTime());
  });

  it('takes the timezone of the nearest station from the position', async () => {
    const predictor = await source({ localTidesTimezone: '' }).resolve(LA_ROCHELLE);
    expect(upcoming(predictor)[0].time).toEqual(at('2026-11-09T09:31:00Z'));
  });

  it('ignores an unknown timezone', async () => {
    const error = vi.fn();
    const predictor = await createLocalSource(
      { localTidesPath: FIXTURES, localTidesTimezone: 'Mars/Olympus' },
      { debug: vi.fn(), error, now: () => NOW },
    ).resolve(LA_ROCHELLE);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Mars/Olympus'));
    expect(upcoming(predictor)[0].time).toEqual(at('2026-11-09T09:31:00Z'));
  });

  it('publishes the configured station name', async () => {
    const predictor = await source({ localStationName: 'La Rochelle' }).resolve(null);
    expect(predictor.name).toBe('La Rochelle');
  });

  it('fails without a path, or when the files have no upcoming tide', async () => {
    await expect(source({ localTidesPath: '' }).resolve(null)).rejects.toThrow('not configured');
    await expect(source({}, at('2027-03-01T00:00:00Z')).resolve(null)).rejects.toThrow('No upcoming tides');
  });
});

describe('SHOM responses', () => {
  it('reads the tide table format', () => {
    const extremes = parseHlt({ '2026-11-09': [['tide.high', '16:22', '5.89m', '84']] });
    expect(extremes).toEqual([tableExtreme(true, at('2026-11-09T15:22:00Z'), 5.89, 84)]);
  });

  it('reads a list of entries', () => {
    const extremes = parseHlt({
      hlt: [
        { dt: '2026-11-09T09:31:00Z', hauteur: 1.43, type: 'BM' },
        { dt: '2026-11-09T15:22:00Z', hauteur: 5.89, type: 'PM', coef: 84 },
        { dt: 'never', hauteur: 1, type: 'PM' },
      ],
    });
    expect(extremes).toEqual([
      tableExtreme(false, at('2026-11-09T09:31:00Z'), 1.43, null),
      tableExtreme(true, at('2026-11-09T15:22:00Z'), 5.89, 84),
    ]);
  });
});

describe('plugin with the local source', () => {
  let plugin: Plugin | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    plugin?.stop?.();
    plugin = undefined;
    vi.useRealTimers();
  });

  function buildApp() {
    let onPositionDelta: (() => Promise<void>) | undefined;
    let position: Position | null = null;
    const app = {
      debug: Object.assign(vi.fn(), { enabled: false }),
      error: vi.fn(),
      setPluginStatus: vi.fn(),
      setPluginError: vi.fn(),
      selfId: 'urn:mrn:imo:mmsi:000000000',
      use: vi.fn(),
      getDataDirPath: vi.fn(() => mkdtempSync(join(tmpdir(), 'signalk-tides-test-'))),
      readPluginOptions: vi.fn(() => ({})),
      registerResourceProvider: vi.fn(),
      handleMessage: vi.fn(),
      getSelfPath: vi.fn((path: string) => (path === 'navigation.position.value' ? position : undefined)),
      subscriptionmanager: {
        subscribe: vi.fn((subscription: { subscribe?: { path?: string }[] }, _u: unknown, _e: unknown, onDelta: () => Promise<void>) => {
          if (subscription.subscribe?.some((s) => s.path === 'navigation.position')) onPositionDelta = onDelta;
        }),
      },
    };
    return {
      app: app as unknown as ServerAPI,
      async sendPosition(newPosition: Position) {
        position = newPosition;
        await onPositionDelta?.();
      },
    };
  }

  function values(app: ServerAPI): Record<string, unknown> {
    const delta = vi.mocked(app.handleMessage).mock.calls.at(-1)![1];
    return Object.fromEntries(
      (delta.updates ?? [])
        .flatMap((update) => ('values' in update ? (update.values ?? []) : []))
        .map(({ path, value }) => [path, value]),
    );
  }

  // The settings of the production server, unchanged
  const PRODUCTION = { source: 'local', localTidesPath: FIXTURES, period: 60 };

  it('publishes the tides and the coefficient of the local files', async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start(PRODUCTION, () => {});
    await sendPosition(LA_ROCHELLE);

    const published = values(app);
    expect(published).toMatchObject({
      'environment.tide.stationName': 'larochelle',
      'environment.tide.datum': 'CD',
      'environment.tide.state': 'falling',
      'environment.tide.heightLow': 1.43,
      'environment.tide.timeLow': '2026-11-09T09:31:00.000Z',
      'environment.tide.heightHigh': 5.89,
      'environment.tide.timeHigh': '2026-11-09T15:22:00.000Z',
      'environment.tide.timeToNextExtreme': 2 * 3600 + 10 * 60,
      'environment.tide.coefficient': 84,
    });
    expect(published['environment.tide.heightNow']).toBeCloseTo(2.58, 2);
    expect(app.setPluginStatus).toHaveBeenLastCalledWith('Updated tide forecast from larochelle (Local files)');
  });

  it('serves the tides resource without a position', async () => {
    const { app } = buildApp();
    plugin = createPlugin(app);
    await plugin.start(PRODUCTION, () => {});
    vi.mocked(app.getSelfPath).mockReturnValue(undefined);

    const resources = vi.mocked(app.registerResourceProvider).mock.calls.find(([p]) => p.type === 'tides')![0];
    const collection = (await resources.methods.listResources({})) as unknown as TideResourceCollection;
    const today = Object.values(collection).find((f) => f.properties.date === '2026-11-09')!;

    expect(Object.keys(collection)).toContain('urn:mrn:signalk:uuid:tides:larochelle:2026-11-09');
    expect(today.properties).toMatchObject({ name: 'larochelle', source: 'local', datum: 'CD', coefficient: 84 });
    expect(today.properties.extremes).toContainEqual({
      type: 'High',
      value: 5.89,
      time: '2026-11-09T15:22:00.000Z',
      coefficient: 84,
    });
    expect(today.properties.heightNow).toBeCloseTo(2.58, 2);
    expect(await resources.methods.getResource('urn:mrn:signalk:uuid:tides:larochelle:2026-11-10')).toMatchObject({
      properties: { date: '2026-11-10' },
    });
  });

  it('reports a missing folder', async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({ ...PRODUCTION, localTidesPath: join(FIXTURES, 'missing') }, () => {});
    await sendPosition(LA_ROCHELLE);

    expect(app.setPluginError).toHaveBeenCalledWith(expect.stringContaining('No upcoming tides'));
  });

  it('keeps Slackwater for an unknown source', async () => {
    const { app, sendPosition } = buildApp();
    plugin = createPlugin(app);
    await plugin.start({ source: 'worldtides' }, () => {});
    await sendPosition(LA_ROCHELLE);

    expect(values(app)['environment.tide.stationName']).not.toBe('larochelle');
    expect(values(app)).not.toHaveProperty('environment.tide.coefficient');
  });
});
