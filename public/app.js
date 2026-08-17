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
let showTaxiways = localStorage.getItem(SHOW_TAXIWAYS_KEY) === 'true'; // OFF by default

// ── State ─────────────────────────────────────────────────────────────────────

let pinMarker          = null;
let runwayLayers       = [];
let devLineLayer       = null;
let lastResult         = null;
let currentCoords      = null;
let selectedRunwayKey  = null; // If selected, only this runway is drawn!
let selectedTaxiwayRef = null; // If selected, only this taxiway is drawn!

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
const taxiRouteLayerGroup = L.layerGroup();
const terminalLayerGroup = L.layerGroup();
const gateLayerGroup = L.layerGroup();
const standLayerGroup = L.layerGroup();
const editorLayerGroup = L.layerGroup();

// Visual Editor State
let isEditMode = false;
let selectedBayRef = null;
let isTracingLeadIn = false;
let currentTraceCoords = [];
let traceLineLayer = null;
let traceDotLayers = [];
let hasUnsavedChanges = false;

const SHOW_TERMINALS_KEY = 'icao_show_terminals_v1';
let showTerminals = true;
let showTerminalBuildings = true;
let showGates = true;
let showStands = true;


const map = L.map('map', {
  center: [40.777, -73.872],  // Default: KLGA
  zoom: 16,
  layers: [fallbackGoogle, taxiRouteLayerGroup, editorLayerGroup, ...(showTaxiways ? [taxiwayLayerGroup] : []), ...(showTerminals ? [terminalLayerGroup, gateLayerGroup, standLayerGroup] : [])],
  zoomControl: true
});

let currentMbLayer = null;
let layerControl = L.control.layers({
  '🛰 Google Clean Satellite': TILES.googleSat,
  '🇺🇸 USGS Orthoimagery': TILES.usgs,
  '🛰 Esri World Imagery': TILES.esri,
  '🌑 Dark Map (No Labels)': TILES.dark
}, {
  '🚖 Taxiway Network': taxiwayLayerGroup,
  '🏢 Terminals & Gates': terminalLayerGroup,
  '🚪 Boarding Gates': gateLayerGroup,
  '🅿️ Parking Stands': standLayerGroup
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
  taxiRouteLayerGroup.clearLayers();
  terminalLayerGroup.clearLayers();
  gateLayerGroup.clearLayers();
  standLayerGroup.clearLayers();
  if (devLineLayer) {
    map.removeLayer(devLineLayer);
    devLineLayer = null;
  }
}

function selectTaxiway(ref) {
  // If clicking on the already selected taxiway, TOGGLE OFF and show all taxiways!
  if (selectedTaxiwayRef === ref) {
    resetTaxiwaySelection();
    return;
  }
  selectedTaxiwayRef = ref;
  if (!showTaxiways) {
    showTaxiways = true;
    localStorage.setItem(SHOW_TAXIWAYS_KEY, 'true');
    const toggleEl = document.getElementById('taxiwayToggle');
    if (toggleEl) toggleEl.checked = true;
    map.addLayer(taxiwayLayerGroup);
  }
  if (lastResult && lastResult.taxiways) {
    drawTaxiways(lastResult.taxiways);
    renderTaxiwaySelector(lastResult.taxiways);
  }
}

function resetTaxiwaySelection() {
  selectedTaxiwayRef = null;
  if (lastResult && lastResult.taxiways) {
    drawTaxiways(lastResult.taxiways);
    renderTaxiwaySelector(lastResult.taxiways);
  }
}

function drawTaxiways(taxiways) {
  if (!taxiways) return;
  const segments = Array.isArray(taxiways) ? taxiways : (taxiways.segments || []);
  if (segments.length === 0) return;

  taxiwayLayerGroup.clearLayers();
  if (activeTaxiRoute) return;

  let segmentsToDraw = segments;
  if (selectedTaxiwayRef) {
    segmentsToDraw = segments.filter(t => t.ref && t.ref.toUpperCase().trim() === selectedTaxiwayRef.toUpperCase().trim());
    if (segmentsToDraw.length === 0) segmentsToDraw = segments; // fallback
  }

  const renderedLabels = new Set();

  for (const twy of segmentsToDraw) {
    if (!twy.coordinates || twy.coordinates.length < 2) continue;

    const isClosed = twy.is_closed;
    const isSelected = selectedTaxiwayRef && twy.ref && twy.ref.toUpperCase().trim() === selectedTaxiwayRef.toUpperCase().trim();

    let color = isClosed ? '#ff4757' : (isSelected ? '#00d4ff' : '#ffb800');
    let weight = isClosed ? 4.5 : (isSelected ? 5.5 : 3.0);
    let dash = isClosed ? '8,4' : null;

    const line = L.polyline(twy.coordinates, {
      color,
      weight,
      dashArray: dash,
      opacity: isClosed ? 0.95 : (isSelected ? 1 : 0.85),
      lineCap: 'round',
      lineJoin: 'round'
    });

    if (twy.ref) {
      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (isEditMode) {
          switchEditorTab('taxiways');
          selectTaxiwayForEditing(twy.ref);
        } else {
          selectTaxiway(twy.ref);
        }
      });
    }

    taxiwayLayerGroup.addLayer(line);

    // Label badge along midpoint (Clean without "TWY" prefix)
    const cleanRef = twy.ref ? twy.ref.trim() : '';
    if (cleanRef && !renderedLabels.has(cleanRef)) {
      renderedLabels.add(cleanRef);
      const midIdx = Math.floor(twy.coordinates.length / 2);
      const [mLat, mLon] = twy.coordinates[midIdx];

      const badgeHtml = isClosed
        ? `<div class="twy-map-badge closed">❌ ${cleanRef} [CLSD]</div>`
        : (isSelected
            ? `<div class="twy-map-badge" style="background:#00d4ff;color:#0a0d14;border-color:#fff;font-weight:900;">${cleanRef}</div>`
            : `<div class="twy-map-badge">${cleanRef}</div>`);

      const badge = L.marker([mLat, mLon], {
        icon: L.divIcon({
          className: 'aviation-sign-icon',
          html: badgeHtml,
          iconSize: null,
          iconAnchor: [0, 0]
        })
      });

      badge.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        if (isEditMode) {
          switchEditorTab('taxiways');
          selectTaxiwayForEditing(cleanRef);
        } else {
          selectTaxiway(cleanRef);
        }
      });

      taxiwayLayerGroup.addLayer(badge);
    }
  }

  if (isEditMode && currentEditorTab === 'taxiways') {
    renderTaxiwayVertexHandles();
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

    // Clicking runway polyline isolates that runway!
    poly.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const key = getRunwayKey(rwy);
      selectedRunwayKey = (selectedRunwayKey === key) ? null : key;
      clearRunwayLayers();
      drawRunways(lastResult);
      updateResults(lastResult);
    });

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

    if (leLabel) {
      leLabel.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const key = getRunwayKey(rwy);
        selectedRunwayKey = (selectedRunwayKey === key) ? null : key;
        clearRunwayLayers();
        drawRunways(lastResult);
        updateResults(lastResult);
      });
      runwayLayers.push(leLabel);
    }
    if (heLabel) {
      heLabel.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        const key = getRunwayKey(rwy);
        selectedRunwayKey = (selectedRunwayKey === key) ? null : key;
        clearRunwayLayers();
        drawRunways(lastResult);
        updateResults(lastResult);
      });
      runwayLayers.push(heLabel);
    }
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
    renderTaxiwaySelector(data.taxiways);
  }

  // Draw Terminals, Gates & Stands Layer
  drawAirportTerminals(data);
}

// ── Taxiway Sidebar Selector & Reset ──────────────────────────────────────────

