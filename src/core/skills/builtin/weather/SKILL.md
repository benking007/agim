---
name: weather
description: Get current weather and short forecasts. No API key required (wttr.in + Open-Meteo). Use when the user asks for weather, temperature, rain forecast, or a city's conditions.
always: false
metadata:
  agim:
    requires:
      bins: [curl]
---

# Weather

Two zero-key services. Default to `wttr.in` (compact); fall back to Open-Meteo when the user wants structured JSON or a multi-day forecast in a specific unit.

## wttr.in (primary)

One-liner:
```bash
curl -s "wttr.in/Shanghai?format=3"
# Shanghai: ⛅️ +18°C
```

Compact custom format:
```bash
curl -s "wttr.in/Shanghai?format=%l:+%c+%t+%h+%w"
# Shanghai: ⛅️ +18°C 67% ↘8km/h
```

Today's forecast only (~10 lines):
```bash
curl -s "wttr.in/Shanghai?T&1"
```

Format codes: `%l` location · `%c` condition emoji · `%t` temp · `%h` humidity · `%w` wind · `%m` moon phase

Notes:
- URL-encode spaces: `wttr.in/New+York`
- Airport codes also work: `wttr.in/PEK`
- Units: append `?m` (metric default) or `?u` (USCS)
- Set User-Agent for ANSI-free text: `curl -s -A "curl" "wttr.in/Tokyo?format=3"`

## Open-Meteo (fallback, JSON)

Use when the user wants a multi-day forecast or you need structured fields:
```bash
curl -sG "https://api.open-meteo.com/v1/forecast" \
  --data-urlencode "latitude=31.23" \
  --data-urlencode "longitude=121.47" \
  --data-urlencode "current=temperature_2m,relative_humidity_2m,wind_speed_10m" \
  --data-urlencode "daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" \
  --data-urlencode "timezone=auto"
```

Geocode a city name first if you only have a name:
```bash
curl -sG "https://geocoding-api.open-meteo.com/v1/search" \
  --data-urlencode "name=上海" --data-urlencode "count=1"
```

## Output rules

- Quote temperature + condition first, then 1 line of extra context (wind, humidity, rain chance).
- For multi-day, give the next 3 days in a 1-line table:
  `周一 ⛅️ 12-19° · 周二 🌧 9-15° · 周三 ☀️ 14-22°`
- Never paste raw JSON to the user.
