# ICAO Runway Analyzer & Touchdown Tester 🛬

High-precision ICAO runway touchdown analyzer with real-time FAA D-ATIS, VATSIM Network ATIS, IVAO Network ATIS, and AviationWeather Live METAR feeds.

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
- **Admin Control Panel:** Built-in `/admin` panel to generate, enable/disable, and monitor API keys.

---

## 📡 Developer REST API & Integration

Complete, step-by-step developer documentation is available in [API_DOCUMENTATION.md](./API_DOCUMENTATION.md).

### Endpoints Overview

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/v1/touchdown` | **Core Landing Telemetry:** Analyzes landing point coordinates, calculates centerline deviation, threshold distance, touchdown zone, headwind/crosswind, and landing rating. |
| `GET` | `/api/v1/airport/:icao` | Full airport metadata, elevation, geographic coordinates, and classification. |
| `GET` | `/api/v1/airport/:icao/runways` | All calibrated runways with coordinates, headings, length, width, and surface. |
| `GET` | `/api/v1/airports/search?q=` | Search 85,917 airports by ICAO, IATA, name, or city. |
| `GET` | `/api/v1/airport/:icao/weather` | Live operational weather suite: FAA D-ATIS, VATSIM ATIS, IVAO ATIS, and NOAA METAR. |
| `GET` | `/api/v1/airport/:icao/notams` | Active airport NOTAMs and closed runway designator alerts. |

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
    "g_force": 1.14,
    "icao": "KLGA"
  }'
```

### Deep Linking Coordinates directly into the Map
External apps can open or embed the web map with touchdown coordinates automatically:

```
https://your-server.com/?touchdown=40.77665,-73.87185
https://your-server.com/?lat=40.77665&lon=-73.87185&icao=KLGA&fpm=-135&ias=132&g=1.14
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

### Option B: Local Development
```bash
# Install dependencies
npm install

# Start server
PORT=3500 ADMIN_KEY=admin123 npm start
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