function renderTaxiwaySelector(taxiways) {
  const panel = document.getElementById('displaySettingsPanel');
  if (!panel) return;

  let container = document.getElementById('twyPillContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'twyPillContainer';
    container.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:10px;padding-top:8px;border-top:1px solid var(--border);';
    panel.querySelector('.panel-body').appendChild(container);
  }

  const segments = Array.isArray(taxiways) ? taxiways : (taxiways?.segments || []);
  const uniqueRefs = [...new Set(segments.map(t => t.ref).filter(Boolean))].sort();
  if (uniqueRefs.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = `
    <div style="width:100%;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-size:10.5px;color:var(--text-muted);text-transform:uppercase;font-weight:700;">
        ${selectedTaxiwayRef ? `Isolated: TWY [${selectedTaxiwayRef}]` : 'Select Taxiway to Isolate:'}
      </span>
      ${selectedTaxiwayRef ? `<button class="btn-reset-view" id="btnShowAllTwy">Show All</button>` : ''}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:4px;max-height:90px;overflow-y:auto;width:100%;">
  `;

  for (const ref of uniqueRefs) {
    const isSel = selectedTaxiwayRef === ref;
    const isClsd = taxiways.some(t => t.ref === ref && t.is_closed);
    
    let btnStyle = 'padding:2px 7px;font-family:var(--font-mono);font-size:11px;font-weight:700;border-radius:3px;cursor:pointer;transition:all 0.15s;';
    if (isSel) {
      btnStyle += 'background:#00d4ff;color:#0a0d14;border:1px solid #00d4ff;';
    } else if (isClsd) {
      btnStyle += 'background:rgba(255,71,87,0.2);color:#ff4757;border:1px solid #ff4757;';
    } else {
      btnStyle += 'background:var(--bg-base);color:#ffb800;border:1px solid var(--border);';
    }

    html += `<button class="twy-select-pill" data-ref="${ref}" style="${btnStyle}">${isClsd ? '🚫 ' : ''}${ref}</button>`;
  }

  html += `</div>`;
  container.innerHTML = html;

  const btnReset = document.getElementById('btnShowAllTwy');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      resetTaxiwaySelection();
    });
  }

  container.querySelectorAll('.twy-select-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const ref = btn.dataset.ref;
      if (selectedTaxiwayRef === ref) {
        resetTaxiwaySelection();
      } else {
        selectTaxiway(ref);
      }
    });
  });
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
  const { on_runway, on_taxiway, active_taxiway: twy, within_runway_scope, airport, operational, active_runway: rwy, runways } = data;

  // Hide initial instruction card
  document.getElementById('instructionCard').classList.add('hidden');

  // If pin dropped on a runway, auto-select that runway to isolate it!
  if (on_runway && rwy) {
    selectedRunwayKey = getRunwayKey(rwy);
  }

  // 1. Coordinates card
  document.getElementById('coordsCard').classList.remove('hidden');
  document.getElementById('coordsValue').textContent =
    `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;

  // 2. Airport Info Card
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

  // 3. Airport Runways List
  const nearbyPanel = document.getElementById('nearbyPanel');
  const nearbyList  = document.getElementById('nearbyList');
  nearbyList.innerHTML = '';

  if (runways && runways.length > 0) {
    nearbyPanel.classList.remove('hidden');
    
    const headerHtml = `
      <div class="panel-header-left">
        <span class="panel-icon">🛫</span>
        <span class="panel-title">${airport ? `${airport.icao} Runways (${runways.length})` : 'Airport Runways'}</span>
      </div>
      ${selectedRunwayKey ? `<button class="btn-reset-view" id="btnShowAllRunways">Show All</button>` : ''}
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

  // 4. Telemetry Info (Status Banner + Runway Measurements)
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

  // 5 & 6. Render Feeds Panel & NOTAMs
  renderFeedsPanel(operational);
  renderNotamsPanel(operational, airport?.icao);

  // 7. On-Pin Popup Notification Card
  if (pinMarker) {
    pinMarker.closePopup();
    pinMarker.unbindPopup();

    const isAtis = operational && (operational.source === 'real_world' || operational.source === 'vatsim' || operational.source === 'ivao' || operational.source === 'Real ATIS' || operational.source === 'VATSIM ATIS');
    const sourceTag = operational?.source_label || 'METAR';
    const windStr = operational?.wind_dir !== null && operational?.wind_speed !== null
      ? `${operational.wind_dir}&deg; @ ${operational.wind_speed} kt${operational.wind_gust ? ' G ' + operational.wind_gust + ' kt' : ''}`
      : 'Calm / Variable';

    if (on_runway && rwy && rwy.analysis) {
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
            <span class="airport-elev-badge-popup">▲ ${elevStr}</span>
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
            <span class="airport-elev-badge-popup">▲ ${elevStr}</span>
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



// ── Draw Terminals, Gates & Stands ──────────────────────────────────────────

function calculateBearing(lat1, lon1, lat2, lon2) {
  const RAD = Math.PI / 180;
  const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function mergeGatesAndStandsClient(gates = [], stands = []) {
  const bays = [];
  const usedStands = new Set();
  const usedRefs = new Map();

  (gates || []).forEach(g => {
    if (!g.lat || !g.lon || !g.ref) return;
    const cleanRef = String(g.ref).toUpperCase().trim();

    let match = (stands || []).find(s => s.ref && String(s.ref).toUpperCase().trim() === cleanRef && !usedStands.has(s.id));
    if (!match) {
      match = (stands || []).find(s => {
        if (!s.ref || usedStands.has(s.id) || !s.lat || !s.lon) return false;
        const sRef = String(s.ref).toUpperCase().trim();
        const sameBase = sRef.replace(/[A-Z]/g, "") === cleanRef.replace(/[A-Z]/g, "");
        if (!sameBase) return false;
        const d = haversine(g.lat, g.lon, s.lat, s.lon);
        return d <= 120.0;
      });
    }

    if (match) {
      usedStands.add(match.id);
      const heading = calculateBearing(match.lat, match.lon, g.lat, g.lon);
      bays.push({
        id: "bay_" + cleanRef,
        ref: cleanRef,
        name: `Gate ${cleanRef}`,
        type: "gate",
        has_jetbridge: true,
        lat: match.lat,
        lon: match.lon,
        jetbridge_lat: g.lat,
        jetbridge_lon: g.lon,
        heading: Math.round(heading),
        max_wingspan_m: match.max_wingspan_m || null
      });
      usedRefs.set(cleanRef, true);
    } else {
      bays.push({
        id: "bay_" + cleanRef,
        ref: cleanRef,
        name: `Gate ${cleanRef}`,
        type: "gate",
        has_jetbridge: true,
        lat: g.lat,
        lon: g.lon,
        jetbridge_lat: g.lat,
        jetbridge_lon: g.lon,
        heading: 0,
        max_wingspan_m: null
      });
      usedRefs.set(cleanRef, true);
    }
  });

  (stands || []).forEach(s => {
    if (!s.lat || !s.lon || !s.ref || usedStands.has(s.id)) return;
    const cleanRef = String(s.ref).toUpperCase().trim();
    if (usedRefs.has(cleanRef)) return;

    bays.push({
      id: "bay_" + cleanRef,
      ref: cleanRef,
      name: `Stand ${cleanRef}`,
      type: "stand",
      has_jetbridge: false,
      lat: s.lat,
      lon: s.lon,
      jetbridge_lat: null,
      jetbridge_lon: null,
      heading: 0,
      max_wingspan_m: s.max_wingspan_m || null
    });
    usedRefs.set(cleanRef, true);
  });

  return bays;
}

function isValidAviationRef(ref) {
  if (!ref) return false;
  const s = String(ref).trim();
  if (!s || s === 'null' || s === 'undefined') return false;
  if (/^[0-9]{5,}$/.test(s)) return false;
  return true;
}

async function drawAirportTerminals(data) {
  terminalLayerGroup.clearLayers();
  gateLayerGroup.clearLayers();
  standLayerGroup.clearLayers();
  editorLayerGroup.clearLayers();

  if (!data) data = lastResult;
  if (!data) return;

  // Load terminals / bays / hold_points if missing
  if ((!data.bays || data.bays.length === 0) && (!data.gates || data.gates.length === 0) && (!data.stands || data.stands.length === 0)) {
    const icao = data.airport?.icao || data.active_runway?.airport_icao;
    if (icao) {
      try {
        const res = await fetch('/api/terminals?icao=' + encodeURIComponent(icao));
        const tData = await res.json();
        if (tData) {
          data.terminals = tData.terminals || [];
          data.gates = (tData.gates || []).filter(g => isValidAviationRef(g.ref));
          data.stands = (tData.stands || []).filter(s => isValidAviationRef(s.ref));
          data.bays = tData.bays || mergeGatesAndStandsClient(data.gates, data.stands);
          data.hold_points = tData.hold_points || [];
        }
      } catch (e) {
        console.warn('Could not load bays for ' + icao, e);
      }
    }
  }

  // Load taxiways if missing from data
  if (!data.taxiways || (Array.isArray(data.taxiways) && data.taxiways.length === 0) || (data.taxiways.segments && data.taxiways.segments.length === 0)) {
    const icao = data.airport?.icao || data.active_runway?.airport_icao;
    if (icao) {
      try {
        const res = await fetch('/api/taxiways?icao=' + encodeURIComponent(icao));
        const twData = await res.json();
        if (twData) {
          data.taxiways = twData;
        }
      } catch (e) {}
    }
  }

  const cleanGates = (data.gates || []).filter(g => isValidAviationRef(g.ref));
  const cleanStands = (data.stands || []).filter(s => isValidAviationRef(s.ref));
  const bays = data.bays && data.bays.length > 0 ? data.bays.filter(b => isValidAviationRef(b.ref)) : mergeGatesAndStandsClient(cleanGates, cleanStands);
  data.bays = bays;

  const gateBays = bays.filter(b => b.has_jetbridge);
  const standBays = bays.filter(b => !b.has_jetbridge);

  const gateCountEl = document.getElementById('gateCount');
  const standCountEl = document.getElementById('standCount');
  if (gateCountEl) gateCountEl.textContent = gateBays.length;
  if (standCountEl) standCountEl.textContent = standBays.length;

  populateEditorBayDropdown(bays);
  const taxiSegs = Array.isArray(data.taxiways) ? data.taxiways : (data.taxiways?.segments || []);
  populateEditorTaxiwayDropdown(taxiSegs);
  populateEditorRunwayDropdown(data.runways || data.airport?.runways);

  if (!showTerminals && !isEditMode) return;

  if (!map.hasLayer(gateLayerGroup)) map.addLayer(gateLayerGroup);
  if (!map.hasLayer(standLayerGroup)) map.addLayer(standLayerGroup);
  if (!map.hasLayer(editorLayerGroup)) map.addLayer(editorLayerGroup);

  // 1. Draw Unified Aircraft Parking Bays
  bays.forEach(bay => {
    if (!bay.lat || !bay.lon || !isValidAviationRef(bay.ref)) return;

    const isGate = bay.has_jetbridge;
    if (!isEditMode) {
      if (isGate && !showGates) return;
      if (!isGate && !showStands) return;
    }

    const targetLayer = isGate ? gateLayerGroup : standLayerGroup;
    const isSelected = isEditMode && currentEditorTab === 'gates' && selectedBayRef === bay.ref;

    // Aircraft Parking Stop Line (T-bar / stop box)
    const tBar = L.circleMarker([bay.lat, bay.lon], {
      radius: isSelected ? 7 : 4.5,
      color: isSelected ? '#facc15' : (isGate ? '#c084fc' : '#eab308'),
      fillColor: isSelected ? '#f59e0b' : (isGate ? '#7c3aed' : '#ca8a04'),
      fillOpacity: 0.95,
      weight: isSelected ? 2.5 : 1.8,
      interactive: false
    });
    targetLayer.addLayer(tBar);

    // Custom Traced Lead-In Line
    let customLine = null;
    if (bay.lead_in_coords && Array.isArray(bay.lead_in_coords) && bay.lead_in_coords.length >= 2) {
      customLine = L.polyline(bay.lead_in_coords, {
        color: isSelected ? '#fde047' : '#eab308',
        weight: isSelected ? 4.5 : 3.0,
        opacity: 0.95,
        interactive: false
      });
      targetLayer.addLayer(customLine);

      // Smooth, robust draggable waypoint handles
      if (isEditMode && isSelected && !isTracingLeadIn && !isSnappingToTaxiway) {
        bay.lead_in_coords.forEach((pt, pIdx) => {
          const isStart = (pIdx === 0);
          const isEnd = (pIdx === bay.lead_in_coords.length - 1);
          
          const handleMarker = L.marker(pt, {
            draggable: true,
            autoPan: true,
            icon: L.divIcon({
              className: 'lead-in-handle-wrapper',
              html: `<div class="lead-in-handle ${isStart ? 'handle-start' : (isEnd ? 'handle-end' : 'handle-mid')}" title="${isStart ? 'Parking Stop' : (isEnd ? 'Taxiway Connection' : 'Waypoint ' + pIdx)}"></div>`,
              iconSize: [18, 18],
              iconAnchor: [9, 9]
            })
          });

          handleMarker.on('drag', (e) => {
            const newCoord = [e.target.getLatLng().lat, e.target.getLatLng().lng];
            bay.lead_in_coords[pIdx] = newCoord;
            if (isStart) {
              bay.lat = newCoord[0];
              bay.lon = newCoord[1];
              tBar.setLatLng([newCoord[0], newCoord[1]]);
            }
            if (customLine) customLine.setLatLngs(bay.lead_in_coords);
          });

          handleMarker.on('dragend', (e) => {
            const newCoord = [e.target.getLatLng().lat, e.target.getLatLng().lng];
            bay.lead_in_coords[pIdx] = newCoord;
            if (isStart) {
              bay.lat = newCoord[0];
              bay.lon = newCoord[1];
            }
            hasUnsavedChanges = true;
            showEditorToast(`📍 Adjusted ${isStart ? 'Start' : (isEnd ? 'Taxiway Connection' : 'Waypoint ' + pIdx)} of ${bay.ref}`);
            saveEditorChanges(true);
          });

          editorLayerGroup.addLayer(handleMarker);
        });
      }
    }

    // Number Badge
    const badgeHtml = `<div class="bay-badge ${isGate ? 'gate' : 'stand'} ${isEditMode ? 'editing' : ''} ${isSelected ? 'selected' : ''}" onclick="window.selectBayFromBadge('${bay.ref}', event)" id="bay-marker-${bay.ref}">${bay.ref}</div>`;

    const badgeMarker = L.marker([bay.lat, bay.lon], {
      draggable: isEditMode && currentEditorTab === 'gates' && !isTracingLeadIn && !isSnappingToTaxiway,
      autoPan: true,
      icon: L.divIcon({
        className: 'bay-icon-wrapper',
        html: badgeHtml,
        iconSize: null,
        iconAnchor: [10, 8]
      })
    });

    if (isEditMode) {
      badgeMarker.on('drag', (e) => {
        const newPos = e.target.getLatLng();
        bay.lat = newPos.lat;
        bay.lon = newPos.lng;
        tBar.setLatLng([newPos.lat, newPos.lng]);
        if (bay.lead_in_coords && bay.lead_in_coords.length > 0) {
          bay.lead_in_coords[0] = [newPos.lat, newPos.lng];
          if (customLine) customLine.setLatLngs(bay.lead_in_coords);
        }
      });

      badgeMarker.on('dragend', (e) => {
        const newPos = e.target.getLatLng();
        bay.lat = newPos.lat;
        bay.lon = newPos.lng;
        hasUnsavedChanges = true;
        showEditorToast(`📍 Moved Spot ${bay.ref} to ${bay.lat.toFixed(6)}, ${bay.lon.toFixed(6)}`);
        saveEditorChanges(true);
      });
    }

    targetLayer.addLayer(badgeMarker);
  });

  // 2. Draw Holding Position Symbols
  drawHoldPoints(data);

  // 3. If in Runway tab, render live center handle
  if (isEditMode && currentEditorTab === 'runways' && selectedRunwayId) {
    const runways = data.runways || data.airport?.runways || [];
    const rwy = runways.find(r => (r.id === selectedRunwayId || (r.le_ident + '/' + r.he_ident) === selectedRunwayId));
    if (rwy) renderRunwayCenterHandle(rwy);
  }

  // 4. If in Taxiway tab, render vertex handles
  if (isEditMode && currentEditorTab === 'taxiways' && selectedTaxiwayRef) {
    renderTaxiwayVertexHandles();
  }

  updateEditorToolbar();
}

window.selectBayFromBadge = function(ref, e) {
  if (e) e.stopPropagation();
  selectBayForEditing(ref);
};

// ── Studio Tabs & State Machine ───────────────────────────────────────────────

let currentEditorTab = 'gates';
let isSnappingToTaxiway = false;
let snapClickListener = null;
let isRetracingTaxiway = false;
let isCreatingNewTaxiway = false;
let currentRetraceCoords = [];
let retraceLineLayer = null;
let selectedHoldPointId = null;

function switchEditorTab(tabName) {
  currentEditorTab = tabName;
  ['gates', 'taxiways', 'runways', 'holdpoints'].forEach(t => {
    const tabBtn = document.getElementById('tabEdit' + t.charAt(0).toUpperCase() + t.slice(1));
    const rowEl = document.getElementById('editor' + t.charAt(0).toUpperCase() + t.slice(1) + 'Row');
    if (tabBtn) tabBtn.classList.toggle('active', t === tabName);
    if (rowEl) rowEl.classList.toggle('hidden', t !== tabName);
  });

  if (tabName === 'taxiways') {
    const taxiSegs = Array.isArray(lastResult?.taxiways) ? lastResult.taxiways : (lastResult?.taxiways?.segments || []);
    populateEditorTaxiwayDropdown(taxiSegs);
    if (!selectedTaxiwayRef && taxiSegs.length > 0) {
      selectTaxiwayForEditing(taxiSegs[0].ref);
    } else if (selectedTaxiwayRef) {
      renderTaxiwayVertexHandles();
    }
  } else if (tabName === 'runways' && lastResult) {
    populateEditorRunwayDropdown(lastResult.runways || lastResult.airport?.runways);
    if (!selectedRunwayId) {
      const rwList = lastResult.runways || lastResult.airport?.runways || [];
      if (rwList.length > 0) {
        selectRunwayForEditing(rwList[0].id || (rwList[0].le_ident + '/' + rwList[0].he_ident));
      }
    }
  } else if (tabName === 'holdpoints' && lastResult) {
    if (lastResult.hold_points && lastResult.hold_points.length > 0 && !selectedHoldPointId) {
      selectHoldPointForEditing(lastResult.hold_points[0].id);
    }
  }

  drawAirportTerminals(lastResult);
}
window.switchEditorTab = switchEditorTab;

function toggleVisualEditorMode(forceState) {
  isEditMode = (forceState !== undefined) ? forceState : !isEditMode;
  
  const btnToggle = document.getElementById('btnToggleEditMode');
  const btnText = document.getElementById('btnEditModeText');
  const btnQuick = document.getElementById('btnQuickEdit');
  const bar = document.getElementById('floatingEditorBar');

  if (isEditMode) {
    if (btnToggle) btnToggle.classList.add('active');
    if (btnText) btnText.textContent = 'Exit Editor Mode';
    if (btnQuick) {
      btnQuick.style.background = '#0284c7';
      btnQuick.style.color = '#ffffff';
    }
    if (bar) bar.classList.remove('hidden');

    showTerminals = true;
    showGates = true;
    showStands = true;
    const termToggle = document.getElementById('terminalToggle');
    if (termToggle) termToggle.checked = true;

    if (!selectedBayRef && lastResult && lastResult.bays && lastResult.bays.length > 0) {
      selectedBayRef = lastResult.bays[0].ref;
    }

    showEditorToast('✏️ Map Editing Studio Active');
  } else {
    if (btnToggle) btnToggle.classList.remove('active');
    if (btnText) btnText.textContent = 'Visual Editor Mode';
    if (btnQuick) {
      btnQuick.style.background = 'rgba(56, 189, 248, 0.25)';
      btnQuick.style.color = '#38bdf8';
    }
    if (bar) bar.classList.add('hidden');
    cancelTracingLeadIn();
    cancelJoinToTaxiway();
    cancelRetracingTaxiway();
    const addPanel = document.getElementById('editorAddPanel');
    if (addPanel) addPanel.classList.add('hidden');
    showEditorToast('Visual Editor Closed');
  }

  drawAirportTerminals(lastResult);
}
window.toggleVisualEditorMode = toggleVisualEditorMode;

// ── Dropdown Populators ───────────────────────────────────────────────────────

function populateEditorBayDropdown(bays) {
  const selectEl = document.getElementById('editorBaySelect');
  if (!selectEl) return;

  const currentVal = selectedBayRef || selectEl.value;
  selectEl.innerHTML = '<option value="">-- Choose Spot --</option>';

  (bays || []).forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.ref;
    opt.textContent = `${b.has_jetbridge ? '🚪 Gate' : '🅿️ Stand'} ${b.ref}`;
    if (b.ref === currentVal) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function selectBayForEditing(ref) {
  if (!ref) return;
  selectedBayRef = ref;

  const selectEl = document.getElementById('editorBaySelect');
  if (selectEl) selectEl.value = ref;

  if (lastResult && lastResult.bays) {
    const bay = lastResult.bays.find(b => b.ref === ref);
    if (bay) {
      const refInput = document.getElementById('editorRefInput');
      const nameInput = document.getElementById('editorNameInput');
      const typeSelect = document.getElementById('editorTypeSelect');
      if (refInput) refInput.value = bay.ref;
      if (nameInput) nameInput.value = bay.name || ((bay.has_jetbridge ? 'Gate ' : 'Stand ') + bay.ref);
      if (typeSelect) typeSelect.value = bay.type || (bay.has_jetbridge ? 'gate' : 'stand');
    }
  }

  drawAirportTerminals(lastResult);
}
window.selectBayForEditing = selectBayForEditing;

function applyBayEdits() {
  if (!selectedBayRef || !lastResult || !lastResult.bays) return;
  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay) return;

  const refInput = document.getElementById('editorRefInput');
  const nameInput = document.getElementById('editorNameInput');
  const typeSelect = document.getElementById('editorTypeSelect');
  if (!refInput || !typeSelect) return;

  const newRef = refInput.value.trim().toUpperCase();
  if (!newRef) {
    alert('Spot number cannot be empty.');
    return;
  }

  const oldRef = bay.ref;
  const newType = typeSelect.value;
  const isGate = newType === 'gate';
  const newName = nameInput && nameInput.value.trim() ? nameInput.value.trim() : ((isGate ? 'Gate ' : 'Stand ') + newRef);

  bay.ref = newRef;
  bay.type = newType;
  bay.has_jetbridge = isGate;
  bay.name = newName;

  selectedBayRef = newRef;
  hasUnsavedChanges = true;
  showEditorToast(`✔️ Updated Spot ${oldRef} -> "${newName}" (${isGate ? 'Gate' : 'Stand'})`);
  saveEditorChanges(true);
  drawAirportTerminals(lastResult);
}
window.applyBayEdits = applyBayEdits;


// ── Magnetic Vertex Snapping Engine ───────────────────────────────────────────

function findMagneticSnapPoint(lat, lon, excludeSeg = null, excludeVIdx = -1, thresholdMeters = 12.0) {
  let closest = null;
  let minD = thresholdMeters;

  // 1. Check all other taxiway vertices
  const segments = Array.isArray(lastResult?.taxiways) ? lastResult.taxiways : (lastResult?.taxiways?.segments || []);
  segments.forEach(seg => {
    const coords = seg.coordinates || [];
    coords.forEach((pt, idx) => {
      if (seg === excludeSeg && idx === excludeVIdx) return;
      const d = haversine(lat, lon, pt[0], pt[1]);
      if (d < minD) {
        minD = d;
        closest = [pt[0], pt[1]];
      }
    });
  });

  // 2. Check all parking bay locations
  (lastResult?.bays || []).forEach(b => {
    if (b.lat && b.lon) {
      const d = haversine(lat, lon, b.lat, b.lon);
      if (d < minD) {
        minD = d;
        closest = [b.lat, b.lon];
      }
    }
  });

  return closest; // returns [lat, lon] if within threshold, else null
}

function joinTaxiwayToNearest() {
  if (!selectedTaxiwayRef || !lastResult?.taxiways) {
    showEditorToast('⚠️ Select a taxiway first.');
    return;
  }
  const segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);
  const matching = segments.filter(s => s.ref && s.ref.toUpperCase().trim() === selectedTaxiwayRef);
  if (matching.length === 0) return;

  let snappedCount = 0;
  matching.forEach(seg => {
    const coords = seg.coordinates || [];
    if (coords.length === 0) return;

    // Check start vertex
    const snapStart = findMagneticSnapPoint(coords[0][0], coords[0][1], seg, 0, 25.0);
    if (snapStart) {
      coords[0] = snapStart;
      snappedCount++;
    }

    // Check end vertex
    const lastIdx = coords.length - 1;
    const snapEnd = findMagneticSnapPoint(coords[lastIdx][0], coords[lastIdx][1], seg, lastIdx, 25.0);
    if (snapEnd) {
      coords[lastIdx] = snapEnd;
      snappedCount++;
    }
  });

  if (snappedCount > 0) {
    showEditorToast(`🔗 Magnetically joined ${snappedCount} endpoint(s) on ${selectedTaxiwayRef} with connecting lines!`);
    saveTaxiwayChanges(true);
    drawTaxiways(lastResult.taxiways);
    renderTaxiwayVertexHandles();
  } else {
    showEditorToast('⚠️ No nearby connecting vertices found within 25m. Drag the vertex closer to snap.');
  }
}
window.joinTaxiwayToNearest = joinTaxiwayToNearest;

// ── Taxiway Routing & Ultra-Smooth Vertex Editor ─────────────────────────────

function populateEditorTaxiwayDropdown(segments) {
  const selectEl = document.getElementById('editorTaxiwaySelect');
  if (!selectEl) return;

  const segs = Array.isArray(segments) ? segments : (segments?.segments || []);
  const uniqueRefs = new Set();
  segs.forEach(s => {
    if (s.ref) uniqueRefs.add(s.ref.toUpperCase().trim());
  });

  const sortedRefs = Array.from(uniqueRefs).sort();
  selectEl.innerHTML = '<option value="">-- Choose Taxiway --</option>';

  sortedRefs.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = `🚖 ${r}`;
    if (r === selectedTaxiwayRef) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function selectTaxiwayForEditing(ref) {
  if (!ref) return;
  selectedTaxiwayRef = ref.toUpperCase().trim();

  const selectEl = document.getElementById('editorTaxiwaySelect');
  if (selectEl) selectEl.value = selectedTaxiwayRef;

  const refInput = document.getElementById('editorTaxiwayRefInput');
  if (refInput) refInput.value = selectedTaxiwayRef;

  if (lastResult?.taxiways) {
    drawTaxiways(lastResult.taxiways);
  }
  renderTaxiwayVertexHandles();
}
window.selectTaxiwayForEditing = selectTaxiwayForEditing;

// Fast in-memory map of active taxiway polyline layers
let activeTaxiPolylines = [];

function renderTaxiwayVertexHandles() {
  editorLayerGroup.clearLayers();
  activeTaxiPolylines = [];
  if (!isEditMode || currentEditorTab !== 'taxiways' || !selectedTaxiwayRef || !lastResult?.taxiways) return;

  const segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);
  const matchingSegs = segments.filter(s => s.ref && s.ref.toUpperCase().trim() === selectedTaxiwayRef);

  matchingSegs.forEach(seg => {
    const coords = seg.coordinates || [];
    
    // Highlight active polyline in thick glowing cyan
    const poly = L.polyline(coords, {
      color: '#00d4ff',
      weight: 6,
      opacity: 0.95,
      interactive: false
    });
    editorLayerGroup.addLayer(poly);
    activeTaxiPolylines.push({ seg, poly });

    coords.forEach((pt, vIdx) => {
      const isEndpoint = (vIdx === 0 || vIdx === coords.length - 1);

      const handleMarker = L.marker(pt, {
        draggable: true,
        autoPan: true,
        icon: L.divIcon({
          className: 'lead-in-handle-wrapper',
          html: `<div class="taxi-vertex-handle ${isEndpoint ? 'handle-endpoint' : ''}" title="${seg.ref} Point ${vIdx + 1} ${isEndpoint ? '(Endpoint)' : ''}"></div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9]
        })
      });

      // Smooth drag with Magnetic Auto-Snapping to nearby vertices!
      handleMarker.on('drag', (e) => {
        let lat = e.target.getLatLng().lat;
        let lng = e.target.getLatLng().lng;

        // Magnetically snap if dragged near another vertex
        const snap = findMagneticSnapPoint(lat, lng, seg, vIdx, 14.0);
        if (snap) {
          lat = snap[0];
          lng = snap[1];
        }

        seg.coordinates[vIdx] = [lat, lng];
        poly.setLatLngs(seg.coordinates);
      });

      handleMarker.on('dragend', (e) => {
        let lat = e.target.getLatLng().lat;
        let lng = e.target.getLatLng().lng;

        const snap = findMagneticSnapPoint(lat, lng, seg, vIdx, 14.0);
        if (snap) {
          lat = snap[0];
          lng = snap[1];
          handleMarker.setLatLng([lat, lng]);
          showEditorToast(`🔗 Magnetically snapped and joined point to connecting taxiway!`);
        } else {
          showEditorToast(`📍 Moved ${seg.ref} vertex to ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
        }

        seg.coordinates[vIdx] = [lat, lng];
        poly.setLatLngs(seg.coordinates);
        saveTaxiwayChanges(true);
        drawTaxiways(lastResult.taxiways);
      });

      editorLayerGroup.addLayer(handleMarker);
    });
  });
}

function insertTaxiwayVertex() {
  if (!selectedTaxiwayRef || !lastResult?.taxiways) return;
  const segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);
  const seg = segments.find(s => s.ref && s.ref.toUpperCase().trim() === selectedTaxiwayRef);
  if (!seg || !seg.coordinates || seg.coordinates.length < 2) return;

  const p1 = seg.coordinates[0];
  const p2 = seg.coordinates[1];
  const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  seg.coordinates.splice(1, 0, mid);

  showEditorToast(`➕ Added vertex to ${seg.ref} (now ${seg.coordinates.length} vertices)`);
  saveTaxiwayChanges(true);
  drawTaxiways(lastResult.taxiways);
  renderTaxiwayVertexHandles();
}
window.insertTaxiwayVertex = insertTaxiwayVertex;

function smoothSelectedTaxiway() {
  if (!selectedTaxiwayRef || !lastResult?.taxiways) return;
  const segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);
  const seg = segments.find(s => s.ref && s.ref.toUpperCase().trim() === selectedTaxiwayRef);
  if (!seg || !seg.coordinates || seg.coordinates.length < 3) {
    showEditorToast('⚠️ Smoothing requires at least 3 vertices.');
    return;
  }

  seg.coordinates = chaikinSmooth(seg.coordinates, 2);
  showEditorToast(`✨ Smoothed ${seg.ref} centerline curvature (${seg.coordinates.length} points)`);
  saveTaxiwayChanges(true);
  drawTaxiways(lastResult.taxiways);
  renderTaxiwayVertexHandles();
}
window.smoothSelectedTaxiway = smoothSelectedTaxiway;

// ── Create New Taxiway Feature ────────────────────────────────────────────────

function startCreatingNewTaxiway() {
  const ref = prompt('Enter identifier for new taxiway (e.g. B, G, LANE 8, M):');
  if (!ref || !ref.trim()) return;
  const cleanRef = ref.trim().toUpperCase();

  cancelRetracingTaxiway();
  isCreatingNewTaxiway = true;
  currentRetraceCoords = [];
  selectedTaxiwayRef = cleanRef;

  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.add('crosshair-cursor');

  showEditorToast(`✏️ Drawing new Taxiway "${cleanRef}": Click points along the centerline on the map.`);

  map.on('click', handleRetraceMapClick);
}
window.startCreatingNewTaxiway = startCreatingNewTaxiway;

function startRetracingTaxiway() {
  if (!selectedTaxiwayRef || !lastResult?.taxiways) {
    startCreatingNewTaxiway();
    return;
  }

  cancelRetracingTaxiway();
  isRetracingTaxiway = true;
  currentRetraceCoords = [];

  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.add('crosshair-cursor');

  showEditorToast(`✏️ Re-tracing ${selectedTaxiwayRef}: Click points along the yellow taxiway centerline on the map.`);

  map.on('click', handleRetraceMapClick);
}
window.startRetracingTaxiway = startRetracingTaxiway;

function handleRetraceMapClick(e) {
  if (!isRetracingTaxiway && !isCreatingNewTaxiway) return;
  const pt = [e.latlng.lat, e.latlng.lng];
  currentRetraceCoords.push(pt);

  if (retraceLineLayer) editorLayerGroup.removeLayer(retraceLineLayer);
  retraceLineLayer = L.polyline(currentRetraceCoords, {
    color: '#00d4ff',
    weight: 5,
    dashArray: '4,4',
    opacity: 1
  });
  editorLayerGroup.addLayer(retraceLineLayer);

  showEditorToast(`Point ${currentRetraceCoords.length} added. Click [Rename / Update] when done.`);
}

function cancelRetracingTaxiway() {
  isRetracingTaxiway = false;
  isCreatingNewTaxiway = false;
  if (retraceLineLayer) editorLayerGroup.removeLayer(retraceLineLayer);
  retraceLineLayer = null;
  currentRetraceCoords = [];
  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.remove('crosshair-cursor');
  map.off('click', handleRetraceMapClick);
}

async function applyTaxiwayEdits() {
  if (!selectedTaxiwayRef || !lastResult) return;
  if (!lastResult.taxiways) lastResult.taxiways = { icao: currentIcao || 'KLGA', segments: [] };
  
  let segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);

  const refInput = document.getElementById('editorTaxiwayRefInput');
  const newRef = refInput && refInput.value.trim() ? refInput.value.trim().toUpperCase() : selectedTaxiwayRef;

  const oldRef = selectedTaxiwayRef;

  // If creating new taxiway or re-tracing:
  if ((isCreatingNewTaxiway || isRetracingTaxiway) && currentRetraceCoords.length >= 2) {
    let seg = segments.find(s => s.ref && s.ref.toUpperCase().trim() === oldRef);
    if (!seg) {
      seg = {
        id: 'twy_' + Date.now(),
        ref: newRef,
        name: newRef,
        coordinates: currentRetraceCoords,
        is_closed: false
      };
      segments.push(seg);
    } else {
      seg.ref = newRef;
      seg.name = newRef;
      seg.coordinates = currentRetraceCoords;
    }
    cancelRetracingTaxiway();
  } else {
    segments.forEach(s => {
      if (s.ref && s.ref.toUpperCase().trim() === oldRef) {
        s.ref = newRef;
        s.name = newRef;
      }
    });
  }

  if (Array.isArray(lastResult.taxiways)) lastResult.taxiways = segments;
  else lastResult.taxiways.segments = segments;

  selectedTaxiwayRef = newRef;
  showEditorToast(`✔️ Saved Taxiway ${newRef}`);
  saveTaxiwayChanges(false);
  drawTaxiways(lastResult.taxiways);
  populateEditorTaxiwayDropdown(segments);
  renderTaxiwayVertexHandles();
}
window.applyTaxiwayEdits = applyTaxiwayEdits;

