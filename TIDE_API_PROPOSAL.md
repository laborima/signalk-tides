# Tides API — Proposal for SignalK v2

**Author:** [@laborima](https://github.com/laborima)  
**Status:** Draft  
**Target:** SignalK server v2 — new dedicated API endpoint

---

## Motivation

Tidal data is fundamental to safe navigation, yet SignalK has no standardised way to expose tide predictions. The existing [Weather API](https://demo.signalk.org/documentation/Developing/REST_APIs/Weather_API.html) (`/signalk/v2/api/weather`) demonstrates the right pattern for domain-specific, provider-based APIs. Tides deserve the same treatment.

This document proposes a **Tides API** modelled directly on the Weather API, exposing tide predictions at:

```text
/signalk/v2/api/tides
```


## Proposed API

Modelled on the Weather API pattern.

### Endpoints

#### Extremes (High/Low predictions)

```http
GET /signalk/v2/api/tides/extremes?lat=48.38&lon=-4.49
```

Returns the list of high/low tide extremes for the given position over the next 7 days.

**Query parameters:**

| Parameter  | Type         | Default         | Description                          |
|------------|--------------|-----------------|--------------------------------------|
| `lat`      | number       | vessel position | Latitude                             |
| `lon`      | number       | vessel position | Longitude                            |
| `date`     | `YYYY-MM-DD` | today           | Start date                           |
| `days`     | integer      | 7               | Number of days (max 14)              |
| `count`    | integer      | —               | Limit number of extremes returned    |
| `provider` | string       | default         | Force a specific provider plugin id  |

**Response:**

```json
{
  "station": {
    "name": "Brest (SHOM)",
    "position": { "latitude": 48.3833, "longitude": -4.4953 }
  },
  "datum": "CD",
  "units": "m",
  "source": "shom",
  "extremes": [
    { "time": "2025-03-29T00:45:00.000Z", "type": "Low",  "value": 0.025 },
    { "time": "2025-03-29T07:20:00.000Z", "type": "High", "value": 5.812 },
    { "time": "2025-03-29T13:18:00.000Z", "type": "Low",  "value": 0.044 },
    { "time": "2025-03-29T19:45:00.000Z", "type": "High", "value": 5.623 }
  ]
}
```

#### Current height

```http
GET /signalk/v2/api/tides/height?lat=48.38&lon=-4.49
```

Returns the interpolated current tide height (Rule of Twelfths) and the next two extremes.

**Response:**

```json
{
  "station": { "name": "Brest (SHOM)", "position": { "latitude": 48.3833, "longitude": -4.4953 } },
  "datum": "CD",
  "units": "m",
  "source": "shom",
  "heightNow": 3.241,
  "timestamp": "2025-03-29T10:00:00.000Z",
  "next": [
    { "time": "2025-03-29T13:18:00.000Z", "type": "Low",  "value": 0.044 },
    { "time": "2025-03-29T19:45:00.000Z", "type": "High", "value": 5.623 }
  ]
}
```

---

## Provider Management

Identical to the Weather API pattern:

```http
GET  /signalk/v2/api/tides/_providers
GET  /signalk/v2/api/tides/_providers/_default
POST /signalk/v2/api/tides/_providers/_default/{id}
```

**Example — list providers:**

```json
{
  "shom":        { "provider": "SHOM",         "isDefault": true  },
  "noaa":        { "provider": "NOAA",         "isDefault": false },
  "stormglass":  { "provider": "StormGlass.io","isDefault": false },
  "worldtides":  { "provider": "WorldTides",   "isDefault": false },
  "neaps":       { "provider": "Neaps",        "isDefault": false },
  "local":       { "provider": "Local Files",  "isDefault": false }
}
```

---

## OpenAPI Schema (draft)

```yaml
TideExtreme:
  type: object
  required: [time, type, value]
  properties:
    time:
      type: string
      format: date-time
    type:
      type: string
      enum: [High, Low]
    value:
      type: number
      description: Height in meters above datum

TideStation:
  type: object
  required: [name, position]
  properties:
    name:
      type: string
    position:
      type: object
      required: [latitude, longitude]
      properties:
        latitude:  { type: number }
        longitude: { type: number }

TideExtremesResponse:
  type: object
  required: [station, datum, units, source, extremes]
  properties:
    station:  { $ref: '#/components/schemas/TideStation' }
    datum:    { type: string, description: "Tidal datum (CD, MLLW, LAT…)" }
    units:    { type: string, enum: [m] }
    source:   { type: string, description: "Provider plugin id" }
    extremes:
      type: array
      items: { $ref: '#/components/schemas/TideExtreme' }

TideHeightResponse:
  type: object
  required: [station, datum, units, source, heightNow, timestamp, next]
  properties:
    station:    { $ref: '#/components/schemas/TideStation' }
    datum:      { type: string }
    units:      { type: string, enum: [m] }
    source:     { type: string }
    heightNow:  { type: number, description: "Interpolated current height (Rule of Twelfths)" }
    timestamp:  { type: string, format: date-time }
    next:
      type: array
      maxItems: 2
      items: { $ref: '#/components/schemas/TideExtreme' }
```

---

## Adapter / Implementation Notes

The `signalk-tides` plugin already implements the provider logic. The internal `TideForecastResult` maps cleanly to the proposed response format:

| Internal (`TideForecastResult`) | API Response field        |
|---------------------------------|---------------------------|
| `station.name`                  | `station.name`            |
| `station.position`              | `station.position`        |
| `extremes[]`                    | `extremes[]` (unchanged)  |
| computed via Rule of Twelfths   | `heightNow`               |

The `registerResourceProvider()` call would be **replaced** by a `registerTidesProvider()` call (new server API), analogous to `registerWeatherProvider()`.

---

## Backward Compatibility

- The existing `environment.tide.*` delta paths are **preserved** — no breaking change for existing consumers
- The `resources/tides` endpoint can remain as a compatibility shim during transition
- The `signalk-tides` plugin serves as the reference implementation

---

## References

- **Reference implementation:** <https://github.com/bkeepers/signalk-tides>
- **Contributing PR:** <https://github.com/openwatersio/signalk-tides/pull/48>
- **Weather API (model):** <https://demo.signalk.org/documentation/Developing/REST_APIs/Weather_API.html>
