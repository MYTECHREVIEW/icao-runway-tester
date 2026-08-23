# 🛬 Touchdown GPS & API Fetch Array Integration Guide

This guide explains how to:
1. **Push Touchdown GPS Coordinates directly into the Map** (replacing manual pin drops).
2. **Fetch and Analyze Touchdown Metrics via REST API** (`POST /api/v1/touchdown`).
3. **Parse all response arrays** (Runways, Weather Sources, Search results).

---

## 🎯 1. Pushing Coordinates into the Map (No Manual Pin Drop)

There are **3 ways** to push touchdown coordinates into the web map:

### Method A: URL Query Parameters (Deep Linking)
Your external application (web app, desktop app, or sim browser) can launch or embed the site with coordinates in the URL:

```
# Basic GPS touchdown:
https://your-server.com/?touchdown=40.77665,-73.87185

# Extended with flight telemetry:
https://your-server.com/?lat=40.77665&lon=-73.87185&icao=KLGA&fpm=-135&ias=132&g=1.14
```
*When the page loads, the map automatically centers, flies to the landing spot, drops the pin, and computes the centerline deviation and touchdown zone immediately.*

---

### Method B: Real-Time PostMessage (For Iframes & Electron Bridges)
If the web app is embedded inside an `<iframe>` or child window, your app can push live GPS telemetry dynamically:

```javascript
// From your host application / Electron app / React parent:
const mapIframe = document.getElementById('runwayMapIframe');

mapIframe.contentWindow.postMessage({
  type: 'TOUCHDOWN',
  lat: 40.77665,
  lon: -73.87185,
  icao: 'KLGA',
  vertical_speed_fpm: -135, // or fpm
  ias_kt: 132,              // or ias
  g_force: 1.14,            // or g
  heading: 212
}, '*');
```

---

### Method C: Top Bar "🎯 Touchdown GPS" Modal / Search Box
Users can also click the new **"🎯 Touchdown GPS"** button in the top bar, or directly paste coordinates into the search bar:
- Paste `40.77665, -73.87185` into the search box and press Enter.

---

## 📡 2. REST API: `POST /api/v1/touchdown`

Send the touchdown point to receive instant geodetic analysis.

### Request

- **Endpoint**: `POST /api/v1/touchdown`
- **Headers**:
  - `Content-Type: application/json`
  - `X-API-Key: rwy_your_key_here`
- **Body**:
```json
{
  "lat": 40.77665,
  "lon": -73.87185,
  "heading": 212,
  "vertical_speed_fpm": -135,
  "ias_kt": 132,
  "g_force": 1.14,
  "icao": "KLGA"
}
```

### Response Schema

```json
{
  "status": "on_runway",
  "touchdown_coordinates": {
    "latitude": 40.77665,
    "longitude": -73.87185
  },
  "airport": {
    "icao": "KLGA",
    "iata": "LGA",
    "name": "LaGuardia Airport",
    "city": "New York",
    "country": "US",
    "elevation_ft": 21
  },
  "touchdown": {
    "on_runway": true,
    "runway_ident": "22",
    "runway_pair": "04/22",
    "runway_heading_deg": 212,
    "surface": "asphalt",
    "length_ft": 7002,
    "width_ft": 150,
    "centerline_deviation": {
      "deviation_ft": -12.4,
      "deviation_m": -3.78,
      "side": "left",
      "text": "12.4 ft left"
    },
    "threshold_distance": {
      "distance_from_threshold_ft": 1450.2,
      "distance_from_threshold_m": 442.0,
      "touchdown_zone": "TDZ",
      "remaining_runway_ft": 5551.8,
      "remaining_runway_m": 1692.2,
      "percent_runway_used": 20.7
    },
    "wind": {
      "headwind_kt": 8.2,
      "crosswind_kt": -3.1,
      "summary": "Headwind 8.2kt, 3.1kt from left"
    },
    "flight_telemetry": {
      "aircraft_heading_deg": 212,
      "vertical_speed_fpm": -135,
      "ias_kt": 132,
      "g_force": 1.14,
      "landing_rating": "✨ Good Landing"
    }
  },
  "all_runways": [
    {
      "runway": "04/22",
      "length_ft": 7002,
      "width_ft": 150,
      "surface": "asphalt",
      "active_end": "22",
      "on_runway": true,
      "deviation_ft": -12.4,
      "distance_from_threshold_ft": 1450.2,
      "touchdown_zone": "TDZ",
      "headwind_kt": 8.2,
      "crosswind_kt": -3.1
    },
    {
      "runway": "13/31",
      "length_ft": 7002,
      "width_ft": 150,
      "surface": "asphalt",
      "active_end": "13",
      "on_runway": false,
      "deviation_ft": 756.5,
      "distance_from_threshold_ft": 2658.4,
      "touchdown_zone": "TZ3",
      "headwind_kt": 5.1,
      "crosswind_kt": -9.7
    }
  ],
  "weather": {
    "metar_raw": "KLGA 222051Z 06011KT 10SM SCT030TCU BKN048 24/19 A2995",
    "atis_raw": "LGA ATIS INFO X 2151Z. 06011KT 10SM..."
  }
}
```