function deleteSelectedTaxiway() {
  if (!selectedTaxiwayRef || !lastResult || !lastResult.taxiways) return;
  const ref = selectedTaxiwayRef;
  if (!confirm(`Are you sure you want to delete taxiway ${ref}?`)) return;

  let segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);
  segments = segments.filter(s => !(s.ref && s.ref.toUpperCase().trim() === ref));
  if (Array.isArray(lastResult.taxiways)) lastResult.taxiways = segments;
  else lastResult.taxiways.segments = segments;

  selectedTaxiwayRef = segments.length > 0 ? segments[0].ref : null;
  saveTaxiwayChanges(false);
  drawTaxiways(lastResult.taxiways);
  populateEditorTaxiwayDropdown(segments);
  showEditorToast(`🗑️ Deleted Taxiway ${ref}`);
}
window.deleteSelectedTaxiway = deleteSelectedTaxiway;

async function saveTaxiwayChanges(isSilent = false) {
  if (!lastResult || !lastResult.taxiways) return;
  const icao = lastResult.airport?.icao || lastResult.active_runway?.airport_icao || currentIcao || 'KLGA';
  const segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways.segments || []);

  try {
    const res = await fetch('/api/taxiways/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        icao: icao,
        segments: segments
      })
    });
    const data = await res.json();
    if (data.success) {
      if (!isSilent) showEditorToast(`💾 Saved ${data.count} taxiway segments for ${icao} to database!`);
    }
  } catch (e) {
    if (!isSilent) alert('Error saving taxiways: ' + e.message);
  }
}
window.saveTaxiwayChanges = saveTaxiwayChanges;

