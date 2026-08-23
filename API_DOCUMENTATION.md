# 📡 ICAO Runway Analyzer — REST API & Map Integration Reference

High-precision runway touchdown telemetry, certified geodetic runway data, multi-source weather/ATIS, and Mapbox static image generation API for third-party flight simulator tools, mobile EFBs, and logbook apps.

---

## 📑 Table of Contents
1. [Authentication](#-authentication)
2. [Endpoints Directory](#-endpoints-directory)
3. [Endpoints Reference](#-endpoints-reference)
   - [POST /api/v1/touchdown (Core Landing Telemetry)](#1-analyze-touchdown-telemetry-post-apiv1touchdown)
   - [GET /api/v1/map/static (Mapbox Static Map Images)](#2-mapbox-static-landing-map-images-get-apiv1mapstatic)
   - [GET /api/v1/airport/:icao (Airport Info)](#3-get-airport-info-get-apiv1airporticao)
   - [GET /api/v1/airport/:icao/runways (Calibrated Runways Array)](#4-get-airport-runways-get-apiv1airporticaorunways)
   - [GET /api/v1/airports/search (Airport Database Search)](#5-search-airports-get-apiv1airportssearch)
   - [GET /api/v1/airport/:icao/weather (Live METAR & ATIS)](#6-get-airport-weather--atis-get-apiv1airporticaoweather)
   - [GET /api/v1/airport/:icao/notams (Active NOTAMs)](#7-get-airport-notams-get-apiv1airporticaonotams)
4. [Pushing Coordinates into the Web Map](#-pushing-touchdown-coordinates-into-the-web-map)
5. [Code Examples](#-code-examples)
   - [JavaScript / TypeScript (Fetch)](#javascript--typescript-fetch)
   - [Python (Requests)](#python-requests)
   - [C# / .NET (HttpClient)](#c--net-httpclient)
   - [Swift / iOS (URLSession)](#swift--ios-urlsession)

---

## 🔑 Authentication

All `/api/v1/*` endpoints require an API Key passed in the `X-API-Key` HTTP header.

```http
X-API-Key: rwy_your_api_key_here
```

> 💡 **Creating API Keys**: Administrators can generate, enable/disable, and track API keys via the web interface at `/admin` (e.g. `https://your-server.com/admin`).

---

## 📡 Endpoints Directory

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/touchdown` | **Core Landing Telemetry:** Evaluates touchdown coordinates, centerline deviation, threshold distance, touchdown zone, winds, rating, and static map links. |
| `GET` | `/api/v1/map/static` | **Mapbox Static Images:** Generates standalone high-res satellite or dark mode landing screenshot with Fire Red pinpoint. |
| `GET` | `/api/v1/airport/:icao` | Get full airport metadata, elevation, geographic coordinates, and classification. |
| `GET` | `/api/v1/airport/:icao/runways` | Get all calibrated runways for an airport with coordinates, true headings, length, width, and surface. |
| `GET` | `/api/v1/airports/search?q=` | Instant search across 85,917 airports by ICAO, IATA, name, or city. |
| `GET` | `/api/v1/airport/:icao/weather` | Live operational weather suite: FAA D-ATIS, VATSIM ATIS, IVAO ATIS, and NOAA METAR. |
| `GET` | `/api/v1/airport/:icao/notams` | Active airport NOTAMs and closed runway designator alerts. |

---

## 📖 Endpoints Reference

### 1. Analyze Touchdown Telemetry (`POST /api/v1/touchdown`)

Calculates exact cross-track centerline deviation and along-track threshold distance against surveyed runway centerlines and displaced thresholds.

#### Request Headers
```http
Content-Type: application/json
X-API-Key: rwy_your_api_key_here
```

#### Request Body (JSON)
```json
{
  "lat": 40.77665,
  "lon": -73.87185,
  "heading": 212,
  "vertical_speed_fpm": -135,
  "ias_kt": 132,
  "g_force": 1.14,
  "bank_deg": 1.2,
  "pitch_deg": 4.5,
  "icao": "KLGA"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `lat` | `number` | **Yes** | Touchdown GPS latitude (decimal degrees, e.g. `40.77665`). |
| `lon` | `number` | **Yes** | Touchdown GPS longitude (decimal degrees, e.g. `-73.87185`). |
| `heading` | `number` | No | Aircraft true or magnetic heading at touchdown (0–360°). |
| `vertical_speed_fpm` | `number` | No | Landing sink rate in feet per minute (e.g. `-135`). |
| `ias_kt` | `number` | No | Indicated airspeed at touchdown in knots. |
| `g_force` | `number` | No | Peak vertical impact G-load. |
| `bank_deg` | `number` | No | Bank angle in degrees at touchdown. |
| `pitch_deg` | `number` | No | Pitch angle in degrees at touchdown. |
| `icao` | `string` | No | Airport ICAO code. Auto-detected from nearest spatial grid if omitted. |

---

#### Response (On-Runway Touchdown - JSON)
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
  "static_map": {
    "satellite_url": "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/pin-s+ff1e42(-73.87185,40.77665)/-73.87185,40.77665,18,0,0/800x500@2x?access_token=...",
    "runway_perspective_url": "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/pin-s+ff1e42(-73.87185,40.77665)/-73.87185,40.77665,18,212,25/800x500@2x?access_token=...",
    "dark_mode_url": "https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/pin-s+ff1e42(-73.87185,40.77665)/-73.87185,40.77665,18,0,0/800x500@2x?access_token=...",
    "direct_image_api": "/api/v1/map/static?lat=40.77665&lon=-73.87185&zoom=18&style=satellite"
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
    }
  ],
  "weather": {
    "metar_raw": "KLGA 222051Z 06011KT 10SM SCT030TCU BKN048 24/19 A2995",
    "atis_raw": "LGA ATIS INFO X 2151Z. 06011KT 10SM..."
  }
}
```

---

#### Response (Off-Airfield Landing - JSON)
When the touchdown occurs outside an airfield or airstrip bounds:
```json
{
  "status": "off_airfield",
  "touchdown_coordinates": {
    "latitude": 41.250000,
    "longitude": -74.150000
  },
  "nearest_airport": {
    "label": "Near 0NY2 - Amar Heliport",
    "icao": "0NY2",
    "name": "Amar Heliport",
    "city": "Stony Point",
    "country": "US",
    "distance_nm": 4.8,
    "distance_km": 8.8
  },
  "static_map": {
    "satellite_url": "https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/pin-s+ff1e42(-74.15,41.25)/-74.15,41.25,18,0,0/800x500@2x?access_token=...",
    "direct_image_api": "/api/v1/map/static?lat=41.25&lon=-74.15&zoom=18"
  },
  "message": "Touchdown located off-airfield near 0NY2 (Amar Heliport, 4.8 NM away)."
}
```

---

### 2. Mapbox Static Landing Map Images (`GET /api/v1/map/static`)

Generates a standalone, high-resolution static satellite or dark-mode screenshot with the Fire Red precision touchdown target dot.

#### Request
```http
GET /api/v1/map/static?lat=40.77665&lon=-73.87185&zoom=18&width=800&height=500&style=satellite
X-API-Key: rwy_your_api_key_here
```

#### Query Parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `lat` | `number` | **Required** | Latitude of landing point. |
| `lon` | `number` | **Required** | Longitude of landing point. |
| `zoom` | `number` | `18` | Mapbox zoom level (`1` to `20`). |
| `width` | `number` | `800` | Image width in pixels (max: `1280`). |
| `height` | `number` | `500` | Image height in pixels (max: `1280`). |
| `bearing` | `number` | `0` | Map rotation in degrees (0–360°). Set to runway heading to align runway vertically! |
| `pitch` | `number` | `0` | 3D perspective angle (0–60°). |
| `style` | `string` | `satellite` | Map style: `satellite` (`satellite-v9`), `dark` (`dark-v11`), `satellite-streets`, or `streets`. |
| `format` | `string` | `image` | Output format: `image` (streams raw PNG image), `json` (returns URLs and metadata), or `redirect` (302 redirect). |

#### Direct Binary Image Stream (Default)
Returns raw binary image with headers:
```http
HTTP/1.1 200 OK
Content-Type: image/png
Cache-Control: public, max-age=86400
```

---

### 3. Get Airport Info (`GET /api/v1/airport/:icao`)

#### Request
```http
GET /api/v1/airport/KJFK
X-API-Key: rwy_your_api_key_here
```

#### Response
```json
{
  "icao": "KJFK",
  "iata": "JFK",
  "name": "John F. Kennedy International Airport",
  "city": "New York",
  "country": "US",
  "latitude": 40.639447,
  "longitude": -73.779317,
  "elevation_ft": 13,
  "type": "large_airport"
}
```

---

### 4. Get Airport Runways (`GET /api/v1/airport/:icao/runways`)

Returns all runways with surveyed threshold coordinates, true headings, and surface type.

#### Request
```http
GET /api/v1/airport/KJFK/runways
X-API-Key: rwy_your_api_key_here
```

#### Response
```json
{
  "icao": "KJFK",
  "runway_count": 4,
  "runways": [
    {
      "le_ident": "04L",
      "he_ident": "22R",
      "length_ft": 12079,
      "width_ft": 200,
      "surface": "concrete",
      "le_heading_degT": 43.8,
      "he_heading_degT": 223.8,
      "le_latitude_deg": 40.632128,
      "le_longitude_deg": -73.791556,
      "he_latitude_deg": 40.656094,
      "he_longitude_deg": -73.761761,
      "is_closed": false,
      "lighted": true
    }
  ]
}
```

---

### 5. Search Airports (`GET /api/v1/airports/search`)

Searches across the internal database of **85,917 airports**.

#### Request
```http
GET /api/v1/airports/search?q=London
X-API-Key: rwy_your_api_key_here
```

#### Response (Array)
```json
[
  {
    "icao": "EGLL",
    "iata": "LHR",
    "name": "London Heathrow Airport",
    "city": "London",
    "country": "GB",
    "latitude": 51.4706,
    "longitude": -0.461941,
    "elevation_ft": 83
  }
]
```

---

### 6. Get Airport Weather & ATIS (`GET /api/v1/airport/:icao/weather`)

#### Request
```http
GET /api/v1/airport/KLGA/weather
X-API-Key: rwy_your_api_key_here
```

#### Response
```json
{
  "icao": "KLGA",
  "sources": {
    "real_world": {
      "source": "FAA D-ATIS",
      "code": "X",
      "text": "LGA ATIS INFO X 2151Z. 06011KT 10SM...",
      "timestamp": "2026-08-22T21:51:00Z"
    },
    "metar": {
      "source": "AviationWeather",
      "text": "KLGA 222051Z 06011KT 10SM SCT030TCU BKN048 24/19 A2995",
      "altimeter_inHg": 29.95,
      "altimeter_hPa": 1014
    }
  }
}
```

---

### 7. Get Airport NOTAMs (`GET /api/v1/airport/:icao/notams`)

#### Request
```http
GET /api/v1/airport/KLGA/notams
X-API-Key: rwy_your_api_key_here
```

#### Response
```json
{
  "icao": "KLGA",
  "source": "FAA D-ATIS",
  "count": 2,
  "closed_runways": [],
  "notams": [
    {
      "text": "RWY 4 PAPI OTS.",
      "is_closure": false
    },
    {
      "text": "TAXIWAY Y, CLOSED WEST OF RUNWAY 22.",
      "is_closure": true
    }
  ]
}
```

---

## 🎯 Pushing Touchdown Coordinates into the Web Map

External apps can launch or embed the web map directly at the touchdown coordinates with zero manual pin drops:

### 1. URL Query Parameters (Deep Linking)
```
# Direct coordinate focus (Instant Zoom Level 18):
https://your-server.com/?touchdown=40.77665,-73.87185

# Full telemetry deep link:
https://your-server.com/?lat=40.77665&lon=-73.87185&icao=KLGA&fpm=-135&ias=132&g=1.14&zoom=18
```

### 2. `window.postMessage` (For Iframes & Electron Bridges)
```javascript
const iframe = document.getElementById('runwayMapIframe');

iframe.contentWindow.postMessage({
  type: 'TOUCHDOWN',
  lat: 40.77665,
  lon: -73.87185,
  icao: 'KLGA',
  vertical_speed_fpm: -135,
  ias_kt: 132,
  g_force: 1.14,
  heading: 212
}, '*');
```

---

## 💻 Code Examples

### JavaScript / TypeScript (Fetch)

```typescript
const API_BASE = 'https://your-server.com';
const API_KEY = 'rwy_your_api_key_here';

// 1. Submit Touchdown & Parse Results
async function analyzeTouchdown(lat: number, lon: number, fpm?: number, ias?: number) {
  const response = await fetch(`${API_BASE}/api/v1/touchdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY
    },
    body: JSON.stringify({
      lat,
      lon,
      vertical_speed_fpm: fpm,
      ias_kt: ias
    })
  });

  const result = await response.json();

  if (result.touchdown) {
    const td = result.touchdown;
    console.log(`🛬 Runway: ${td.runway_ident}`);
    console.log(`📐 Centerline: ${td.centerline_deviation.text}`);
    console.log(`📏 Threshold Dist: ${td.threshold_distance.distance_from_threshold_ft} ft`);
    console.log(`⭐ Rating: ${td.flight_telemetry.landing_rating}`);
    console.log(`🖼️ Static Map: ${result.static_map.satellite_url}`);
  }

  // Iterate all runways array
  result.all_runways.forEach((rwy: any) => {
    console.log(`Runway ${rwy.runway}: ${rwy.length_ft}ft (${rwy.surface})`);
  });

  return result;
}
```

---

### Python (Requests)

```python
import requests

API_BASE = "https://your-server.com"
API_KEY = "rwy_your_api_key_here"

headers = {
    "Content-Type": "application/json",
    "X-API-Key": API_KEY
}

payload = {
    "lat": 40.77665,
    "lon": -73.87185,
    "heading": 212,
    "vertical_speed_fpm": -135,
    "ias_kt": 132,
    "g_force": 1.14
}

response = requests.post(f"{API_BASE}/api/v1/touchdown", json=payload, headers=headers)
data = response.json()

if "touchdown" in data and data["touchdown"]:
    td = data["touchdown"]
    print(f"🛬 Runway: {td['runway_ident']}")
    print(f"📐 Centerline: {td['centerline_deviation']['text']}")
    print(f"📏 Threshold: {td['threshold_distance']['distance_from_threshold_ft']} ft")
    print(f"⭐ Rating: {td['flight_telemetry']['landing_rating']}")
    print(f"🖼️ Static Map: {data['static_map']['satellite_url']}")
```

---

### C# / .NET (HttpClient)

```csharp
using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

class Program
{
    private static readonly HttpClient client = new HttpClient();

    static async Task Main()
    {
        client.BaseAddress = new Uri("https://your-server.com/");
        client.DefaultRequestHeaders.Add("X-API-Key", "rwy_your_api_key_here");

        var payload = new
        {
            lat = 40.77665,
            lon = -73.87185,
            heading = 212,
            vertical_speed_fpm = -135,
            ias_kt = 132,
            g_force = 1.14
        };

        var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        var response = await client.PostAsync("api/v1/touchdown", content);

        var json = await response.Content.ReadAsStringAsync();
        Console.WriteLine(json);
    }
}
```

---

### Swift / iOS (URLSession)

```swift
import Foundation

struct TouchdownRequest: Codable {
    let lat: Double
    let lon: Double
    let heading: Double?
    let vertical_speed_fpm: Double?
    let ias_kt: Double?
    let g_force: Double?
}

func submitTouchdown() {
    guard let url = URL(string: "https://your-server.com/api/v1/touchdown") else { return }
    
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("rwy_your_api_key_here", forHTTPHeaderField: "X-API-Key")
    
    let payload = TouchdownRequest(
        lat: 40.77665,
        lon: -73.87185,
        heading: 212,
        vertical_speed_fpm: -135,
        ias_kt: 132,
        g_force: 1.14
    )
    
    request.httpBody = try? JSONEncoder().encode(payload)
    
    URLSession.shared.dataTask(with: request) { data, response, error in
        guard let data = data, error == nil else { return }
        if let json = try? JSONSerialization.jsonObject(with: data) {
            print(json)
        }
    }.resume()
}
```