---

## 💻 3. Code Examples to Fetch & Parse Arrays

### JavaScript / TypeScript Example

```javascript
const API_URL = 'https://your-server.com';
const API_KEY = 'rwy_your_key_here';

// 1. Submit Touchdown & Parse Results
async function reportTouchdown(touchdownData) {
  const response = await fetch(`${API_URL}/api/v1/touchdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify(touchdownData)
  });

  const data = await response.json();

  if (data.touchdown) {
    const td = data.touchdown;
    console.log(`🛬 Landed on Runway: ${td.runway_ident}`);
    console.log(`📐 Centerline Deviation: ${td.centerline_deviation.text}`);
    console.log(`📏 Distance from Threshold: ${td.threshold_distance.distance_from_threshold_ft} ft (${td.threshold_distance.touchdown_zone})`);
    console.log(`⭐ Landing Rating: ${td.flight_telemetry.landing_rating}`);
  }

  // 2. Iterate all runways array:
  data.all_runways.forEach(rwy => {
    console.log(`Runway ${rwy.runway}: ${rwy.length_ft}ft (${rwy.surface}) - Deviation: ${rwy.deviation_ft}ft`);
  });

  return data;
}

// 2. Fetch Runway Array for an Airport
async function getAirportRunways(icao) {
  const response = await fetch(`${API_URL}/api/v1/airport/${icao}/runways`, {
    headers: { 'X-API-Key': API_KEY }
  });
  const data = await response.json();
  
  // data.runways is an Array:
  data.runways.forEach(rwy => {
    console.log(`Runway ${rwy.le_ident}/${rwy.he_ident}: Heading ${rwy.le_heading_degT}° / ${rwy.he_heading_degT}°`);
  });
  
  return data.runways;
}
```

### Python Example

```python
import requests

API_URL = "https://your-server.com"
API_KEY = "rwy_your_key_here"

headers = {
    "X-API-Key": API_KEY,
    "Content-Type": "application/json"
}

# Post touchdown telemetry
payload = {
    "lat": 40.77665,
    "lon": -73.87185,
    "heading": 212,
    "vertical_speed_fpm": -135,
    "ias_kt": 132,
    "g_force": 1.14,
    "icao": "KLGA"
}

resp = requests.post(f"{API_URL}/api/v1/touchdown", json=payload, headers=headers)
data = resp.json()

if "touchdown" in data and data["touchdown"]:
    td = data["touchdown"]
    print(f"Runway: {td['runway_ident']}")
    print(f"Centerline Deviation: {td['centerline_deviation']['text']}")
    print(f"Distance from Threshold: {td['threshold_distance']['distance_from_threshold_ft']} ft")
    print(f"Rating: {td['flight_telemetry']['landing_rating']}")

# Iterate through all runways
for rwy in data.get("all_runways", []):
    print(f"Runway {rwy['runway']} | Length: {rwy['length_ft']}ft | Surface: {rwy['surface']}")
```