// ── Runway Calibration Transform Tool ────────────────────────────────────────

function populateEditorRunwayDropdown(runways) {
  const selectEl = document.getElementById('editorRunwaySelect');
  if (!selectEl) return;

  selectEl.innerHTML = '<option value="">-- Runway --</option>';
  (runways || []).forEach(r => {
    const opt = document.createElement('option');
    const rId = r.id || (r.le_ident + '/' + r.he_ident);
    opt.value = rId;
    opt.textContent = `RWY ${r.le_ident}/${r.he_ident}`;
    if (rId === selectedRunwayId) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function selectRunwayForEditing(id) {
  if (!id) return;
  selectedRunwayId = id;

  const selectEl = document.getElementById('editorRunwaySelect');
  if (selectEl) selectEl.value = id;

  const runways = lastResult?.runways || lastResult?.airport?.runways || [];
  const rwy = runways.find(r => (r.id === id || (r.le_ident + '/' + r.he_ident) === id));
  if (!rwy) return;

  const heading = rwy.he_heading_degT || rwy.le_heading_degT || 0;
  const slider = document.getElementById('runwayAngleSlider');
  const input = document.getElementById('runwayAngleInput');
  if (slider) slider.value = heading;
  if (input) input.value = heading.toFixed(1);

  renderRunwayCenterHandle(rwy);
  clearRunwayLayers();
  drawRunways(lastResult);
}
window.selectRunwayForEditing = selectRunwayForEditing;

function renderRunwayCenterHandle(rwy) {
  if (!rwy) return;

  const centerLat = rwy.latitude_deg || ((rwy.le_latitude + rwy.he_latitude) / 2);
  const centerLon = rwy.longitude_deg || ((rwy.le_longitude + rwy.he_longitude) / 2);

  const centerMarker = L.marker([centerLat, centerLon], {
    draggable: true,
    autoPan: true,
    icon: L.divIcon({
      className: 'lead-in-handle-wrapper',
      html: '<div class="runway-center-handle" title="Drag to move entire runway"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    })
  });

  centerMarker.on('drag', (e) => {
    const newPos = e.target.getLatLng();
    const dLat = newPos.lat - centerLat;
    const dLon = newPos.lng - centerLon;
    
    rwy.latitude_deg = newPos.lat;
    rwy.longitude_deg = newPos.lng;
    if (rwy.le_latitude) rwy.le_latitude += dLat;
    if (rwy.le_longitude) rwy.le_longitude += dLon;
    if (rwy.he_latitude) rwy.he_latitude += dLat;
    if (rwy.he_longitude) rwy.he_longitude += dLon;

    clearRunwayLayers();
    drawRunways(lastResult);
  });

  centerMarker.on('dragend', () => {
    showEditorToast(`📍 Moved RWY ${rwy.le_ident}/${rwy.he_ident} to new position`);
    saveRunwayChanges(true);
    drawAirportTerminals(lastResult);
  });

  editorLayerGroup.addLayer(centerMarker);
}

function nudgeRunway(dLat, dLon) {
  const runways = lastResult?.runways || lastResult?.airport?.runways || [];
  const rwy = runways.find(r => (r.id === selectedRunwayId || (r.le_ident + '/' + r.he_ident) === selectedRunwayId));
  if (!rwy) return;

  if (rwy.latitude_deg) rwy.latitude_deg += dLat;
  if (rwy.longitude_deg) rwy.longitude_deg += dLon;
  if (rwy.le_latitude) rwy.le_latitude += dLat;
  if (rwy.le_longitude) rwy.le_longitude += dLon;
  if (rwy.he_latitude) rwy.he_latitude += dLat;
  if (rwy.he_longitude) rwy.he_longitude += dLon;

  clearRunwayLayers();
  drawRunways(lastResult);
  drawAirportTerminals(lastResult);
}
window.nudgeRunway = nudgeRunway;

function handleRunwaySlider(val) {
  const heading = parseFloat(val);
  const input = document.getElementById('runwayAngleInput');
  if (input) input.value = heading.toFixed(1);
  updateRunwayRotation(heading);
}
window.handleRunwaySlider = handleRunwaySlider;

function handleRunwayAngleInput(val) {
  const heading = parseFloat(val);
  const slider = document.getElementById('runwayAngleSlider');
  if (slider) slider.value = heading;
  updateRunwayRotation(heading);
}
window.handleRunwayAngleInput = handleRunwayAngleInput;

function stepRunwayAngle(delta) {
  const input = document.getElementById('runwayAngleInput');
  if (!input) return;
  let curr = parseFloat(input.value) || 0;
  curr = (curr + delta + 360) % 360;
  input.value = curr.toFixed(1);
  const slider = document.getElementById('runwayAngleSlider');
  if (slider) slider.value = curr;
  updateRunwayRotation(curr);
}
window.stepRunwayAngle = stepRunwayAngle;

function updateRunwayRotation(heading) {
  const runways = lastResult?.runways || lastResult?.airport?.runways || [];
  const rwy = runways.find(r => (r.id === selectedRunwayId || (r.le_ident + '/' + r.he_ident) === selectedRunwayId));
  if (!rwy) return;

  rwy.he_heading_degT = heading;
  rwy.le_heading_degT = (heading + 180) % 360;

  const centerLat = rwy.latitude_deg || ((rwy.le_latitude + rwy.he_latitude) / 2);
  const centerLon = rwy.longitude_deg || ((rwy.le_longitude + rwy.he_longitude) / 2);
  const lengthMeters = (rwy.length_ft || 7000) * 0.3048;
  const halfLen = lengthMeters / 2;

  const rad = (heading * Math.PI) / 180;
  const mToLat = 1 / 111132.954;
  const mToLon = 1 / (111132.954 * Math.cos((centerLat * Math.PI) / 180));

  const dLat = halfLen * Math.cos(rad) * mToLat;
  const dLon = halfLen * Math.sin(rad) * mToLon;

  rwy.he_latitude = centerLat + dLat;
  rwy.he_longitude = centerLon + dLon;
  rwy.le_latitude = centerLat - dLat;
  rwy.le_longitude = centerLon - dLon;

  clearRunwayLayers();
  drawRunways(lastResult);
  drawAirportTerminals(lastResult);
}

async function saveRunwayChanges(isSilent = false) {
  const runways = lastResult?.runways || lastResult?.airport?.runways || [];
  const icao = lastResult?.airport?.icao || currentIcao || 'KLGA';

  try {
    const res = await fetch('/api/runways/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icao: icao, runways: runways })
    });
    const data = await res.json();
    if (data.success) {
      if (!isSilent) showEditorToast(`💾 Saved ${data.count} calibrated runways for ${icao} to database!`);
    }
  } catch (e) {
    if (!isSilent) alert('Error saving runways: ' + e.message);
  }
}
window.saveRunwayChanges = saveRunwayChanges;

// ── Holding Position Markers ──────────────────────────────────────────────────

function drawHoldPoints(data) {
  const holdPoints = data.hold_points || [];
  holdPoints.forEach(hp => {
    if (!hp.lat || !hp.lon) return;
    const shape = hp.shape || 'triangle';
    const refText = hp.ref || '';
    const heading = hp.heading || 0;
    const isSelected = isEditMode && currentEditorTab === 'holdpoints' && selectedHoldPointId === hp.id;

    const markerHtml = `<div class="hold-spot-marker ${shape} ${isSelected ? 'selected' : ''}" style="transform: rotate(${heading}deg);" title="Hold Position ${refText}"><span>${refText}</span></div>`;

    const hpMarker = L.marker([hp.lat, hp.lon], {
      draggable: isEditMode && currentEditorTab === 'holdpoints',
      autoPan: true,
      icon: L.divIcon({
        className: 'hold-spot-wrapper',
        html: markerHtml,
        iconSize: null,
        iconAnchor: [11, 11]
      })
    });

    hpMarker.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      if (isEditMode) {
        switchEditorTab('holdpoints');
        selectHoldPointForEditing(hp.id);
      }
    });

    if (isEditMode) {
      hpMarker.on('dragend', (e) => {
        hp.lat = e.target.getLatLng().lat;
        hp.lon = e.target.getLatLng().lng;
        showEditorToast(`📍 Moved Hold Spot ${refText} to ${hp.lat.toFixed(6)}, ${hp.lon.toFixed(6)}`);
        saveHoldPointsChanges(true);
      });
    }

    editorLayerGroup.addLayer(hpMarker);
  });
}

function selectHoldPointForEditing(id) {
  selectedHoldPointId = id;
  const holdPoints = lastResult?.hold_points || [];
  const hp = holdPoints.find(h => h.id === id);
  if (!hp) return;

  const shapeSelect = document.getElementById('holdPointShapeSelect');
  const refInput = document.getElementById('holdPointRefInput');
  const angleSlider = document.getElementById('holdPointAngleSlider');
  const angleVal = document.getElementById('holdPointAngleVal');

  if (shapeSelect) shapeSelect.value = hp.shape || 'triangle';
  if (refInput) refInput.value = hp.ref || '';
  if (angleSlider) angleSlider.value = hp.heading || 0;
  if (angleVal) angleVal.textContent = (hp.heading || 0) + '°';

  drawAirportTerminals(lastResult);
}
window.selectHoldPointForEditing = selectHoldPointForEditing;

function updateSelectedHoldPointShape(shape) {
  const holdPoints = lastResult?.hold_points || [];
  const hp = holdPoints.find(h => h.id === selectedHoldPointId);
  if (!hp) return;
  hp.shape = shape;
  saveHoldPointsChanges(true);
  drawAirportTerminals(lastResult);
}
window.updateSelectedHoldPointShape = updateSelectedHoldPointShape;

function updateSelectedHoldPointText(txt) {
  const holdPoints = lastResult?.hold_points || [];
  const hp = holdPoints.find(h => h.id === selectedHoldPointId);
  if (!hp) return;
  hp.ref = txt.trim().toUpperCase();
  saveHoldPointsChanges(true);
  drawAirportTerminals(lastResult);
}
window.updateSelectedHoldPointText = updateSelectedHoldPointText;

function updateSelectedHoldPointAngle(deg) {
  const heading = parseInt(deg) || 0;
  const angleVal = document.getElementById('holdPointAngleVal');
  if (angleVal) angleVal.textContent = heading + '°';

  const holdPoints = lastResult?.hold_points || [];
  const hp = holdPoints.find(h => h.id === selectedHoldPointId);
  if (!hp) return;
  hp.heading = heading;
  drawAirportTerminals(lastResult);
}
window.updateSelectedHoldPointAngle = updateSelectedHoldPointAngle;

function createHoldPointAtCenter() {
  if (!lastResult) return;
  const shapeSelect = document.getElementById('holdPointShapeSelect');
  const refInput = document.getElementById('holdPointRefInput');
  const angleSlider = document.getElementById('holdPointAngleSlider');
  const shape = shapeSelect ? shapeSelect.value : 'triangle';
  const ref = refInput && refInput.value.trim() ? refInput.value.trim().toUpperCase() : 'B1';
  const heading = angleSlider ? parseInt(angleSlider.value) : 0;

  const center = map.getCenter();
  if (!lastResult.hold_points) lastResult.hold_points = [];

  const newHp = {
    id: 'hp_' + Date.now(),
    shape: shape,
    ref: ref,
    name: 'Hold Short ' + ref,
    lat: center.lat,
    lon: center.lng,
    heading: heading
  };

  lastResult.hold_points.push(newHp);
  selectedHoldPointId = newHp.id;
  showEditorToast(`📍 Created ${shape.toUpperCase()} Hold Spot "${ref}". Drag into position and adjust angle slider.`);
  saveHoldPointsChanges(true);
  drawAirportTerminals(lastResult);
}
window.createHoldPointAtCenter = createHoldPointAtCenter;

function deleteSelectedHoldPoint() {
  if (!selectedHoldPointId || !lastResult?.hold_points) return;
  const id = selectedHoldPointId;
  lastResult.hold_points = lastResult.hold_points.filter(h => h.id !== id);
  selectedHoldPointId = lastResult.hold_points.length > 0 ? lastResult.hold_points[0].id : null;
  saveHoldPointsChanges(true);
  drawAirportTerminals(lastResult);
  showEditorToast('🗑️ Deleted Hold Spot');
}
window.deleteSelectedHoldPoint = deleteSelectedHoldPoint;

async function saveHoldPointsChanges(isSilent = false) {
  if (!lastResult) return;
  const icao = lastResult.airport?.icao || currentIcao || 'KLGA';
  const holdPoints = lastResult.hold_points || [];

  try {
    const res = await fetch('/api/holdpoints/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ icao: icao, hold_points: holdPoints })
    });
    const data = await res.json();
    if (data.success) {
      if (!isSilent) showEditorToast(`💾 Saved ${data.count} holding spots for ${icao} to database!`);
    }
  } catch (e) {
    if (!isSilent) alert('Error saving hold points: ' + e.message);
  }
}
window.saveHoldPointsChanges = saveHoldPointsChanges;

// ── Path Curvature Spline Smoother ────────────────────────────────────────────

function smoothSelectedPath() {
  if (!selectedBayRef || !lastResult?.bays) return;
  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay || !bay.lead_in_coords || bay.lead_in_coords.length < 3) {
    showEditorToast('⚠️ Smoothing requires at least 3 path waypoints.');
    return;
  }

  bay.lead_in_coords = chaikinSmooth(bay.lead_in_coords, 2);
  showEditorToast(`✨ Smoothed lead-in curve for ${bay.ref} (${bay.lead_in_coords.length} points)`);
  saveEditorChanges(true);
  drawAirportTerminals(lastResult);
}
window.smoothSelectedPath = smoothSelectedPath;

