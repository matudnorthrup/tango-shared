# open_meteo_weather

Open-Meteo — free weather API. No API key required.

## Current weather
```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true&temperature_unit=fahrenheit
```

### Response
```json
{
  "current_weather": {
    "temperature": 62.5,
    "windspeed": 15.3,
    "winddirection": 225,
    "weathercode": 3,
    "time": "2026-03-10T14:00"
  }
}
```
- `temperature` — Fahrenheit (as requested in URL)
- `windspeed` — **km/h** (divide by 1.609 for mph)
- `winddirection` — degrees (0=N, 90=E, 180=S, 270=W)
- `weathercode` — WMO code (0=clear, 1-3=partly cloudy to overcast, 51-67=rain, 71-77=snow, 95-99=thunderstorm)

## Hourly forecast
```
https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&hourly=temperature_2m,precipitation_probability,windspeed_10m&temperature_unit=fahrenheit&forecast_days=2
```

## Usage rules

- Pair with `location_read` to get coordinates for weather at the user's current position.
- When reporting wind, always convert to mph.
- For driving conditions, check wind speed and precipitation — high crosswinds and rain affect large vehicles especially.
