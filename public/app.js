/**
 * app.js — Runway Analyzer Map Frontend
 * High-Precision Geodetic Alignments, Real-Time NOTAMs & Dynamic Taxiway Network Layer
 */

'use strict';

const MAPBOX_STORAGE_KEY = 'icao_mapbox_token';
const SOURCE_PREF_KEY = 'icao_atis_source_pref';
const SHOW_TAXIWAYS_KEY = 'icao_show_taxiways';

let mapboxToken = localStorage.getItem(MAPBOX_STORAGE_KEY) || '';
let userSourcePref = localStorage.getItem(SOURCE_PREF_KEY) || 'real_world';
let showTaxiways = localStorage.getItem(SHOW_TAXIWAYS_KEY) !== 'false';

// ── State ─────────────────────────────────────────────────────────────────────

let pinMarker         = null;
let runwayLayers      = [];
let devLineLayer      = null;
let lastResult        = null;
let currentCoords     = null;
let selectedRunwayKey = null; // When selected, only this runway is visible on the map!

// ── Tile Layers ───────────────────────────────────────────────────────────────

function getMapboxLayer(token) {
  if (!token) return null;
  return L.tileLayer(`https://api.mapbox.com/styles/v1/mapbox/satellite-v9/tiles/{z}/{x}/{y}?access_token=${token}`, {
    attribution: '&copy; Mapbox &copy; Maxar',
    maxZoom: 22,
    tileSize: 512,
    zoomOffset: -1
  });
}

const fallbackGoogle = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
  attribution: '&copy; Google Maps (Clean Satellite)',
  maxZoom: 21
});

const TILES = {
  googleSat: fallbackGoogle,
  usgs: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; USGS National Map (Clean Orthoimagery)',
    maxZoom: 20
  }),
  esri: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri World Imagery',
    maxZoom: 19
  }),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO (Dark No Labels)',
    maxZoom: 20
  })
};

// ── Map Init ──────────────────────────────────────────────────────────────────

const taxiwayLayerGroup = L.layerGroup();

const map = L.map('map', {
  center: [40.777, -73.872],  // Default: KLGA
  zoom: 16,
  layers: [fallbackGoogle, taxiwayLayerGroup],
  zoomControl: true
});

let currentMbLayer = null;
let layerControl = L.control.layers({
  '🛰 Google Clean Satellite': TILES.googleSat,
  '🇺🇸 USGS Orthoimagery': TILES.usgs,
  '🛰 Esri World Imagery': TILES.esri,
  '🌑 Dark Map (No Labels)': TILES.dark
}, {
  '🚖 Taxiway Network': taxiwayLayerGroup
}, { position: 'bottomright' }).addTo(map);

// ── Fetch Server Config & Apply High-Precision Mapbox Tiles ───────────────────

async function setupPrecisionMapbox() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const token = cfg.mapboxToken || mapboxToken;
    if (token) {
      mapboxToken = token;
      localStorage.setItem(MAPBOX_STORAGE_KEY, token);

      if (currentMbLayer) {
        map.removeLayer(currentMbLayer);
        layerControl.removeLayer(currentMbLayer);
      }

      currentMbLayer = getMapboxLayer(token);
      if (currentMbLayer) {
        map.eachLayer(l => {
          if (l instanceof L.TileLayer) map.removeLayer(l);
        });
        currentMbLayer.addTo(map);
        layerControl.addBaseLayer(currentMbLayer, '💎 Mapbox Maxar High-Precision Satellite');
      }
    }
  } catch (e) {
    console.warn('Could not fetch server config:', e);
  }
}

setupPrecisionMapbox();

// ── Marker Icon Factory ───────────────────────────────────────────────────────