function chaikinSmooth(points, iterations = 2) {
  let pts = [...points];
  for (let iter = 0; iter < iterations; iter++) {
    const refined = [];
    refined.push(pts[0]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const q = [0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]];
      const r = [0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]];
      refined.push(q);
      refined.push(r);
    }
    refined.push(pts[pts.length - 1]);
    pts = refined;
  }
  return pts;
}

// ── Interactive "Join / Snap to Taxiway" Feature ──────────────────────────────

function startJoinToTaxiway() {
  if (!lastResult || !lastResult.bays) {
    showEditorToast('⚠️ Load an airport first before joining paths.');
    return;
  }
  if (!selectedBayRef && lastResult.bays.length > 0) {
    selectedBayRef = lastResult.bays[0].ref;
  }
  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay) {
    showEditorToast('⚠️ Select a gate or stand first.');
    return;
  }

  cancelTracingLeadIn();
  cancelJoinToTaxiway();

  isSnappingToTaxiway = true;

  const banner = document.getElementById('snapInstructionBanner');
  const refSpan = document.getElementById('snapBayRef');
  if (banner) banner.classList.remove('hidden');
  if (refSpan) refSpan.textContent = bay.name || bay.ref;

  const btnJoin = document.getElementById('editorBtnJoinTaxiway');
  if (btnJoin) btnJoin.classList.add('active');

  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.add('crosshair-cursor');

  showEditorToast(`🔗 Click directly on any taxiway or ramp taxilane centerline to snap and weld ${bay.ref}'s path.`);

  snapClickListener = function(e) {
    if (!isSnappingToTaxiway) return;
    const clickLatLng = e.latlng;
    
    let closestCoord = null;
    let closestTaxiwayName = null;
    let minD = Infinity;

    const segments = Array.isArray(lastResult.taxiways) ? lastResult.taxiways : (lastResult.taxiways?.segments || []);
    segments.forEach(seg => {
      const coords = seg.coordinates || [];
      for (let i = 0; i < coords.length; i++) {
        const d = haversine(clickLatLng.lat, clickLatLng.lng, coords[i][0], coords[i][1]);
        if (d < minD) {
          minD = d;
          closestCoord = coords[i];
          closestTaxiwayName = seg.ref || seg.name || 'Taxiway';
        }
      }
    });

    if (closestCoord && minD < 120.0) {
      if (!bay.lead_in_coords || bay.lead_in_coords.length < 2) {
        bay.lead_in_coords = [[bay.lat, bay.lon], closestCoord];
      } else {
        bay.lead_in_coords[bay.lead_in_coords.length - 1] = closestCoord;
      }

      hasUnsavedChanges = true;
      showEditorToast(`🔗 Successfully snapped and welded ${bay.ref} to ${closestTaxiwayName}!`);
      saveEditorChanges(true);
      drawAirportTerminals(lastResult);
    } else {
      showEditorToast('⚠️ Click closer to a taxiway or taxilane centerline to weld.');
    }

    cancelJoinToTaxiway();
  };

  map.on('click', snapClickListener);
}
window.startJoinToTaxiway = startJoinToTaxiway;

