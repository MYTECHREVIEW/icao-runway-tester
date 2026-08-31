# ICAO Runway Analyzer & Touchdown Tester 🛬

High-precision ICAO runway touchdown analyzer with real-time FAA D-ATIS, VATSIM Network ATIS, IVAO Network ATIS, AviationWeather Live METAR feeds, and Mapbox Static Images API.

## 🚀 Features
- **Accurate Geodetic Centerline Precision:** Certified FAA GIS survey coordinates (sub-decimeter accuracy).
- **Interactive Map:** Clean satellite imagery with precision runway polygons, markings, and headings.
- **Touchdown & Deviation Telemetry:** Cross-track centerline deviation (ft/m, side), touchdown distance from threshold (ft/m), and touchdown zones (TZ1/TZ2/TZ3).
- **Multi-Source Operational ATIS & Weather Suite:**
  - Real-World FAA Digital ATIS (`datis.clowd.io`)
  - VATSIM Global Controller ATIS (`data.vatsim.net`)
  - IVAO Global Network ATIS (`api.ivao.aero`)
  - NOAA AviationWeather Live METAR (`aviationweather.gov`)
- **Developer REST API & Key Management:** Secure `/api/v1/*` endpoints for third-party flight sim apps, electronic flight bags (EFB), and loggers.
- **Mapbox Static Map Images:** Generate high-resolution static landing snapshots with Fire Red pinpoint markers.
- **Admin Control Panel:** Built-in `/admin` panel to generate, enable/disable, and monitor API keys.

---


### 🎨 Unified Runway Overlays & Dot Styling
When touchdown coordinates are pushed via the API, URL parameters, or `postMessage`, the system provides **100% visual continuation** across web maps, mobile apps, and Mapbox static images:
- **🟢 Active Lit Runway Polygon:** Emerald green boundary (`#00ff88`, `0.18` fill opacity, `2.5px` border) highlighting the surveyed active runway pavement.
- **🔴 Closed Runway Warning:** Crimson overlay (`#ff4757`, `0.35` fill opacity, `3.5px` border) for NOTAM-closed runways.
- **⚪ Runway Centerline:** Surveyed geodetic centerline (`#ffffff`, `2.0px` width, `8,6` dash).
- **🔴 Centerline Deviation Vector:** Perpendicular vector (`#ff1e42`, `3.5px` width, `5,5` dash) showing cross-track deviation distance and side.
- **🟢 Centerline Intersection Point:** Projection point with emerald green halo ring (`#00ff88`).
- **🎯 3-Tier Target Reticle:** Glowing outer halo (`10.5m` radius @ `35%` opacity), main target ring (`6.5m` radius with white border), and pinpoint core (`2.0m`). Color-coded: Fire Red (on runway), Crimson (closed), Amber (taxiway), Orange (off-airfield).
- **🖼️ High-Res Mapbox Static Images:** All static map images (`GET /api/v1/map/static` and `/api/v1/touchdown`) embed this complete GeoJSON overlay directly at calibrated **Zoom 16**.

---

## 📡 Developer REST API & Integration

Complete developer reference, styling tokens, and multi-language implementation guides are in [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).