function pinIcon(onRunway, isClosed, onTaxiway) {
  let cls = 'pin-marker';
  if (isClosed) cls += ' closed-runway';
  else if (onRunway) cls += ' on-runway';
  else if (onTaxiway) cls += ' on-taxiway';

  return L.divIcon({
    className: '',
    html: `<div class="${cls}"></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 28],
    popupAnchor: [0, -30]
  });
}

// ── Geodesic Helper for Runway Polygon Extrusion ─────────────────────────────

function computeRunwayPolygon(leLat, leLon, heLat, heLon, widthFt) {
  const widthM = (widthFt || 150) * 0.3048;
  const halfM  = widthM / 2;

  const rad = Math.PI / 180;
  const dLon = (heLon - leLon) * rad;
  const y = Math.sin(dLon) * Math.cos(heLat * rad);
  const x = Math.cos(leLat * rad) * Math.sin(heLat * rad) - Math.sin(leLat * rad) * Math.cos(heLat * rad) * Math.cos(dLon);
  const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

  const p1 = (bearing + 90) * rad;
  const p2 = (bearing - 90) * rad;

  const R = 6371000;
  const offset = (lat, lon, brg, dist) => {
    const latR = lat * rad;
    const lonR = lon * rad;
    const dR = dist / R;
    const nLat = Math.asin(Math.sin(latR) * Math.cos(dR) + Math.cos(latR) * Math.sin(dR) * Math.cos(brg));
    const nLon = lonR + Math.atan2(Math.sin(brg) * Math.sin(dR) * Math.cos(latR), Math.cos(dR) - Math.sin(latR) * Math.sin(nLat));
    return [nLat / rad, nLon / rad];
  };

  const c1 = offset(leLat, leLon, p1, halfM);
  const c2 = offset(heLat, heLon, p1, halfM);
  const c3 = offset(heLat, heLon, p2, halfM);
  const c4 = offset(leLat, leLon, p2, halfM);

  return [c1, c2, c3, c4];
}

// ── Draw Runway & Taxiway Layers ──────────────────────────────────────────────

function clearRunwayLayers() {
  runwayLayers.forEach(l => map.removeLayer(l));
  runwayLayers = [];
  taxiwayLayerGroup.clearLayers();
  if (devLineLayer) {
    map.removeLayer(devLineLayer);
    devLineLayer = null;
  }
}

function drawTaxiways(taxiways) {
  if (!taxiways || !Array.isArray(taxiways)) return;
  taxiwayLayerGroup.clearLayers();

  const renderedLabels = new Set();

  for (const twy of taxiways) {
    if (!twy.coordinates || twy.coordinates.length < 2) continue;

    const isClosed = twy.is_closed;
    const color = isClosed ? '#ff4757' : '#ffb800';
    const weight = isClosed ? 4.5 : 2.5;
    const dash = isClosed ? '8,4' : null;

    const line = L.polyline(twy.coordinates, {
      color,
      weight,
      dashArray: dash,
      opacity: isClosed ? 0.95 : 0.88,
      lineCap: 'round',
      lineJoin: 'round'
    });
    taxiwayLayerGroup.addLayer(line);

    // If taxiway is closed, add Red "X" markers at start, mid, end
    if (isClosed) {
      const midIdx = Math.floor(twy.coordinates.length / 2);
      const sampleIndices = [0, midIdx, twy.coordinates.length - 1];
      for (const idx of sampleIndices) {
        const [cLat, cLon] = twy.coordinates[idx];
        const xMarker = L.marker([cLat, cLon], {
          icon: L.divIcon({
            className: 'aviation-sign-icon',
            html: `<div class="twy-x-marker">✕</div>`,
            iconSize: null,
            iconAnchor: [0, 0]
          })
        });
        taxiwayLayerGroup.addLayer(xMarker);
      }
    }

    // Add readable taxiway designator badge along midpoint
    if (twy.ref && !renderedLabels.has(twy.ref)) {
      renderedLabels.add(twy.ref);
      const midIdx = Math.floor(twy.coordinates.length / 2);
      const [mLat, mLon] = twy.coordinates[midIdx];

      const badgeHtml = isClosed
        ? `<div class="twy-map-badge closed">❌ TWY ${twy.ref} [CLSD]</div>`
        : `<div class="twy-map-badge">TWY ${twy.ref}</div>`;

      const badge = L.marker([mLat, mLon], {
        icon: L.divIcon({ className: 'aviation-sign-icon', html: badgeHtml, iconSize: null, iconAnchor: [0, 0] })
      });
      taxiwayLayerGroup.addLayer(badge);
    }
  }
}

function getRunwayKey(r) {
  if (!r) return null;
  return `${r.airport_icao || ''}_${r.le_ident || ''}_${r.he_ident || ''}`;
}

function drawRunways(data) {
  let allRunways = data.runways || [];

  // If a specific runway is selected, ISOLATE it: only draw the selected runway path!
  let runwaysToDraw = allRunways;
  if (selectedRunwayKey) {
    const matched = allRunways.filter(r => getRunwayKey(r) === selectedRunwayKey);
    if (matched.length > 0) {
      runwaysToDraw = matched;
    }
  }

  for (const rwy of runwaysToDraw) {
    if (!rwy.le_latitude || !rwy.he_latitude) continue;

    const isClosed = rwy.is_closed || (rwy.analysis && rwy.analysis.is_closed);
    const isSelected = selectedRunwayKey && getRunwayKey(rwy) === selectedRunwayKey;
    const isActive = isSelected || (data.active_runway &&
      rwy.airport_icao === data.active_runway.airport_icao &&
      rwy.le_ident === data.active_runway.le_ident);

    let polyColor = isClosed ? '#ff4757' : (isActive ? (data.on_runway ? '#00ff88' : '#00d4ff') : 'rgba(0,212,255,0.45)');
    let polyFill  = isClosed ? 'rgba(255, 71, 87, 0.35)' : (isActive ? (data.on_runway ? 'rgba(0,255,136,0.18)' : 'rgba(0,212,255,0.14)') : 'rgba(0,212,255,0.05)');
    let lineColor = isClosed ? '#ff4757' : (isActive ? '#00ff88' : 'rgba(0,212,255,0.6)');

    const polyCoords = computeRunwayPolygon(rwy.le_latitude, rwy.le_longitude, rwy.he_latitude, rwy.he_longitude, rwy.width_ft);
    const poly = L.polygon(polyCoords, {
      color: polyColor,
      weight: isClosed ? 3.5 : (isActive ? 3 : 1.5),
      fillColor: polyFill,
      fillOpacity: 1
    }).addTo(map);
    runwayLayers.push(poly);

    const line = L.polyline(
      [[rwy.le_latitude, rwy.le_longitude], [rwy.he_latitude, rwy.he_longitude]],
      {
        color: lineColor,
        weight: isActive ? 4 : 2,
        dashArray: isClosed ? '6,6' : (isActive ? '8,6' : '6,6'),
        opacity: 0.95
      }
    ).addTo(map);
    runwayLayers.push(line);

    // Readable, high-contrast runway threshold boxes
    const leBadgeHtml = isClosed
      ? `<div class="rwy-map-badge closed">🚫 RW ${rwy.le_ident} [CLSD]</div>`
      : `<div class="rwy-map-badge">RW ${rwy.le_ident}</div>`;

    const heBadgeHtml = isClosed
      ? `<div class="rwy-map-badge closed">🚫 RW ${rwy.he_ident} [CLSD]</div>`
      : `<div class="rwy-map-badge">RW ${rwy.he_ident}</div>`;

    const leLabel = rwy.le_ident ? L.marker([rwy.le_latitude, rwy.le_longitude], {
      icon: L.divIcon({ className: 'aviation-sign-icon', html: leBadgeHtml, iconSize: null, iconAnchor: [0, 0] })
    }).addTo(map) : null;

    const heLabel = rwy.he_ident ? L.marker([rwy.he_latitude, rwy.he_longitude], {
      icon: L.divIcon({ className: 'aviation-sign-icon', html: heBadgeHtml, iconSize: null, iconAnchor: [0, 0] })
    }).addTo(map) : null;

    if (leLabel) runwayLayers.push(leLabel);
    if (heLabel) runwayLayers.push(heLabel);
  }

  // Perpendicular Deviation Line
  if (data.within_runway_scope && data.active_runway && data.active_runway.analysis) {
    const ar = data.active_runway;
    const a = ar.analysis;

    const rad = Math.PI / 180;
    const atd_m = a.atd_m;
    const R = 6371000;

    const isLeLanding = a.end_code === 'le';
    const thrLat = isLeLanding ? ar.le_latitude : ar.he_latitude;
    const thrLon = isLeLanding ? ar.le_longitude : ar.he_longitude;
    const endLat = isLeLanding ? ar.he_latitude : ar.le_latitude;
    const endLon = isLeLanding ? ar.he_longitude : ar.le_longitude;

    const lat1 = thrLat * rad;
    const lon1 = thrLon * rad;
    const dLon = (endLon - thrLon) * rad;
    const y = Math.sin(dLon) * Math.cos(endLat * rad);
    const x = Math.cos(lat1) * Math.sin(endLat * rad) - Math.sin(lat1) * Math.cos(endLat * rad) * Math.cos(dLon);
    const brg = Math.atan2(y, x);

    const dR = atd_m / R;
    const projLatR = Math.asin(Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brg));
    const projLonR = lon1 + Math.atan2(Math.sin(brg) * Math.sin(dR) * Math.cos(lat1), Math.cos(dR) - Math.sin(lat1) * Math.sin(projLatR));

    const projLat = projLatR / rad;
    const projLon = projLonR / rad;

    devLineLayer = L.polyline(
      [[data.lat, data.lon], [projLat, projLon]],
      {
        color: '#ff4757',
        weight: 2.5,
        dashArray: '3,3',
        opacity: 0.95
      }
    ).addTo(map);

    const centerPoint = L.circleMarker([projLat, projLon], {
      radius: 4.5,
      color: '#00ff88',
      fillColor: '#ffffff',
      fillOpacity: 1
    }).addTo(map);
    runwayLayers.push(centerPoint);
  }

  // Draw Taxiway Layer
  if (data.taxiways) {
    drawTaxiways(data.taxiways);
  }
}

// ── UI Updaters ───────────────────────────────────────────────────────────────

function fmt(n, decimals = 0) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function renderNotamsPanel(operational, icao) {
  const notamsPanel = document.getElementById('notamsPanel');
  const notamsContainer = document.getElementById('notamsContainer');
  if (!operational || !operational.notams || operational.notams.length === 0) {
    notamsPanel.classList.add('hidden');
    return;
  }

  notamsPanel.classList.remove('hidden');
  document.getElementById('notamsTitle').textContent = `${icao || ''} Active NOTAMs (${operational.notams.length})`;
  notamsContainer.innerHTML = '';

  const sorted = [...operational.notams].sort((a, b) => (b.is_closure ? 1 : 0) - (a.is_closure ? 1 : 0));

  sorted.forEach(n => {
    const item = document.createElement('div');
    item.className = `notam-item ${n.is_closure ? 'notam-closure' : ''}`;

    let badgeClass = 'general';
    let badgeLabel = 'NOTAM';

    if (n.type === 'RUNWAY_CLOSURE') {
      badgeClass = 'closure';
      badgeLabel = '🚫 RWY CLOSURE';
    } else if (n.type === 'NAVAID_LIGHTING') {
      badgeClass = 'navaid';
      badgeLabel = '💡 NAVAID/LIGHT';
    } else if (n.type === 'TAXIWAY_APRON') {
      badgeClass = 'taxiway';
      badgeLabel = n.is_closure ? '❌ TWY CLOSURE' : '🚧 TAXIWAY';
    } else if (n.type === 'HAZARD') {
      badgeClass = 'hazard';
      badgeLabel = '⚠️ HAZARD';
    }

    item.innerHTML = `
      <div class="notam-item-header">
        <span class="notam-badge ${badgeClass}">${badgeLabel}</span>
      </div>
      <div class="notam-text">${n.text}</div>
    `;
    notamsContainer.appendChild(item);
  });
}

function renderFeedsPanel(operational) {
  const feedsContainer = document.getElementById('feedsContainer');
  const feedsPanel = document.getElementById('atisFeedsPanel');
  if (!operational || !operational.all_sources) {
    feedsPanel.classList.add('hidden');
    return;
  }

  feedsPanel.classList.remove('hidden');
  feedsContainer.innerHTML = '';

  const sources = operational.all_sources;
  const activeType = operational.active_source_type;

  const srcList = [
    { key: 'real_world', title: 'Real World D-ATIS', icon: '📡', data: sources.real_world },
    { key: 'vatsim',     title: 'VATSIM Network ATIS', icon: '🌐', data: sources.vatsim },
    { key: 'ivao',       title: 'IVAO Network ATIS',   icon: '🌍', data: sources.ivao },
    { key: 'metar',      title: 'Live METAR Observation', icon: '💨', data: sources.metar }
  ];

  srcList.forEach(s => {
    const d = s.data;
    const isAvail = d && d.available;
    const isActive = activeType === s.key;

    const card = document.createElement('div');
    card.className = `feed-card ${isActive ? 'active-feed' : ''}`;

    let statusBadge = isAvail
      ? `<span class="feed-badge online">ONLINE</span>`
      : `<span class="feed-badge offline">UNAVAILABLE</span>`;
    
    if (isActive) {
      statusBadge = `<span class="feed-badge active-tag">ACTIVE SOURCE</span> ` + statusBadge;
    }

    let contentHtml = '';
    if (isAvail) {
      if (s.key === 'metar') {
        const windStr = d.wind_dir !== null && d.wind_speed !== null ? `${d.wind_dir}&deg; @ ${d.wind_speed} kt` : 'Variable';
        contentHtml = `
          <div class="feed-summary-grid">
            <div class="feed-summary-item"><span class="feed-summary-label">Wind:</span> <span class="feed-summary-val">${windStr}</span></div>
            <div class="feed-summary-item"><span class="feed-summary-label">Temp/Dew:</span> <span class="feed-summary-val">${d.temp ?? '—'}&deg;C / ${d.dew ?? '—'}&deg;C</span></div>
            <div class="feed-summary-item"><span class="feed-summary-label">Altimeter:</span> <span class="feed-summary-val">${d.qnh ? (d.qnh/100).toFixed(2) + ' inHg' : '—'}</span></div>
            <div class="feed-summary-item"><span class="feed-summary-label">Flight:</span> <span class="feed-summary-val">${d.flight_category || 'VFR'}</span></div>
          </div>
          ${d.raw ? `<div class="feed-text-block">${d.raw}</div>` : ''}
        `;
      } else {
        const lndStr = d.landing_runways?.length > 0 ? 'RW ' + d.landing_runways.join(', ') : 'Not specified';
        const depStr = d.departing_runways?.length > 0 ? 'RW ' + d.departing_runways.join(', ') : 'Not specified';
        const windStr = d.wind_dir !== null && d.wind_speed !== null ? `${d.wind_dir}&deg; @ ${d.wind_speed} kt` : '—';
        contentHtml = `
          <div class="feed-summary-grid">
            <div class="feed-summary-item"><span class="feed-summary-label">Info Code:</span> <span class="feed-summary-val">${d.code || '—'}</span></div>
            <div class="feed-summary-item"><span class="feed-summary-label">Wind:</span> <span class="feed-summary-val">${windStr}</span></div>
            <div class="feed-summary-item"><span class="feed-summary-label">Landing:</span> <span class="feed-summary-val">${lndStr}</span></div>
            <div class="feed-summary-item"><span class="feed-summary-label">Departing:</span> <span class="feed-summary-val">${depStr}</span></div>
          </div>
          ${d.text ? `<div class="feed-text-block">${d.text}</div>` : ''}
        `;
      }
    } else {
      contentHtml = `<div style="font-size:10.5px;color:var(--text-muted);">No active broadcast reported for this station.</div>`;
    }

    card.innerHTML = `
      <div class="feed-card-header">
        <div class="feed-card-title">${s.icon} ${s.title}</div>
        <div>${statusBadge}</div>
      </div>
      <div class="feed-content">
        ${contentHtml}
      </div>
    `;
    feedsContainer.appendChild(card);
  });
}

function updateResults(data) {
  lastResult = data;
  document.getElementById('instructionCard').classList.add('hidden');
  const { on_runway, on_taxiway, active_taxiway: twy, within_runway_scope, airport, operational, active_runway: rwy, runways } = data;

  // If pin dropped on a runway, auto-select that runway to isolate it!
  if (on_runway && rwy) {
    selectedRunwayKey = getRunwayKey(rwy);
  }

  // 1. Coordinates card
  document.getElementById('coordsCard').classList.remove('hidden');
  document.getElementById('coordsValue').textContent =
    `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;

  // 2. Airport Info Box Notification (in Sidebar)
  const airportCard = document.getElementById('airportCard');
  const sourceControlPanel = document.getElementById('sourceControlPanel');

  if (airport) {
    airportCard.classList.remove('hidden');
    sourceControlPanel.classList.remove('hidden');

    document.getElementById('cardIcao').textContent = airport.icao || '—';
    const iataEl = document.getElementById('cardIata');
    if (airport.iata) {
      iataEl.textContent = airport.iata;
      iataEl.classList.remove('hidden');
    } else {
      iataEl.classList.add('hidden');
    }
    document.getElementById('cardAirportName').textContent = airport.name || '—';
    
    const locParts = [airport.city, airport.country_name || airport.country].filter(Boolean);
    document.getElementById('cardLocation').textContent = locParts.join(', ') || 'Airport grounds';

    const elevFt = airport.elevation_ft;
    const elevM = airport.elevation_m;
    document.getElementById('cardElev').textContent = elevFt !== null ? `${fmt(elevFt)} ft / ${fmt(elevM)} m` : '—';

    document.getElementById('activeSourceText').textContent = `Active: ${operational?.source_label || 'METAR'}`;
  } else {
    airportCard.classList.add('hidden');
    sourceControlPanel.classList.add('hidden');
  }

  // 3. Render Feeds Panel & NOTAMs in Sidebar
  renderFeedsPanel(operational);
  renderNotamsPanel(operational, airport?.icao);

  // 4. Popup notification attached directly to the Pin Drop
  if (pinMarker) {
    pinMarker.closePopup();
    pinMarker.unbindPopup();

    const isAtis = operational && (operational.source === 'real_world' || operational.source === 'vatsim' || operational.source === 'ivao' || operational.source === 'Real ATIS' || operational.source === 'VATSIM ATIS');
    const sourceTag = operational?.source_label || 'METAR';
    const windStr = operational?.wind_dir !== null && operational?.wind_speed !== null
      ? `${operational.wind_dir}&deg; @ ${operational.wind_speed} kt${operational.wind_gust ? ' G ' + operational.wind_gust + ' kt' : ''}`
      : 'Calm / Variable';

    if (on_runway && rwy && rwy.analysis) {
      // ── RUNWAY ON-PIN NOTIFICATION CARD ──
      const a = rwy.analysis;
      const isClosed = rwy.is_closed || a.is_closed;
      const rwyElevFt = a.elevation_ft !== null ? a.elevation_ft : airport?.elevation_ft;
      const rwyElevM = rwyElevFt !== null ? Math.round(rwyElevFt * 0.3048) : null;
      const rwyDimsStr = `${fmt(rwy.length_ft)} ft × ${fmt(rwy.width_ft)} ft (${fmt(rwy.length_m)} m × ${fmt(rwy.width_m)} m)`;
      const elevStr = rwyElevFt !== null ? `${fmt(rwyElevFt)} ft (${fmt(rwyElevM)} m)` : '—';
      const devStr = `${a.deviation_ft !== null ? Math.abs(a.deviation_ft) + ' ft ' + a.side : '—'}`;

      const lndStr = operational?.landing_runways?.length > 0 ? operational.landing_runways.join(', ') : a.runway_end_ident;
      const depStr = operational?.departing_runways?.length > 0 ? operational.departing_runways.join(', ') : lndStr;

      const activeBadgeHtml = isClosed
        ? `<span class="rwy-active-badge closed">🚫 RW ${a.runway_end_ident} CLOSED</span>`
        : `<span class="rwy-active-badge">🛬 RW ${a.runway_end_ident}</span>`;

      const closedNoticeHtml = isClosed
        ? `<div class="closed-rwy-notice">⚠️ RW ${a.runway_end_ident} CLOSED (NOTAM)</div>`
        : '';

      const popupHtml = `
        <div class="pin-popup-card runway-popup">
          <div class="pin-popup-badge-row">
            ${activeBadgeHtml}
            <span class="rwy-source-badge">${sourceTag}</span>
          </div>
          <div class="pin-popup-name">${airport ? airport.icao + ' &bull; ' + airport.name : rwy.airport_icao}</div>
          
          ${closedNoticeHtml}

          <div class="pin-popup-op-strip">
            <div class="op-row">
              <span class="op-label">🛬 Landing:</span>
              <span class="op-val">RW ${lndStr}</span>
            </div>
            <div class="op-row">
              <span class="op-label">🛫 Departing:</span>
              <span class="op-val">RW ${depStr}</span>
            </div>
            <div class="op-row">
              <span class="op-label">💨 Wind:</span>
              <span class="op-val">${windStr}</span>
            </div>
          </div>

          <div class="pin-popup-rwy-details">
            <div class="rwy-metric-row">
              <span class="rwy-metric-label">Dimensions</span>
              <span class="rwy-metric-val">${rwyDimsStr}</span>
            </div>
            <div class="rwy-metric-row">
              <span class="rwy-metric-label">Runway Elevation</span>
              <span class="rwy-metric-val">▲ ${elevStr}</span>
            </div>
            <div class="rwy-metric-row">
              <span class="rwy-metric-label">Centerline Dev</span>
              <span class="rwy-metric-val green">${devStr}</span>
            </div>
            <div class="rwy-metric-row">
              <span class="rwy-metric-label">Touchdown Dist</span>
              <span class="rwy-metric-val">${fmt(a.distance_from_threshold_ft)} ft (${a.touchdown_zone})</span>
            </div>
          </div>
        </div>
      `;
      pinMarker.bindPopup(popupHtml, { autoClose: false, closeOnClick: false, offset: [0, -10], maxWidth: 500 }).openPopup();

    } else if (on_taxiway && twy) {
      // ── TAXIWAY ON-PIN NOTIFICATION CARD ──
      const elevStr = airport?.elevation_ft !== null ? `${fmt(airport.elevation_ft)} ft (${fmt(airport.elevation_m)} m)` : '—';
      const isClosed = twy.is_closed;

      const badgeHtml = isClosed
        ? `<span class="rwy-active-badge closed">❌ TWY ${twy.ref || ''} CLOSED</span>`
        : `<span class="twy-active-badge">🚖 TWY ${twy.ref || 'Taxiway'}</span>`;

      const closedNoticeHtml = isClosed
        ? `<div class="closed-rwy-notice">❌ TAXIWAY ${twy.ref || ''} CLOSED BY NOTAM: ${twy.closure_reason || 'Out of service'}</div>`
        : '';

      const popupHtml = `
        <div class="pin-popup-card taxiway-popup">
          <div class="pin-popup-badge-row">
            ${badgeHtml}
            <span class="rwy-source-badge">${sourceTag}</span>
            <span class="airport-elev-badge">▲ ${elevStr}</span>
          </div>
          <div class="pin-popup-name">${airport ? airport.name : airport?.icao}</div>
          <div class="pin-popup-location">📍 ${twy.name} &bull; Width: ${twy.width_ft} ft (${twy.surface})</div>

          ${closedNoticeHtml}

          <div class="pin-popup-op-strip">
            <div class="op-row">
              <span class="op-label">💨 Wind:</span>
              <span class="op-val">${windStr}</span>
            </div>
          </div>
        </div>
      `;
      pinMarker.bindPopup(popupHtml, { autoClose: false, closeOnClick: false, offset: [0, -10], maxWidth: 500 }).openPopup();

    } else if (airport) {
      // ── AIRPORT GROUNDS NOTIFICATION CARD ──
      const locStr = [airport.city, airport.country_name || airport.country].filter(Boolean).join(', ') || 'Airport grounds';
      const elevStr = airport.elevation_ft !== null ? `${fmt(airport.elevation_ft)} ft (${fmt(airport.elevation_m)} m)` : '—';
      const lndStr = operational?.landing_runways?.length > 0 ? operational.landing_runways.join(', ') : null;
      const depStr = operational?.departing_runways?.length > 0 ? operational.departing_runways.join(', ') : null;
      const metarSnippet = operational?.metar ? `<div class="metar-block">${operational.metar}</div>` : '';

      const popupHtml = `
        <div class="pin-popup-card airport-popup">
          <div class="pin-popup-badge-row">
            <span class="icao-badge">${airport.icao}${airport.iata ? ' / ' + airport.iata : ''}</span>
            <span class="rwy-source-badge">${sourceTag}</span>
            <span class="airport-elev-badge">▲ ${elevStr}</span>
          </div>
          <div class="pin-popup-name">${airport.name || airport.icao}</div>
          <div class="pin-popup-location">📍 ${locStr}</div>

          <div class="pin-popup-op-strip">
            ${lndStr ? `
            <div class="op-row">
              <span class="op-label">🛬 Landing Runways:</span>
              <span class="op-val">RW ${lndStr}</span>
            </div>` : ''}
            ${depStr ? `
            <div class="op-row">
              <span class="op-label">🛫 Departing Runways:</span>
              <span class="op-val">RW ${depStr}</span>
            </div>` : ''}
            <div class="op-row">
              <span class="op-label">💨 Wind:</span>
              <span class="op-val">${windStr}</span>
            </div>
          </div>

          ${!isAtis && metarSnippet ? metarSnippet : ''}
        </div>
      `;
      pinMarker.bindPopup(popupHtml, { autoClose: false, closeOnClick: false, offset: [0, -10], maxWidth: 500 }).openPopup();
    }
  }

  // 5. Status banner
  const banner = document.getElementById('statusBanner');
  const icon   = document.getElementById('statusIcon');
  const text   = document.getElementById('statusText');
  banner.classList.remove('hidden', 'on-runway', 'off-runway', 'near-runway');

  if (on_runway && rwy) {
    const isClosed = rwy.is_closed || (rwy.analysis && rwy.analysis.is_closed);
    if (isClosed) {
      banner.classList.add('off-runway');
      icon.textContent = '🚫';
      text.textContent = `On Closed Runway ${rwy.analysis?.runway_end_ident || ''} (NOTAM)`;
    } else {
      banner.classList.add('on-runway');
      icon.textContent = '✅';
      text.textContent = `On Runway ${rwy.analysis?.runway_end_ident || ''} (${operational?.source_label || 'Active'})`;
    }
  } else if (on_taxiway && twy) {
    banner.classList.add(twy.is_closed ? 'off-runway' : 'near-runway');
    icon.textContent = twy.is_closed ? '❌' : '🚖';
    text.textContent = twy.is_closed
      ? `On Closed Taxiway ${twy.ref || ''} (NOTAM)`
      : `On Taxiway ${twy.ref || ''} (${airport?.icao || ''})`;
  } else if (within_runway_scope && rwy) {
    banner.classList.add('near-runway');
    icon.textContent = '⚠️';
    text.textContent = `Near Runway ${rwy.analysis?.runway_end_ident || ''}`;
  } else if (airport) {
    banner.classList.add('near-runway');
    icon.textContent = '🏢';
    text.textContent = `On Airport Grounds (${airport.icao})`;
  } else {
    banner.classList.add('off-runway');
    icon.textContent = '🔴';
    text.textContent = 'Not on an airport or runway';
  }

  // 6. Runway Measurement Panel
  const runwayPanel = document.getElementById('runwayPanel');
  if (within_runway_scope && rwy) {
    const a = rwy.analysis;
    const isClosed = rwy.is_closed || a.is_closed;
    runwayPanel.classList.remove('hidden');

    document.getElementById('runwayTitle').textContent =
      `${rwy.airport_icao} — Runway ${rwy.le_ident || '?'}/${rwy.he_ident || '?'}${isClosed ? ' [CLOSED]' : ''}`;

    document.getElementById('runwayDesignator').textContent = isClosed
      ? `RW ${a.runway_end_ident} (CLOSED BY NOTAM)`
      : `Landing ${a.runway_end_ident} (${operational?.source_label || ''})`;
    document.getElementById('runwaySurface').textContent =
      rwy.surface ? rwy.surface.charAt(0).toUpperCase() + rwy.surface.slice(1) : '—';
    document.getElementById('runwayDims').textContent =
      rwy.length_ft
        ? `${fmt(rwy.length_ft)} ft × ${fmt(rwy.width_ft)} ft (${fmt(rwy.length_m, 0)} m × ${fmt(rwy.width_m, 0)} m)`
        : '—';

    const devFt   = a.deviation_ft;
    const devM    = a.deviation_m;
    const maxDev  = Math.max(100, Math.abs(devFt) * 1.5);
    const pct     = Math.min(Math.max(50 + (devFt / maxDev) * 50, 5), 95);

    document.getElementById('deviationNeedle').style.left = `${pct}%`;
    document.getElementById('deviationFt').textContent =
      devFt !== null ? `${Math.abs(devFt).toFixed(1)} ft` : '— ft';
    document.getElementById('deviationM').textContent =
      devM !== null ? `${Math.abs(devM).toFixed(1)} m` : '— m';
    const sideEl = document.getElementById('deviationSide');
    sideEl.textContent = a.side || '—';
    sideEl.style.color = a.side === 'center' ? 'var(--green)'
      : a.side === 'left'   ? '#74b9ff'
      : a.side === 'right'  ? '#fd79a8'
      : 'var(--accent)';

    const tdFt  = a.distance_from_threshold_ft;
    const tdM   = a.distance_from_threshold_m;
    const pctRwy = Math.min(Math.max(a.pct_runway_used || 0, 0), 100);

    document.getElementById('tdFt').textContent = tdFt !== null ? fmt(tdFt, 0) : '—';
    document.getElementById('tdM').textContent  = tdM  !== null ? fmt(tdM, 0)  : '—';
    document.getElementById('tdPct').textContent = pctRwy !== null ? pctRwy.toFixed(1) : '—';
    document.getElementById('tdGaugeFill').style.width = `${pctRwy}%`;
    document.getElementById('tdGaugeMarker').style.left = `${pctRwy}%`;
    document.getElementById('tdGaugeEnd').textContent =
      rwy.length_ft ? `${(rwy.length_ft / 1000).toFixed(1)}k ft` : 'END';

    const tz    = a.touchdown_zone || 'UNKNOWN';
    const badge = document.getElementById('tzBadge');
    badge.textContent = tz.replace('_', ' ');
    badge.className = 'tz-badge';
    if (tz === 'TZ1')           badge.classList.add('tz1');
    else if (tz === 'TZ2')      badge.classList.add('tz2');
    else if (tz === 'TZ3')      badge.classList.add('tz3');
    else if (tz.includes('BEYOND')) badge.classList.add('beyond');
    else if (tz.includes('BEFORE')) badge.classList.add('before');
    else                        badge.classList.add('unknown');

    document.getElementById('remainingFt').textContent = fmt(a.remaining_ft, 0);
    document.getElementById('remainingM').textContent  = fmt(a.remaining_m,  0);
  } else {
    runwayPanel.classList.add('hidden');
  }

  // 7. Airport Runways List
  const nearbyPanel = document.getElementById('nearbyPanel');
  const nearbyList  = document.getElementById('nearbyList');
  nearbyList.innerHTML = '';

  if (runways && runways.length > 0) {
    nearbyPanel.classList.remove('hidden');
    
    // Add "Show All Runways" button if a runway is isolated
    const headerHtml = `
      <div class="panel-header-left">
        <span class="panel-icon">🛫</span>
        <span class="panel-title">${airport ? `${airport.icao} Runways (${runways.length})` : 'Airport Runways'}</span>
      </div>
      ${selectedRunwayKey ? `<button class="btn-reset-view" id="btnShowAllRunways">Show All Runways</button>` : ''}
    `;
    document.querySelector('#nearbyPanel .panel-header').innerHTML = headerHtml;

    const btnShowAll = document.getElementById('btnShowAllRunways');
    if (btnShowAll) {
      btnShowAll.addEventListener('click', () => {
        selectedRunwayKey = null;
        updateResults(lastResult);
        clearRunwayLayers();
        drawRunways(lastResult);
      });
    }

    runways.forEach((n) => {
      const isClosed = n.is_closed || (n.analysis && n.analysis.is_closed);
      const isSelected = selectedRunwayKey && getRunwayKey(n) === selectedRunwayKey;
      const isActive = isSelected || (!selectedRunwayKey && rwy && n.airport_icao === rwy.airport_icao && n.le_ident === rwy.le_ident);

      const item = document.createElement('div');
      item.className = 'nearby-item' + (isActive ? ' active' : '') + (isClosed ? ' closed-item' : '');
      
      const closedTag = isClosed ? ` <span style="background:#ff4757;color:#fff;font-size:9.5px;padding:1px 5px;border-radius:3px;font-weight:800;margin-left:4px;">CLOSED</span>` : '';
      const selectedTag = isSelected ? ` <span style="background:var(--accent);color:#0a0d14;font-size:9px;padding:1px 5px;border-radius:3px;font-weight:800;margin-left:4px;">ISOLATED</span>` : '';

      item.innerHTML = `
        <div>
          <div class="nearby-ident">RW ${n.le_ident || '?'}/${n.he_ident || '?'}${closedTag}${selectedTag}</div>
          <div class="nearby-airport">${fmt(n.length_ft)} ft × ${fmt(n.width_ft)} ft &bull; ${n.surface || 'Paved'}</div>
        </div>
        <div class="nearby-dist">${n.centerline_bearing_deg || 0}&deg;</div>
      `;

      item.addEventListener('click', () => {
        // Isolate selected runway on click!
        selectedRunwayKey = getRunwayKey(n);
        updateResults(lastResult);
        clearRunwayLayers();
        drawRunways(lastResult);

        if (n.le_latitude && n.he_latitude) {
          const midLat = (n.le_latitude + n.he_latitude) / 2;
          const midLon = (n.le_longitude + n.he_longitude) / 2;
          map.flyTo([midLat, midLon], 16, { duration: 1.2 });
        }
      });
      nearbyList.appendChild(item);
    });
  } else {
    nearbyPanel.classList.add('hidden');
  }
}

function showLoading(show) {
  document.getElementById('loadingCard').classList.toggle('hidden', !show);
  if (show) document.getElementById('instructionCard').classList.add('hidden');
}

// ── API Call ──────────────────────────────────────────────────────────────────

async function analyzePoint(lat, lon) {
  currentCoords = { lat, lon };
  showLoading(true);
  clearRunwayLayers();

  if (pinMarker) {
    pinMarker.closePopup();
    pinMarker.unbindPopup();
  }

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat,
        lon,
        preferredSource: userSourcePref
      })
    });
    const data = await resp.json();

    showLoading(false);
    updateResults(data);
    drawRunways(data);

    if (pinMarker) {
      const isClosed = (data.active_runway && (data.active_runway.is_closed || data.active_runway.analysis?.is_closed)) ||
                       (data.active_taxiway && data.active_taxiway.is_closed);
      pinMarker.setIcon(pinIcon(data.on_runway, isClosed, data.on_taxiway));
    }

  } catch (err) {
    showLoading(false);
    console.error('API error:', err);
  }
}