function cancelJoinToTaxiway() {
  isSnappingToTaxiway = false;
  const banner = document.getElementById('snapInstructionBanner');
  if (banner) banner.classList.add('hidden');

  const btnJoin = document.getElementById('editorBtnJoinTaxiway');
  if (btnJoin) btnJoin.classList.remove('active');

  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.remove('crosshair-cursor');

  if (snapClickListener) {
    map.off('click', snapClickListener);
    snapClickListener = null;
  }
}
window.cancelJoinToTaxiway = cancelJoinToTaxiway;

function updateEditorToolbar() {
  const bar = document.getElementById('floatingEditorBar');
  if (!bar || !isEditMode) return;

  const infoEl = document.getElementById('editorInfoLabel');
  const refInput = document.getElementById('editorRefInput');
  const nameInput = document.getElementById('editorNameInput');
  const typeSelect = document.getElementById('editorTypeSelect');
  const btnClear = document.getElementById('editorBtnClearLeadIn');

  if (!lastResult || !lastResult.bays || !selectedBayRef) {
    if (infoEl) infoEl.textContent = 'Click any badge on map or choose from dropdown';
    return;
  }

  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay) {
    if (infoEl) infoEl.textContent = 'Click any badge on map or choose from dropdown';
    return;
  }

  if (refInput && document.activeElement !== refInput) refInput.value = bay.ref;
  if (nameInput && document.activeElement !== nameInput) nameInput.value = bay.name || ((bay.has_jetbridge ? 'Gate ' : 'Stand ') + bay.ref);
  if (typeSelect && document.activeElement !== typeSelect) typeSelect.value = bay.type || (bay.has_jetbridge ? 'gate' : 'stand');

  const hasLeadIn = bay.lead_in_coords && bay.lead_in_coords.length >= 2;
  if (infoEl) {
    infoEl.innerHTML = `Pos: ${bay.lat.toFixed(5)}, ${bay.lon.toFixed(5)} ${hasLeadIn ? '<span style="color:#facc15; font-weight:800;">[Path: ' + bay.lead_in_coords.length + ' pts]</span>' : '<span style="color:#94a3b8;">[Direct Connector]</span>'}`;
  }

  if (btnClear) {
    if (hasLeadIn) btnClear.classList.remove('disabled');
    else btnClear.classList.add('disabled');
  }
}

// ── Lead-In Tracer ────────────────────────────────────────────────────────────

let rubberBandLine = null;

function handleTraceButtonClick() {
  if (isTracingLeadIn) {
    finishTracingLeadIn();
  } else {
    startTracingLeadIn();
  }
}
window.handleTraceButtonClick = handleTraceButtonClick;

function startTracingLeadIn() {
  if (!lastResult || !lastResult.bays) {
    showEditorToast('⚠️ Load an airport first before tracing.');
    return;
  }

  if (!selectedBayRef && lastResult.bays.length > 0) {
    selectedBayRef = lastResult.bays[0].ref;
  }

  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay) {
    showEditorToast('⚠️ Please select a gate or stand first.');
    return;
  }

  cancelTracingLeadIn();
  cancelJoinToTaxiway();

  isTracingLeadIn = true;
  currentTraceCoords = [[bay.lat, bay.lon]];
  
  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.add('crosshair-cursor');

  const banner = document.getElementById('tracingInstructionBanner');
  const refSpan = document.getElementById('tracingBayRef');
  const countSpan = document.getElementById('tracingWaypointCount');
  if (banner) banner.classList.remove('hidden');
  if (refSpan) refSpan.textContent = bay.name || bay.ref;
  if (countSpan) countSpan.textContent = '(1 start point at ' + bay.ref + ')';

  const btnTrace = document.getElementById('editorBtnTraceLeadIn');
  const traceText = document.getElementById('traceBtnText');
  if (btnTrace) btnTrace.classList.add('active');
  if (traceText) traceText.textContent = 'Finish Trace';

  map.doubleClickZoom.disable();

  const startDot = L.circleMarker([bay.lat, bay.lon], {
    radius: 6,
    color: '#10b981',
    fillColor: '#34d399',
    fillOpacity: 1,
    weight: 2,
    interactive: false
  });
  editorLayerGroup.addLayer(startDot);
  traceDotLayers.push(startDot);

  map.on('click', handleTraceMapClick);
  map.on('mousemove', handleTraceMapMove);

  showEditorToast(`🎯 Tracing mode active for ${bay.ref}: Click along the yellow line to the taxiway.`);
}
window.startTracingLeadIn = startTracingLeadIn;

function handleTraceMapClick(e) {
  if (!isTracingLeadIn) return;
  const pt = [e.latlng.lat, e.latlng.lng];
  currentTraceCoords.push(pt);

  const countSpan = document.getElementById('tracingWaypointCount');
  if (countSpan) countSpan.textContent = `(${currentTraceCoords.length} points added)`;

  if (traceLineLayer) editorLayerGroup.removeLayer(traceLineLayer);
  traceLineLayer = L.polyline(currentTraceCoords, {
    color: '#facc15',
    weight: 4,
    opacity: 1,
    interactive: false
  });
  editorLayerGroup.addLayer(traceLineLayer);

  const dot = L.circleMarker(pt, {
    radius: 5,
    color: '#facc15',
    fillColor: '#ffffff',
    fillOpacity: 1,
    weight: 2,
    interactive: false
  });
  editorLayerGroup.addLayer(dot);
  traceDotLayers.push(dot);
}

function handleTraceMapMove(e) {
  if (!isTracingLeadIn || currentTraceCoords.length === 0) return;
  const lastPt = currentTraceCoords[currentTraceCoords.length - 1];
  
  if (rubberBandLine) editorLayerGroup.removeLayer(rubberBandLine);
  rubberBandLine = L.polyline([lastPt, [e.latlng.lat, e.latlng.lng]], {
    color: '#fde047',
    weight: 3,
    dashArray: '5, 5',
    opacity: 0.85,
    interactive: false
  });
  editorLayerGroup.addLayer(rubberBandLine);
}