### Endpoints Overview

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/touchdown` | **Core Landing Telemetry:** Evaluates touchdown coordinates, calculates centerline deviation, threshold distance, touchdown zone, headwind/crosswind, landing rating, GeoJSON overlay, and static map URLs. |
| `GET` | `/api/v1/map/static` | **Mapbox Static Images:** Streams PNG binary or returns JSON with embedded GeoJSON runway overlay & touchdown reticle. |
| `GET` | `/api/v1/airport/:icao` | Full airport metadata, elevation, geographic coordinates, and classification. |
| `GET` | `/api/v1/airport/:icao/runways` | All calibrated runways with coordinates, true headings, length, width, and surface. |
| `GET` | `/api/v1/airports/search?q=` | Search 85,917 airports by ICAO, IATA, name, or city. |
| `GET` | `/api/v1/airport/:icao/weather` | Live operational weather suite: FAA D-ATIS, VATSIM ATIS, IVAO ATIS, and NOAA METAR. |
| `GET` | `/api/v1/airport/:icao/notams` | Active airport NOTAMs and closed runway designator alerts. |

### Dynamic Field & Metric Query Filtering

Filter returned response fields to minimize bandwidth and tailor JSON outputs:
```bash
# Query only specific JSON blocks and telemetry metrics:
curl -X POST "https://your-server.com/api/v1/touchdown?fields=touchdown,map_styling,static_map&metrics=dev,fpm,g" \
  -H "X-API-Key: rwy_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"lat": 40.77665, "lon": -73.87185, "vertical_speed_fpm": -135, "g_force": 1.14, "ias_kt": 132, "heading": 212}'
```

### Quick Example (cURL)

```bash
# Analyze a touchdown at LaGuardia (KLGA)
curl -X POST https://your-server.com/api/v1/touchdown \
  -H "X-API-Key: rwy_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "lat": 40.77665,
    "lon": -73.87185,
    "heading": 212,
    "vertical_speed_fpm": -135,
    "ias_kt": 132,
    "g_force": 1.14
  }'
```

### Deep Linking Coordinates directly into the Map
External apps can open or embed the web map with touchdown coordinates automatically:

```
https://your-server.com/?touchdown=40.77665,-73.87185&fpm=-135&ias=132&g=1.14&hdg=212&zoom=18
```

👉 **See the complete documentation with JavaScript, Python, C#, and Swift examples in [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).**

---

## 🐳 TrueNAS / Portainer / Docker Deployment

### Option A: Deploy via Docker Compose
```yaml
version: '3.8'

services:
  icao-runway-analyzer:
    container_name: icao-runway-analyzer
    image: ghcr.io/mytechreview/icao-runway-tester:latest
    restart: unless-stopped
    ports:
      - "3500:3500"
    volumes:
      - ./data:/app/data   # Persist API keys and calibration data
    environment:
      - PORT=3500
      - NODE_ENV=production
      - ADMIN_KEY=your_secret_admin_key   # Protects /admin control panel
      - API_KEY=your_master_api_key       # Optional fallback API key
```

### Option B: Local Development Launchers

You can launch and stop the local development server with single-click launchers without opening a terminal:

- **🎨 Visual GUI Launcher:** Double-click [`Launch-GUI.bat`](file:///Z:/icao-runway-tester/Launch-GUI.bat) or [`Launch-GUI.vbs`](file:///Z:/icao-runway-tester/Launch-GUI.vbs) to open the dark-themed desktop controller with real-time status, Start/Stop/Restart, and Open UI buttons.
- **⚡ Quick Start:** Double-click [`start-server.bat`](file:///Z:/icao-runway-tester/start-server.bat) to launch the Node server and open your browser automatically.
- **🛑 Quick Stop:** Double-click [`stop-server.bat`](file:///Z:/icao-runway-tester/stop-server.bat) to cleanly terminate the server on port 3500.
- **📋 Interactive Console Menu:** Double-click [`launcher.bat`](file:///Z:/icao-runway-tester/launcher.bat) for an interactive terminal menu.
- **📌 Desktop Shortcuts:** Double-click [`create-desktop-shortcut.bat`](file:///Z:/icao-runway-tester/create-desktop-shortcut.bat) to place shortcuts directly on your Windows Desktop.

```bash
# Or manual terminal command:
npm start
```

Visit `http://localhost:3500` for the map and `http://localhost:3500/admin` for the API key manager.

---

## 🚀 Deploying Changes to Production

When you make runway calibration edits in development, deploy to production with:

```bash
# Commit & push to GitHub (triggers GitHub Actions Docker build)
./deploy.sh "feat: updated runway positions for KJFK"
```
Or use the **Deploy** button inside the `/admin` web interface.