// ── Controls & Event Listeners ────────────────────────────────────────────────

function initControls() {
  const pills = document.querySelectorAll('.source-pill');
  pills.forEach(p => {
    if (p.dataset.source === userSourcePref) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }

    p.addEventListener('click', () => {
      pills.forEach(b => b.classList.remove('active'));
      p.classList.add('active');
      userSourcePref = p.dataset.source;
      localStorage.setItem(SOURCE_PREF_KEY, userSourcePref);

      if (currentCoords) {
        analyzePoint(currentCoords.lat, currentCoords.lon);
      }
    });
  });

  const twyToggle = document.getElementById('taxiwayToggle');
  if (twyToggle) {
    twyToggle.checked = showTaxiways;
    if (!showTaxiways) {
      map.removeLayer(taxiwayLayerGroup);
    }

    twyToggle.addEventListener('change', (e) => {
      showTaxiways = e.target.checked;
      localStorage.setItem(SHOW_TAXIWAYS_KEY, showTaxiways);
      if (showTaxiways) {
        map.addLayer(taxiwayLayerGroup);
      } else {
        map.removeLayer(taxiwayLayerGroup);
      }
    });
  }
}

// ── Map Click ─────────────────────────────────────────────────────────────────

map.on('click', (e) => {
  const { lat, lng } = e.latlng;

  if (pinMarker) {
    pinMarker.closePopup();
    pinMarker.unbindPopup();
    pinMarker.setLatLng([lat, lng]);
  } else {
    pinMarker = L.marker([lat, lng], {
      icon: pinIcon(false, false, false),
      draggable: true
    }).addTo(map);

    pinMarker.on('dragend', (ev) => {
      const pos = ev.target.getLatLng();
      analyzePoint(pos.lat, pos.lng);
    });
  }

  analyzePoint(lat, lng);
});

// ── Airport Search ────────────────────────────────────────────────────────────

async function goToAirport(query) {
  query = query.trim().toUpperCase();
  if (!query) return;

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + ' airport')}&format=json&limit=1&accept-language=en`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'MYTECHREVIEW/runway-tester' } });
    const results = await resp.json();
    if (results && results[0]) {
      const { lat, lon } = results[0];
      selectedRunwayKey = null;
      map.flyTo([parseFloat(lat), parseFloat(lon)], 16, { duration: 1.5 });
      return;
    }
  } catch (e) { /* fallback */ }

  alert(`Could not find airport: ${query}`);
}

document.getElementById('searchBtn').addEventListener('click', () => {
  goToAirport(document.getElementById('airportSearch').value);
});
document.getElementById('airportSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToAirport(e.target.value);
});

initControls();
showLoading(false);
console.log('🛬 ICAO Runway Analyzer ready with Taxiway Network layer and Runway Isolation.');