function finishTracingLeadIn() {
  if (!isTracingLeadIn || !selectedBayRef || !lastResult || !lastResult.bays) return;
  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay) return;

  if (currentTraceCoords.length >= 2) {
    bay.lead_in_coords = currentTraceCoords;
    hasUnsavedChanges = true;
    showEditorToast(`✅ Saved line with ${currentTraceCoords.length} points for ${bay.ref}!`);
    saveEditorChanges(false);
  } else {
    showEditorToast('⚠️ Tracing requires at least 2 points. Click on the map to add points.');
  }

  cancelTracingLeadIn();
  drawAirportTerminals(lastResult);
}
window.finishTracingLeadIn = finishTracingLeadIn;

function cancelTracingLeadIn() {
  isTracingLeadIn = false;
  currentTraceCoords = [];
  if (traceLineLayer) editorLayerGroup.removeLayer(traceLineLayer);
  if (rubberBandLine) editorLayerGroup.removeLayer(rubberBandLine);
  traceDotLayers.forEach(d => editorLayerGroup.removeLayer(d));
  traceDotLayers = [];
  traceLineLayer = null;
  rubberBandLine = null;

  const mapContainer = document.getElementById('map');
  if (mapContainer) mapContainer.classList.remove('crosshair-cursor');

  const banner = document.getElementById('tracingInstructionBanner');
  if (banner) banner.classList.add('hidden');

  const btnTrace = document.getElementById('editorBtnTraceLeadIn');
  const traceText = document.getElementById('traceBtnText');
  if (btnTrace) btnTrace.classList.remove('active');
  if (traceText) traceText.textContent = 'Trace Path';

  map.off('click', handleTraceMapClick);
  map.off('mousemove', handleTraceMapMove);
  map.doubleClickZoom.enable();
}
window.cancelTracingLeadIn = cancelTracingLeadIn;

function clearLeadInPath() {
  if (!selectedBayRef || !lastResult || !lastResult.bays) return;
  const bay = lastResult.bays.find(b => b.ref === selectedBayRef);
  if (!bay) return;

  bay.lead_in_coords = null;
  hasUnsavedChanges = true;
  showEditorToast(`🔄 Reset lead-in path for ${bay.ref} to direct taxilane connector.`);
  saveEditorChanges(true);
  drawAirportTerminals(lastResult);
}
window.clearLeadInPath = clearLeadInPath;

function toggleAddSpotPanel(forceState) {
  const panel = document.getElementById('editorAddPanel');
  if (!panel) return;
  if (forceState !== undefined) {
    panel.classList.toggle('hidden', !forceState);
  } else {
    panel.classList.toggle('hidden');
  }
  if (!panel.classList.contains('hidden')) {
    const input = document.getElementById('newSpotRefInput');
    if (input) input.focus();
  }
}
window.toggleAddSpotPanel = toggleAddSpotPanel;

function confirmAddNewSpot() {
  if (!lastResult) {
    showEditorToast('⚠️ Load or click an airport first before adding spots.');
    return;
  }
  const input = document.getElementById('newSpotRefInput');
  const typeSelect = document.getElementById('newSpotTypeSelect');
  if (!input) return;

  const ref = input.value.trim().toUpperCase();
  if (!ref) {
    alert('Please enter a gate or stand number (e.g. 48B).');
    return;
  }

  const isGate = typeSelect ? typeSelect.value === 'gate' : true;
  const center = map.getCenter();

  if (!lastResult.bays) lastResult.bays = [];
  lastResult.bays = lastResult.bays.filter(b => b.ref !== ref);

  const newBay = {
    id: 'bay_' + ref,
    ref: ref,
    name: (isGate ? 'Gate ' : 'Stand ') + ref,
    type: isGate ? 'gate' : 'stand',
    has_jetbridge: isGate,
    lat: center.lat,
    lon: center.lng,
    jetbridge_lat: isGate ? center.lat : null,
    jetbridge_lon: isGate ? center.lng : null,
    heading: 0,
    max_wingspan_m: null,
    lead_in_coords: null
  };

  lastResult.bays.push(newBay);
  selectedBayRef = ref;
  hasUnsavedChanges = true;
  input.value = '';
  toggleAddSpotPanel(false);

  saveEditorChanges(true);
  drawAirportTerminals(lastResult);
  showEditorToast(`➕ Created ${newBay.name} at map center. Drag marker to correct parking spot.`);
}
window.confirmAddNewSpot = confirmAddNewSpot;

function deleteSelectedBay() {
  if (!selectedBayRef || !lastResult || !lastResult.bays) return;
  const ref = selectedBayRef;
  if (!confirm(`Are you sure you want to delete ${ref} from this airport?`)) return;

  lastResult.bays = lastResult.bays.filter(b => b.ref !== ref);
  selectedBayRef = lastResult.bays.length > 0 ? lastResult.bays[0].ref : null;
  hasUnsavedChanges = true;
  saveEditorChanges(true);
  drawAirportTerminals(lastResult);
  showEditorToast(`🗑️ Deleted ${ref} from airport layout.`);
}
window.deleteSelectedBay = deleteSelectedBay;

async function saveEditorChanges(isSilent = false) {
  if (isSilent && typeof isSilent === 'object') {
    isSilent = false;
  }

  if (!lastResult || !lastResult.bays) return;
  const icao = lastResult.airport?.icao || lastResult.active_runway?.airport_icao || currentIcao || 'KLGA';

  const saveBtn = document.getElementById('editorBtnSave');
  const saveIcon = document.getElementById('saveBtnIcon');
  const saveText = document.getElementById('saveBtnText');

  try {
    const res = await fetch('/api/terminals/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        icao: icao,
        bays: lastResult.bays
      })
    });

    const data = await res.json();
    if (data.success) {
      hasUnsavedChanges = false;
      
      if (saveBtn) {
        saveBtn.style.background = '#059669';
        if (saveIcon) saveIcon.textContent = '✅';
        if (saveText) saveText.textContent = 'Saved to Database!';
        setTimeout(() => {
          saveBtn.style.background = '';
          if (saveIcon) saveIcon.textContent = '💾';
          if (saveText) saveText.textContent = 'Save Changes to DB';
        }, 2200);
      }

      if (!isSilent) {
        showEditorToast(`💾 Saved ${data.count} parking positions & lead-in lines for ${icao} to database!`);
      }
    } else {
      if (!isSilent) alert('Failed to save to database: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    if (!isSilent) alert('Error saving to server: ' + err.message);
  }
}
window.saveEditorChanges = saveEditorChanges;

