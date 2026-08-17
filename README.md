# ICAO Runway Analyzer & Touchdown Tester 🛬

High-precision ICAO runway touchdown analyzer with real-time FAA D-ATIS, VATSIM Network ATIS, IVAO Network ATIS, and AviationWeather Live METAR feeds.

## 🚀 Features
- **Accurate Geodetic Centerline Precision:** Certified FAA GIS survey coordinates (sub-decimeter accuracy).
- **Interactive Map:** Clean, label-free satellite imagery (Mapbox Maxar, Google Satellite, USGS Orthoimagery).
- **Touchdown & Deviation Telemetry:** Cross-track centerline deviation (ft/m, side), touchdown distance from threshold (ft/m), and touchdown zones (TZ1/TZ2/TZ3).
- **Multi-Source Operational ATIS & Weather Suite:**
  - Real-World FAA Digital ATIS (`datis.clowd.io`)
  - VATSIM Global Controller ATIS (`data.vatsim.net`)
  - IVAO Global Network ATIS (`api.ivao.aero`)
  - NOAA AviationWeather Live METAR (`aviationweather.gov`)
- **Interactive Source Switching & Fallbacks:** Seamlessly switch between Real World ATIS, VATSIM, IVAO, and METAR with automatic failover.

---

## 🐳 TrueNAS / Portainer Deployment

### Option A: Deploy via Portainer Stack (Git Repository)
1. In Portainer, go to **Stacks** ➔ **Add stack**.
2. Select **Repository** as the build method.
3. Set **Repository URL**: `https://github.com/MYTECHREVIEW/icao-runway-tester`
4. Set **Compose path**: `docker-compose.yml`
5. Click **Deploy the stack**.
6. Access the application at `http://<TRUENAS_IP>:3500`.

### Option B: Deploy via Docker Compose (Web Editor)
Paste the following stack into Portainer:

```yaml
version: '3.8'

services:
  icao-runway-analyzer:
    container_name: icao-runway-analyzer
    image: icao-runway-analyzer:latest
    build:
      context: https://github.com/MYTECHREVIEW/icao-runway-tester.git#main
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "3500:3500"
    environment:
      - PORT=3500
      - NODE_ENV=production
```

---

## 💻 Local Development

```bash
# Install dependencies
npm install

# Start development server on port 3500
PORT=3500 npm start
```

Visit `http://localhost:3500` in your browser.