function showEditorToast(msg) {
  const toast = document.getElementById('editorToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}
window.showEditorToast = showEditorToast;

window.setTaxiDestination = function(gateOrStandRef) {
  const inputEl = document.getElementById('taxiRouteInput');
  if (inputEl) {
    let curr = inputEl.value.trim();
    if (curr) {
      if (!curr.endsWith(gateOrStandRef)) {
        inputEl.value = curr + ' ' + gateOrStandRef;
      }
    } else {
      inputEl.value = gateOrStandRef;
    }
    inputEl.focus();
  }
};

function locateGateOrStand(query) {
  if (!query || !query.trim() || !lastResult) return;
  const q = query.trim().toUpperCase().replace(/^(GATE|STAND|TWY|RWY)\\s*/i, '');
  const feedbackEl = document.getElementById('gateSearchFeedback');

  const gates = lastResult.gates || [];
  const stands = lastResult.stands || [];

  const foundGate = gates.find(g => g.ref.toUpperCase() === q || g.name.toUpperCase().includes(q));
  const foundStand = !foundGate ? stands.find(s => s.ref.toUpperCase() === q || s.name.toUpperCase().includes(q)) : null;

  const target = foundGate || foundStand;
  if (target) {
    // Ensure layer is turned on
    if (!showTerminals) {
      const toggleEl = document.getElementById('terminalToggle');
      if (toggleEl) {
        toggleEl.checked = true;
        toggleEl.dispatchEvent(new Event('change'));
      }
    }

    map.flyTo([target.lat, target.lon], 18, { duration: 1.0 });

    if (feedbackEl) {
      feedbackEl.textContent = `📍 Found ${foundGate ? 'Gate' : 'Stand'} ${target.ref} at ${target.lat.toFixed(4)}, ${target.lon.toFixed(4)}`;
      feedbackEl.style.color = 'var(--green)';
      feedbackEl.classList.remove('hidden');
    }
  } else {
    if (feedbackEl) {
      feedbackEl.textContent = `⚠️ No Gate/Stand matching "${query}" found at this airport.`;
      feedbackEl.style.color = '#ff4757';
      feedbackEl.classList.remove('hidden');
    }
  }
}

// ── Progressive Taxi Route Generator ──────────────────────────────────────────

let activeTaxiRoute = null;

async function generateTaxiRoute(routeStr) {
  if (!routeStr || !routeStr.trim()) return;
  const icao = lastResult?.airport?.icao || (lastResult?.active_runway?.airport_icao);
  if (!icao) {
    alert("Please click on an airport on the map or search an airport first!");
    return;
  }

  try {
    const res = await fetch("/api/taxi-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icao, route: routeStr })
    });
    const data = await res.json();
    if (data.error) {
      alert("Taxi Route: " + data.error);
      return;
    }

    activeTaxiRoute = data;
    renderTaxiRoute(data);
  } catch (err) {
    console.error("Taxi routing failed:", err);
  }
}

function clearTaxiRoute() {
  activeTaxiRoute = null;
  taxiRouteLayerGroup.clearLayers();
  const summaryEl = document.getElementById("taxiRouteSummary");
  if (summaryEl) {
    summaryEl.innerHTML = "";
    summaryEl.classList.add("hidden");
  }
  const inputEl = document.getElementById("taxiRouteInput");
  if (inputEl) inputEl.value = "";

  // Restore normal taxiways
  if (showTaxiways && lastResult?.taxiways) {
    drawTaxiways(lastResult.taxiways);
  }
}

function renderTaxiRoute(data) {
  taxiRouteLayerGroup.clearLayers();

  // Hide all other background taxiways to avoid clutter and confusion
  taxiwayLayerGroup.clearLayers();

  const { legs, path_coordinates, total_distance_ft, total_distance_m, est_time_sec, has_closures } = data;
  if (!path_coordinates || path_coordinates.length < 2) return;

  // 1. Draw continuous background route glow
  const routeGlow = L.polyline(path_coordinates, {
    color: has_closures ? "#ff4757" : "#00d4ff",
    weight: 9,
    opacity: 0.4,
    lineCap: "round",
    lineJoin: "round"
  });
  taxiRouteLayerGroup.addLayer(routeGlow);

  // 2. Draw continuous core route path
  const routeCore = L.polyline(path_coordinates, {
    color: has_closures ? "#ff4757" : "#00ff88",
    weight: 4.5,
    opacity: 1,
    lineCap: "round",
    lineJoin: "round"
  });
  taxiRouteLayerGroup.addLayer(routeCore);

  // 3. Render sequential step badges and mid-path labels along each leg
  legs.forEach((leg, idx) => {
    if (!leg.coordinates || leg.coordinates.length === 0) return;

    const isClosed = leg.is_closed;
    const startPt = leg.start_point || leg.coordinates[0];
    const midPt = leg.mid_point || leg.coordinates[Math.floor(leg.coordinates.length / 2)];
    const badgeText = leg.token.includes("RW") ? leg.token : "TWY " + leg.ref;

    // Step junction badge at start of this leg
    const stepBadgeHtml = isClosed
      ? `<div class="twy-map-badge closed" style="border:2px solid #fff;box-shadow:0 0 16px rgba(255,71,87,1);">⛔ ${leg.step}. ${badgeText} [CLSD]</div>`
      : `<div class="twy-map-badge" style="background:#00ff88;color:#0a0d14;border:2px solid #fff;font-weight:900;box-shadow:0 0 14px rgba(0,255,136,0.9);">${leg.step}. ${badgeText}</div>`;

    const stepMarker = L.marker(startPt, {
      icon: L.divIcon({
        className: "aviation-sign-icon",
        html: stepBadgeHtml,
        iconSize: null,
        iconAnchor: [0, 0]
      })
    });
    taxiRouteLayerGroup.addLayer(stepMarker);

    // Midpoint label along taxiway pavement (if leg is long enough)
    if (leg.distance_m > 30 && midPt) {
      const midLabelHtml = `<div class="twy-map-badge" style="background:rgba(10,13,20,0.85);color:#00ff88;border:1px solid #00ff88;font-size:10px;padding:1px 5px;box-shadow:0 2px 6px rgba(0,0,0,0.6);">TWY ${leg.ref}</div>`;
      const midMarker = L.marker(midPt, {
        icon: L.divIcon({
          className: "aviation-sign-icon",
          html: midLabelHtml,
          iconSize: null,
          iconAnchor: [0, 0]
        })
      });
      taxiRouteLayerGroup.addLayer(midMarker);
    }
  });

  // 4. Render Terminus / Destination Marker at the very end of the route
  const lastLeg = legs[legs.length - 1];
  const lastPoint = lastLeg?.end_point || path_coordinates[path_coordinates.length - 1];
  const endBadgeHtml = `<div class="rwy-map-badge" style="background:#00d4ff;color:#0a0d14;border:2px solid #fff;font-weight:900;box-shadow:0 0 16px rgba(0,212,255,0.9);">🏁 DESTINATION (TWY ${lastLeg?.ref || "END"})</div>`;
  const endMarker = L.marker(lastPoint, {
    icon: L.divIcon({
      className: "aviation-sign-icon",
      html: endBadgeHtml,
      iconSize: null,
      iconAnchor: [0, 0]
    })
  });
  taxiRouteLayerGroup.addLayer(endMarker);

  // Auto-fit bounds smoothly to view the entire clearance path
  try {
    const bounds = L.latLngBounds(path_coordinates);
    map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 17, duration: 0.8 });
  } catch (e) {}

  // 5. Update Sidebar Summary
  const summaryEl = document.getElementById("taxiRouteSummary");
  if (summaryEl) {
    summaryEl.classList.remove("hidden");

    const estMin = (est_time_sec / 60).toFixed(1);
    const closureNotice = has_closures
      ? `<div style="color:#ff4757;font-weight:700;font-size:10px;margin-top:2px;">⚠️ WARNING: Route crosses NOTAM closed taxiway!</div>`
      : "";

    const breadcrumbs = legs.map(l => {
      const col = l.is_closed ? "#ff4757" : "var(--accent)";
      return `<span style="color:${col};font-weight:700;font-family:var(--font-mono);">[${l.ref}]</span>`;
    }).join(" ➔ ");

    summaryEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:700;">Active Taxi Clearance</span>
        <span style="font-family:var(--font-mono);font-size:10.5px;color:var(--green);font-weight:700;">${fmt(total_distance_ft)} ft / ${fmt(total_distance_m)} m</span>
      </div>
      <div style="font-size:10.5px;color:var(--text-secondary);display:flex;justify-content:space-between;">
        <span>Est. Taxi Time:</span>
        <span style="font-family:var(--font-mono);color:var(--text-primary);font-weight:700;">~${estMin} min @ 15 kts</span>
      </div>
      <div style="margin-top:4px;padding:4px 6px;background:rgba(0,0,0,0.4);border-radius:3px;font-size:11px;">
        ${breadcrumbs}
      </div>
      ${closureNotice}
    `;
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

  // ── Terminals & Gates Toggle
  const termToggle = document.getElementById('terminalToggle');
  const termSubControls = document.getElementById('terminalSubControls');
  if (termToggle) {
    termToggle.checked = showTerminals;
    if (showTerminals && termSubControls) termSubControls.classList.remove('hidden');

    termToggle.addEventListener('change', async (e) => {
      showTerminals = e.target.checked;
      localStorage.setItem(SHOW_TERMINALS_KEY, showTerminals ? 'true' : 'false');
      if (showTerminals) {
        if (termSubControls) termSubControls.classList.remove('hidden');
        if (!map.hasLayer(gateLayerGroup)) map.addLayer(gateLayerGroup);
        if (!map.hasLayer(standLayerGroup)) map.addLayer(standLayerGroup);
        if (lastResult) {
          await drawAirportTerminals(lastResult);
        } else {
          const center = map.getCenter();
          await analyzePoint(center.lat, center.lng);
        }
      } else {
        if (termSubControls) termSubControls.classList.add('hidden');
        map.removeLayer(gateLayerGroup);
        map.removeLayer(standLayerGroup);
      }
    });
  }

  const btnBuildings = document.getElementById('btnToggleTerminalBuildings');
  if (btnBuildings) {
    btnBuildings.addEventListener('click', () => {
      showTerminalBuildings = !showTerminalBuildings;
      btnBuildings.classList.toggle('inactive', !showTerminalBuildings);
      if (lastResult) drawAirportTerminals(lastResult);
    });
  }

  const btnGates = document.getElementById('btnToggleGates');
  if (btnGates) {
    btnGates.addEventListener('click', () => {
      showGates = !showGates;
      btnGates.classList.toggle('inactive', !showGates);
      if (lastResult) drawAirportTerminals(lastResult);
    });
  }

  const btnStands = document.getElementById('btnToggleStands');
  if (btnStands) {
    btnStands.addEventListener('click', () => {
      showStands = !showStands;
      btnStands.classList.toggle('inactive', !showStands);
      if (lastResult) drawAirportTerminals(lastResult);
    });
  }

  const btnLocate = document.getElementById('btnLocateGate');
  const gateInput = document.getElementById('gateSearchInput');
  if (btnLocate && gateInput) {
    btnLocate.addEventListener('click', () => locateGateOrStand(gateInput.value));
    gateInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') locateGateOrStand(gateInput.value);
    });
  }

  // ── Visual Editor Controls
  const btnToggleEdit = document.getElementById('btnToggleEditMode');
  if (btnToggleEdit) {
    btnToggleEdit.addEventListener('click', () => toggleVisualEditorMode());
  }

  const btnQuickEdit = document.getElementById('btnQuickEdit');
  if (btnQuickEdit) {
    btnQuickEdit.addEventListener('click', () => toggleVisualEditorMode());
  }

  const baySelect = document.getElementById('editorBaySelect');
  if (baySelect) {
    baySelect.addEventListener('change', (e) => {
      selectBayForEditing(e.target.value);
    });
  }

  const btnApplyEdit = document.getElementById('editorBtnApplyEdit');
  if (btnApplyEdit) {
    btnApplyEdit.addEventListener('click', applyBayEdits);
  }

  const refInput = document.getElementById('editorRefInput');
  if (refInput) {
    refInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyBayEdits();
    });
  }

  const editorTraceBtn = document.getElementById('editorBtnTraceLeadIn');
  if (editorTraceBtn) {
    editorTraceBtn.addEventListener('click', () => {
      if (isTracingLeadIn) finishTracingLeadIn();
      else startTracingLeadIn();
    });
  }

  const editorFinishBtn = document.getElementById('btnFinishTracing');
  if (editorFinishBtn) {
    editorFinishBtn.addEventListener('click', finishTracingLeadIn);
  }

  const editorCancelBtn = document.getElementById('btnCancelTracing');
  if (editorCancelBtn) {
    editorCancelBtn.addEventListener('click', cancelTracingLeadIn);
  }

  const editorClearBtn = document.getElementById('editorBtnClearLeadIn');
  if (editorClearBtn) {
    editorClearBtn.addEventListener('click', clearLeadInPath);
  }

  const btnToggleAdd = document.getElementById('editorBtnToggleAddForm');
  if (btnToggleAdd) {
    btnToggleAdd.addEventListener('click', () => toggleAddSpotPanel());
  }

  const btnConfirmAdd = document.getElementById('btnConfirmAddSpot');
  if (btnConfirmAdd) {
    btnConfirmAdd.addEventListener('click', confirmAddNewSpot);
  }

  const newRefInput = document.getElementById('newSpotRefInput');
  if (newRefInput) {
    newRefInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmAddNewSpot();
    });
  }

  const btnCancelAdd = document.getElementById('btnCancelAddSpot');
  if (btnCancelAdd) {
    btnCancelAdd.addEventListener('click', () => toggleAddSpotPanel(false));
  }

  const editorDeleteBtn = document.getElementById('editorBtnDeleteBay');
  if (editorDeleteBtn) {
    editorDeleteBtn.addEventListener('click', deleteSelectedBay);
  }

  const editorSaveBtn = document.getElementById('editorBtnSave');
  if (editorSaveBtn) {
    editorSaveBtn.addEventListener('click', saveEditorChanges);
  }

  const editorExitBtn = document.getElementById('editorBtnExit');
  if (editorExitBtn) {
    editorExitBtn.addEventListener('click', () => toggleVisualEditorMode(false));
  }

  const twyToggle = document.getElementById('taxiwayToggle');
  if (twyToggle) {
    twyToggle.checked = showTaxiways;
    twyToggle.addEventListener('change', (e) => {
      showTaxiways = e.target.checked;
      localStorage.setItem(SHOW_TAXIWAYS_KEY, showTaxiways ? 'true' : 'false');
      if (showTaxiways) {
        map.addLayer(taxiwayLayerGroup);
        if (lastResult && lastResult.taxiways) {
          drawTaxiways(lastResult.taxiways);
        }
      } else {
        selectedTaxiwayRef = null;
        map.removeLayer(taxiwayLayerGroup);
      }
    });
  }
}

// ── Map Click ─────────────────────────────────────────────────────────────────

map.on('click', (e) => {
  // If currently tracing lead-in path or in edit mode, DO NOT trigger analyzePoint!
  if (isTracingLeadIn) {
    handleTraceMapClick(e);
    return;
  }
  if (isEditMode) {
    return;
  }

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
      const pLat = parseFloat(lat);
      const pLon = parseFloat(lon);
      selectedRunwayKey = null;
      selectedTaxiwayRef = null;
      map.flyTo([pLat, pLon], 16, { duration: 1.5 });
      analyzePoint(pLat, pLon);
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


  const btnRoute = document.getElementById('btnGenerateTaxiRoute');
  const btnClear = document.getElementById('btnClearTaxiRoute');
  const inputRoute = document.getElementById('taxiRouteInput');

  if (btnRoute && inputRoute) {
    btnRoute.addEventListener('click', () => {
      generateTaxiRoute(inputRoute.value);
    });
    inputRoute.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') generateTaxiRoute(inputRoute.value);
    });
  }

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      clearTaxiRoute();
    });
  }

initControls();
showLoading(false);

// Auto-analyze default airport on startup
analyzePoint(40.777, -73.872);

console.log('🛬 ICAO Runway Analyzer ready with Taxiway and Runway Isolation.');
