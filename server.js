
function destinationPoint(lat, lon, brngDeg, distM) {
    const R = 6371000;
    const brng = brngDeg * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(latRad) * Math.cos(distM / R) +
                           Math.cos(latRad) * Math.sin(distM / R) * Math.cos(brng));
    const lon2 = lonRad + Math.atan2(Math.sin(brng) * Math.sin(distM / R) * Math.cos(latRad),
                                     Math.cos(distM / R) - Math.sin(latRad) * Math.sin(lat2));
    return {
        latitude: lat2 * 180 / Math.PI,
        longitude: lon2 * 180 / Math.PI
    };
}

/**
 * server.js — ICAO Runway Tester API Server
 *
 * Full Multi-Source Operational Weather & ATIS Suite:
 * - Real-World FAA / Global D-ATIS
 * - VATSIM Network Global ATIS
 * - IVAO Network Global ATIS
 * - AviationWeather Live METAR
 *
 * Supports User-Configured Source Preference + Graceful Fallback
 */

const express = require('express');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3500;

// ── Load databases ───────────────────────────────────────────────────────────

const RUNWAY_DB_PATH = fs.existsSync(path.join(__dirname, 'data', 'runways-flat.json')) ? path.join(__dirname, 'data', 'runways-flat.json') : path.join(__dirname, '..', 'icao-runway-database', 'data', 'runways-flat.json');
const AIRPORT_DB_PATH = fs.existsSync(path.join(__dirname, 'data', 'airports.json')) ? path.join(__dirname, 'data', 'airports.json') : path.join(__dirname, '..', 'icao-airport-database', 'data', 'airports.json');

console.log('📦 Loading databases...');
let runwaysByIcao = {};   // { ICAO: [runway, ...] }
let airportsDb = {};

try {
    const flat = JSON.parse(fs.readFileSync(RUNWAY_DB_PATH, 'utf-8'));
    for (const rwy of flat) {
        if (!rwy.airport_icao) continue;
        // Filter out closed and decommissioned runways
        if (rwy.closed === true || rwy.closed === 1 || rwy.closed === '1' || rwy.closed === 'true') continue;
        if (rwy.surface && (rwy.surface.toLowerCase() === 'closed' || rwy.surface.toLowerCase() === 'clsd')) continue;
        const icao = rwy.airport_icao.toUpperCase().trim();
        if (!runwaysByIcao[icao]) runwaysByIcao[icao] = [];
        runwaysByIcao[icao].push(rwy);
    }
    console.log(`  ✅ Loaded ${flat.length.toLocaleString()} runways across ${Object.keys(runwaysByIcao).length.toLocaleString()} airports`);
} catch (e) {
    console.error('  ❌ Failed to load runway DB:', e.message);
    process.exit(1);
}

try {
    airportsDb = JSON.parse(fs.readFileSync(AIRPORT_DB_PATH, 'utf-8'));
    console.log(`  ✅ Loaded ${Object.keys(airportsDb).length.toLocaleString()} airports`);
} catch (e) {
    console.warn('  ⚠️  Airport DB not loaded:', e.message);
}

// ── Build spatial grid indexes ────────────────────────────────────────────────

const CELL_SIZE = 0.25;
const runwayGrid = {};
const airportGrid = {};

function cellKey(lat, lon) {
    return `${Math.floor(lat / CELL_SIZE)},${Math.floor(lon / CELL_SIZE)}`;
}

for (const [icao, runways] of Object.entries(runwaysByIcao)) {
    for (const rwy of runways) {
        const lat = rwy.le_latitude ?? rwy.he_latitude;
        const lon = rwy.le_longitude ?? rwy.he_longitude;
        if (lat === null || lon === null) continue;
        const key = cellKey(lat, lon);
        if (!runwayGrid[key]) runwayGrid[key] = [];
        runwayGrid[key].push(rwy);
    }
}

for (const [icao, apt] of Object.entries(airportsDb)) {
    if (apt.latitude === null || apt.longitude === null) continue;
    const key = cellKey(apt.latitude, apt.longitude);
    if (!airportGrid[key]) airportGrid[key] = [];
    airportGrid[key].push(apt);
}
console.log(`  ✅ Spatial grids built (Runways: ${Object.keys(runwayGrid).length.toLocaleString()} cells, Airports: ${Object.keys(airportGrid).length.toLocaleString()} cells)\n`);


// ── Airport Taxiway Engine with Local Caching & NOTAM Closure Mapping ────────

const TAXIWAY_CACHE_DIR = path.join(__dirname, 'data', 'taxiways-cache');
if (!fs.existsSync(TAXIWAY_CACHE_DIR)) {
    try { fs.mkdirSync(TAXIWAY_CACHE_DIR, { recursive: true }); } catch (e) {}
}


const TERMINALS_CACHE_DIR = path.join(__dirname, 'data', 'terminals-cache');
if (!fs.existsSync(TERMINALS_CACHE_DIR)) {
    try { fs.mkdirSync(TERMINALS_CACHE_DIR, { recursive: true }); } catch (e) {}
}
const TERMINALS_DB_PATH = path.join(__dirname, 'data', 'terminals.json');
const TAXIWAYS_DB_PATH = path.join(__dirname, 'data', 'taxiways.json');
const RUNWAYS_DB_PATH = path.join(__dirname, 'data', 'runways-flat.json');

let seedTerminals = {};
try {
    const termPath = path.join(__dirname, 'data', 'terminals.json');
    if (fs.existsSync(termPath)) {
        seedTerminals = JSON.parse(fs.readFileSync(termPath, 'utf8'));
        console.log(`  ✅ Loaded terminals seed database for ${Object.keys(seedTerminals).length} airports`);
    }
} catch (e) {
    console.warn('  ⚠️ Terminals seed database not loaded:', e.message);
}

let seedTaxiways = {};
try {
    const seedPath = fs.existsSync(path.join(__dirname, 'data', 'taxiways.json'))
        ? path.join(__dirname, 'data', 'taxiways.json')
        : path.join(__dirname, '..', 'icao-taxiway-database', 'data', 'taxiways.json');
    if (fs.existsSync(seedPath)) {
        seedTaxiways = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        console.log(`  ✅ Loaded taxiway seed database for ${Object.keys(seedTaxiways).length} airports`);
    }
} catch (e) {
    console.warn('  ⚠️ Taxiway seed database not loaded:', e.message);
}

const querystring = require('querystring');

function queryOverpassTaxiways(lat, lon) {
    const query = `[out:json][timeout:15];(way["aeroway"~"taxiway|taxilane"](around:3800,${lat},${lon}););out geom;`;
    const postData = querystring.stringify({ data: query });

    const endpoints = [
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
        'https://overpass-api.de/api/interpreter'
    ];

    return new Promise((resolve) => {
        let tried = 0;
        function tryNext() {
            if (tried >= endpoints.length) return resolve([]);
            const ep = endpoints[tried++];
            const urlObj = new URL(ep);

            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'MYTECHREVIEW/icao-taxiway-database'
                },
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const raw = JSON.parse(data);
                        if (raw && raw.elements && raw.elements.length > 0) {
                            const segments = [];
                            for (const elem of raw.elements) {
                                const tags = elem.tags || {};
                                const geom = elem.geometry || [];
                                if (!geom || geom.length < 2) continue;

                                const ref = tags.ref || tags.name || null;
                                let widthFt = 75;
                                if (tags.width) {
                                    const parsed = parseFloat(String(tags.width).replace('m', '').trim());
                                    if (!isNaN(parsed)) widthFt = Math.round(parsed * 3.28084);
                                }

                                segments.push({
                                    id: elem.id,
                                    ref: ref ? ref.toUpperCase() : null,
                                    name: ref ? `Taxiway ${ref.toUpperCase()}` : 'Taxiway',
                                    type: tags.aeroway || 'taxiway',
                                    surface: tags.surface || 'asphalt',
                                    width_ft: widthFt,
                                    width_m: Math.round(widthFt * 0.3048),
                                    coordinates: geom.map(n => [Number(n.lat.toFixed(6)), Number(n.lon.toFixed(6))])
                                });
                            }
                            return resolve(segments);
                        }
                    } catch (e) {}
                    tryNext();
                });
            });
            req.on('error', () => tryNext());
            req.on('timeout', () => { req.destroy(); tryNext(); });
            req.write(postData);
            req.end();
        }
        tryNext();
    });
}

async function getAirportTaxiways(icao, lat, lon) {
    if (!icao) return [];
    icao = icao.toUpperCase().trim();

    // 1. Check in-memory seed DB
    if (seedTaxiways[icao]) {
        if (Array.isArray(seedTaxiways[icao])) return seedTaxiways[icao];
        if (seedTaxiways[icao].segments) return seedTaxiways[icao].segments;
    }

    // 2. Check disk cache
    const cacheFile = path.join(TAXIWAY_CACHE_DIR, `${icao}.json`);
    if (fs.existsSync(cacheFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            const segs = Array.isArray(cached) ? cached : (cached.segments || []);
            if (segs && segs.length > 0) return segs;
        } catch (e) {}
    }

    // 3. Dynamic Overpass fetch
    if (lat === undefined || lon === undefined) {
        const apt = airportsDb[icao];
        if (apt) { lat = apt.latitude; lon = apt.longitude; }
    }
    if (lat === undefined || lon === undefined) return [];

    const segments = await queryOverpassTaxiways(lat, lon);
    if (segments.length > 0) {
        try {
            const taxiwayData = { icao, segments };
            seedTaxiways[icao] = taxiwayData;
            fs.writeFileSync(cacheFile, JSON.stringify(taxiwayData, null, 2), 'utf8');
        } catch (e) {}
    }
    return segments;
}


function queryOverpassTerminals(lat, lon) {
    const query = `[out:json][timeout:15];(way["aeroway"~"terminal|gate|parking_position|stand"](around:4000,${lat},${lon});node["aeroway"~"gate|parking_position|stand"](around:4000,${lat},${lon}););out geom;`;
    const postData = querystring.stringify({ data: query });

    const endpoints = [
        'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
        'https://overpass-api.de/api/interpreter'
    ];

    return new Promise((resolve) => {
        let tried = 0;
        function tryNext() {
            if (tried >= endpoints.length) return resolve({ terminals: [], gates: [], stands: [] });
            const ep = endpoints[tried++];
            const urlObj = new URL(ep);

            const req = https.request({
                hostname: urlObj.hostname,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(postData),
                    'User-Agent': 'MYTECHREVIEW/icao-terminal-database'
                },
                timeout: 8000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const raw = JSON.parse(data);
                        if (!raw || !raw.elements) return tryNext();

                        const terminals = [];
                        const gates = [];
                        const stands = [];

                        for (const el of raw.elements) {
                            const tags = el.tags || {};
                            const aw = tags.aeroway || '';

                            if (aw === 'terminal' || tags.building === 'terminal') {
                                let coords = [];
                                if (el.geometry) {
                                    coords = el.geometry.map(g => [Number(g.lat.toFixed(6)), Number(g.lon.toFixed(6))]);
                                } else if (el.lat && el.lon) {
                                    coords = [[Number(el.lat.toFixed(6)), Number(el.lon.toFixed(6))]];
                                }
                                if (coords.length > 0) {
                                    terminals.push({
                                        id: el.id,
                                        name: tags.name || (tags.ref ? `Terminal ${tags.ref}` : 'Terminal'),
                                        ref: tags.ref || (tags.name ? tags.name.replace(/^Terminal\s*/i, '') : null),
                                        building: tags.building || 'terminal',
                                        polygon: coords
                                    });
                                }
                            } else if (aw === 'gate') {
                                let lat = el.lat;
                                let lon = el.lon;
                                if (!lat && el.geometry && el.geometry.length > 0) {
                                    lat = el.geometry[0].lat;
                                    lon = el.geometry[0].lon;
                                }
                                if (lat && lon) {
                                    const rawRef = tags.ref || (tags.name && !/^[0-9]{5,}$/.test(tags.name) ? tags.name.replace(/^Gate\s*/i, '') : null);
                                    if (rawRef && !/^[0-9]{5,}$/.test(rawRef.trim())) {
                                        gates.push({
                                            id: el.id,
                                            ref: rawRef.toUpperCase().trim(),
                                            name: tags.name || `Gate ${rawRef.toUpperCase().trim()}`,
                                            lat: Number(lat.toFixed(6)),
                                            lon: Number(lon.toFixed(6))
                                        });
                                    }
                                }
                            } else if (aw === 'parking_position' || aw === 'stand') {
                                let lat = el.lat;
                                let lon = el.lon;
                                if (!lat && el.geometry && el.geometry.length > 0) {
                                    lat = el.geometry[0].lat;
                                    lon = el.geometry[0].lon;
                                }
                                if (lat && lon) {
                                    const rawRef = tags.ref || (tags.name && !/^[0-9]{5,}$/.test(tags.name) ? tags.name.replace(/^(Stand|Position)\s*/i, '') : null);
                                    if (rawRef && !/^[0-9]{5,}$/.test(rawRef.trim())) {
                                        stands.push({
                                            id: el.id,
                                            ref: rawRef.toUpperCase().trim(),
                                            name: tags.name || `Stand ${rawRef.toUpperCase().trim()}`,
                                            max_wingspan_m: tags.max_wingspan ? parseFloat(tags.max_wingspan) : null,
                                            lat: Number(lat.toFixed(6)),
                                            lon: Number(lon.toFixed(6))
                                        });
                                    }
                                }
                            }
                        }

                        return resolve({ terminals, gates, stands });
                    } catch (e) {
                        tryNext();
                    }
                });
            });
            req.on('error', () => tryNext());
            req.on('timeout', () => { req.destroy(); tryNext(); });
            req.write(postData);
            req.end();
        }
        tryNext();
    });
}

async function getAirportTerminals(icao, lat, lon) {
    if (!icao) return { terminals: [], gates: [], stands: [] };
    icao = icao.toUpperCase().trim();

    // 1. Check in-memory seed DB
    if (seedTerminals[icao]) {
        const item = seedTerminals[icao];
        if (!item.bays || item.bays.length === 0) {
            item.bays = mergeGatesAndStands(item.gates || [], item.stands || []);
        }
        return item;
    }

    // 2. Check disk cache
    const cacheFile = path.join(TERMINALS_CACHE_DIR, `${icao}.json`);
    if (fs.existsSync(cacheFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (!cached.hold_points && seedTerminals[icao]?.hold_points) {
                cached.hold_points = seedTerminals[icao].hold_points;
            }
            return cached;
        } catch (e) {}
    }

    // 3. Dynamic Overpass fetch
    if (lat === undefined || lon === undefined) {
        const apt = airportsDb[icao];
        if (apt) { lat = apt.latitude; lon = apt.longitude; }
    }
    if (lat === undefined || lon === undefined) return { terminals: [], gates: [], stands: [] };

    const data = await queryOverpassTerminals(lat, lon);
    const gList = data.gates || [];
    const sList = data.stands || [];
    const bays = data.bays || mergeGatesAndStands(gList, sList);

    const result = {
        icao,
        terminals: data.terminals || [],
        gates: gList,
        stands: sList,
        bays: bays
    };

    if (result.terminals.length > 0 || result.gates.length > 0 || result.stands.length > 0) {
        try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch (e) {}
    }
    return result;
}

// ── Geodesic Math ─────────────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6371000;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const FT_PER_M = 3.28084;
const M_PER_FT = 0.3048;

function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*RAD)*Math.cos(lat2*RAD)*Math.sin(dLon/2)**2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

function bearingTo(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * RAD;
    const y = Math.sin(dLon) * Math.cos(lat2 * RAD);
    const x = Math.cos(lat1*RAD)*Math.sin(lat2*RAD) - Math.sin(lat1*RAD)*Math.cos(lat2*RAD)*Math.cos(dLon);
    return ((Math.atan2(y, x) * DEG) + 360) % 360;
}

function crossTrack(lat1, lon1, lat2, lon2, pLat, pLon) {
    const d13   = haversine(lat1, lon1, pLat, pLon) / EARTH_RADIUS_M;
    const th13  = bearingTo(lat1, lon1, pLat, pLon) * RAD;
    const th12  = bearingTo(lat1, lon1, lat2, lon2) * RAD;
    return Math.asin(Math.sin(d13) * Math.sin(th13 - th12)) * EARTH_RADIUS_M;
}

function alongTrack(lat1, lon1, lat2, lon2, pLat, pLon) {
    const d13   = haversine(lat1, lon1, pLat, pLon) / EARTH_RADIUS_M;
    const th13  = bearingTo(lat1, lon1, pLat, pLon) * RAD;
    const th12  = bearingTo(lat1, lon1, lat2, lon2) * RAD;
    const xtd   = Math.asin(Math.sin(d13) * Math.sin(th13 - th12));
    return Math.acos(Math.cos(d13) / Math.cos(xtd)) * EARTH_RADIUS_M;
}

function touchdownZone(ft) {
    if (ft < 0)    return 'BEFORE_THRESHOLD';
    if (ft <= 1000) return 'TZ1';
    if (ft <= 2000) return 'TZ2';
    if (ft <= 3000) return 'TZ3';
    return 'BEYOND_TZ3';
}

function fetchJson(url, timeoutMs = 4000) {
    return new Promise((resolve) => {
        try {
            const req = https.get(url, {
                headers: { 'User-Agent': 'MYTECHREVIEW/icao-runway-tester', 'Accept': 'application/json' },
                timeout: timeoutMs
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return fetchJson(res.headers.location, timeoutMs).then(resolve);
                }
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
                });
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
        } catch (e) {
            resolve(null);
        }
    });
}

// ── ATIS Text Runway Parser ──────────────────────────────────────────────────

function parseAtisRunways(text) {
    let landing = [];
    let departing = [];
    if (!text) return { landing, departing };

    let clean = text
        .replace(/RUNWAY\s+ZERO\s+([0-9])/gi, 'RWY 0$1')
        .replace(/RUNWAY\s+ONE\s+([0-9])/gi, 'RWY 1$1')
        .replace(/RUNWAY\s+TWO\s+([0-9])/gi, 'RWY 2$1')
        .replace(/RUNWAY\s+THREE\s+([0-9])/gi, 'RWY 3$1')
        .replace(/LEFT/gi, 'L')
        .replace(/RIGHT/gi, 'R')
        .replace(/CENTER/gi, 'C');

    // 1. Dual arrivals & departures: "RUNWAY 01 FOR ARRIVALS AND DEPARTURES"
    const dualMatch = clean.match(/(?:RUNWAY|RWY|RY)\s*([0-9]{1,2}[LCR]?)\s*(?:FOR\s+)?(?:ARRIVALS?\s+AND\s+DEPARTURES?|DEPARTURES?\s+AND\s+ARRIVALS?)/i);
    if (dualMatch && dualMatch[1]) {
        landing.push(dualMatch[1].toUpperCase());
        departing.push(dualMatch[1].toUpperCase());
    }

    // 2. Landing / Approach / Arrival blocks
    const appMatch = clean.match(/(?:APPROACH(?:\s+IN\s+USE)?|APCH(?:\s+IN\s+USE)?|LND|LANDING|ARR|ARRIVAL(?:\s+RUNWAYS?)?|ARRIVALS?|EXPECT\s+(?:ILS|RNAV|VISUAL|GPS)?\s*APPROACH)\s+([^.]*?)(?=(?:DEP|DEPART|DEPG|DEPARTURE|DEPARTURES|NOTAMS?|READBACK|\.|$))/i);
    if (appMatch && appMatch[1]) {
        const rwys = appMatch[1].match(/\b(?:RWY|RY|RUNWAY)?\s*([0-9]{1,2}[LCR]?)\b/gi) || [];
        for (const m of rwys) {
            const num = m.replace(/^(?:RWY|RY|RUNWAY)\s*/i, '').trim().toUpperCase();
            if (/^[0-9]{1,2}[LCR]?$/.test(num)) landing.push(num);
        }
    }

    // 3. Departure blocks
    const depMatch = clean.match(/(?:DEP|DEPART|DEPG|DEPARTURE|DEPARTURES(?:\s+RUNWAYS?)?)\s+([^.]*?)(?=(?:ARR|APPROACH|APCH|LND|LANDING|NOTAMS?|READBACK|\.|$))/i);
    if (depMatch && depMatch[1]) {
        const rwys = depMatch[1].match(/\b(?:RWY|RY|RUNWAY)?\s*([0-9]{1,2}[LCR]?)\b/gi) || [];
        for (const m of rwys) {
            const num = m.replace(/^(?:RWY|RY|RUNWAY)\s*/i, '').trim().toUpperCase();
            if (/^[0-9]{1,2}[LCR]?$/.test(num)) departing.push(num);
        }
    }

    landing = [...new Set(landing)];
    departing = [...new Set(departing)];
    return { landing, departing };
}


function parseAtisAltimeter(text, icao) {
  if (!text) return null;
  const matchA = text.match(/(?:ALTIMETER|ALTM|A)\s*(\d{4})\b/i);
  const matchQ = text.match(/(?:QNH|Q)\s*(\d{4})\b/i);

  if (matchA) {
    const valInt = parseInt(matchA[1], 10);
    if (valInt >= 2700 && valInt <= 3200) {
      const altimInHg = Number((valInt / 100).toFixed(2));
      const altimHpa = Math.round(altimInHg * 33.863886666667);
      return {
        inhg: altimInHg,
        hpa: altimHpa,
        unit: 'inHg',
        display: `${altimInHg.toFixed(2)} inHg (${altimHpa} hPa)`
      };
    }
  }
  if (matchQ) {
    const altimHpa = parseInt(matchQ[1], 10);
    if (altimHpa >= 900 && altimHpa <= 1100) {
      const altimInHg = Number((altimHpa * 0.0295299830714).toFixed(2));
      return {
        inhg: altimInHg,
        hpa: altimHpa,
        unit: 'hPa',
        display: `${altimHpa} hPa (${altimInHg.toFixed(2)} inHg)`
      };
    }
  }
  return null;
}

function parseWindFromText(text) {
    if (!text) return { dir: null, speed: null, gust: null };
    const m = text.match(/\b([0-9]{3}|VRB)([0-9]{2,3})(?:G([0-9]{2,3}))?KT\b/i);
    if (m) {
        return {
            dir: m[1] === 'VRB' ? 'VRB' : Number(m[1]),
            speed: Number(m[2]),
            gust: m[3] ? Number(m[3]) : null
        };
    }
    return { dir: null, speed: null, gust: null };
}


// ── NOTAM & Runway Closure Parser ─────────────────────────────────────────────

function parseAirportNotams(atisText) {
    if (!atisText) return { closedRunways: [], notams: [] };
    
    const closedRunways = new Set();
    const notams = [];

    const notamIdx = atisText.indexOf('NOTAMS');
    const body = notamIdx !== -1 ? atisText.slice(notamIdx).replace(/^NOTAMS?\.?\s*/i, '') : atisText;
    if (!body) return { closedRunways: [], notams: [] };

    const sentences = body.split(/(?:\.{1,3}|;)\s+/);
    for (let s of sentences) {
        s = s.trim().replace(/^\.+/, '').trim();
        if (!s || s.length < 5) continue;

        let type = 'GENERAL';
        let isClosure = false;

        // Taxiway closures should not trigger runway closure
        if (/\b(?:TAXIWAY|TWY|APRON|RAMP)\b/i.test(s) && /\b(?:CLSD|CLOSED)\b/i.test(s)) {
            type = 'TAXIWAY_APRON';
        } 
        // Strict Runway Closure: 'RWY 04/22 CLSD', 'RWY 13 CLOSED', 'RUNWAY 22L OUT OF SERVICE'
        else if (/\b(?:RWY|RY|RUNWAY)\s*([0-9]{1,2}[LCR]?(?:\s*\/\s*[0-9]{1,2}[LCR]?)?)\s+(?:CLSD|CLOSED|UNUSABLE|OUT OF SERVICE)\b/i.test(s) ||
                 /\b(?:CLSD|CLOSED)\s+(?:RWY|RY|RUNWAY)\s*([0-9]{1,2}[LCR]?)\b/i.test(s)) {
            type = 'RUNWAY_CLOSURE';
            isClosure = true;

            const matches = s.match(/\b(?:RWY|RY|RUNWAY)\s*([0-9]{1,2}[LCR]?(?:\s*\/\s*[0-9]{1,2}[LCR]?)?)\s+(?:CLSD|CLOSED|UNUSABLE|OUT OF SERVICE)\b/gi) || [];
            for (const m of matches) {
                const sub = m.match(/\b([0-9]{1,2}[LCR]?(?:\s*\/\s*[0-9]{1,2}[LCR]?)?)\b/);
                if (sub && sub[1]) {
                    const idents = sub[1].split('/');
                    for (const id of idents) {
                        const clean = id.trim().toUpperCase().replace(/^0+/, '');
                        if (clean) closedRunways.add(clean);
                    }
                }
            }
        } else if (/\b(?:PAPI|VASI|ILS|ALS|LIGHTS|LIGHTING|REIL|GLIDESLOPE|LOC|OTS)\b/i.test(s)) {
            type = 'NAVAID_LIGHTING';
        } else if (/\b(?:TAXIWAY|TWY|APRON|RAMP)\b/i.test(s)) {
            type = 'TAXIWAY_APRON';
        } else if (/\b(?:LASER|BIRDS|WILDLIFE|CRANE|OBST|SWAP)\b/i.test(s)) {
            type = 'HAZARD';
        }

        notams.push({
            type,
            text: s,
            is_closure: isClosure
        });
    }

    return { closedRunways: Array.from(closedRunways), notams };
}

// ── Multi-Source Operational Intelligence Cache ───────────────────────────────

const multiSourceCache = {}; // ICAO -> { timestamp, sources }

async function fetchAllAirportSources(icao) {
    icao = (icao || '').toUpperCase().trim();
    if (!icao) return null;

    const now = Date.now();
    if (multiSourceCache[icao] && (now - multiSourceCache[icao].timestamp < 180000)) { // 3 min cache
        return multiSourceCache[icao].sources;
    }

    const sources = {
        icao,
        real_world: { available: false, type: 'real_world', title: 'Real World D-ATIS', code: null, text: null, landing_runways: [], departing_runways: [], wind_dir: null, wind_speed: null, wind_gust: null, altim_display: null },
        vatsim:     { available: false, type: 'vatsim', title: 'VATSIM Network ATIS', callsign: null, code: null, text: null, landing_runways: [], departing_runways: [], wind_dir: null, wind_speed: null, wind_gust: null, altim_display: null },
        ivao:       { available: false, type: 'ivao', title: 'IVAO Network ATIS', callsign: null, code: null, text: null, landing_runways: [], departing_runways: [], wind_dir: null, wind_speed: null, wind_gust: null, altim_display: null },
        metar:      { available: false, type: 'metar', title: 'Live METAR Observation', raw: null, wind_dir: null, wind_speed: null, wind_gust: null, temp: null, dew: null, qnh: null, altim_inhg: null, altim_hpa: null, altim_unit: 'inHg', altim_display: null, flight_category: null }
    };

    // 1. Real World FAA / D-ATIS
    try {
        const datis = await fetchJson(`https://datis.clowd.io/api/${icao}`);
        if (datis) {
            const list = Array.isArray(datis) ? datis : [datis];
            for (const item of list) {
                const text = item.datis || '';
                if (text) {
                    sources.real_world.available = true;
                    sources.real_world.text = text;
                    sources.real_world.code = item.code || (text.match(/INFO(?:RMATION)?\s+([A-Z])/i) || [])[1] || null;

                    const parsed = parseAtisRunways(text);
                    sources.real_world.landing_runways = parsed.landing;
                    sources.real_world.departing_runways = parsed.departing;

                    const w = parseWindFromText(text);
                    sources.real_world.wind_dir = w.dir;
                    sources.real_world.wind_speed = w.speed;
                    sources.real_world.wind_gust = w.gust;

                    const alt = parseAtisAltimeter(text, icao);
                    if (alt) sources.real_world.altim_display = alt.display;
                    break;
                }
            }
        }
    } catch (e) {}

    // 2. VATSIM Global ATIS
    try {
        const vdata = await fetchJson('https://data.vatsim.net/v3/vatsim-data.json');
        if (vdata && vdata.atis) {
            const vatAtis = vdata.atis.find(a => a.callsign && (a.callsign === `${icao}_ATIS` || a.callsign.startsWith(icao)));
            if (vatAtis) {
                const text = (vatAtis.text_atis || []).join(' ');
                sources.vatsim.available = true;
                sources.vatsim.callsign = vatAtis.callsign;
                sources.vatsim.text = text;
                sources.vatsim.code = vatAtis.atis_code || (text.match(/INFO(?:RMATION)?\s+([A-Z])/i) || [])[1] || null;

                const parsed = parseAtisRunways(text);
                sources.vatsim.landing_runways = parsed.landing;
                sources.vatsim.departing_runways = parsed.departing;

                const w = parseWindFromText(text);
                sources.vatsim.wind_dir = w.dir;
                sources.vatsim.wind_speed = w.speed;
                sources.vatsim.wind_gust = w.gust;

                const alt = parseAtisAltimeter(text, icao);
                if (alt) sources.vatsim.altim_display = alt.display;
            }
        }
    } catch (e) {}

    // 3. IVAO Global ATIS
    try {
        const ivaoData = await fetchJson('https://api.ivao.aero/v2/tracker/whazzup');
        if (ivaoData && ivaoData.clients && ivaoData.clients.atcs) {
            const ivaoAtis = ivaoData.clients.atcs.find(a => a.callsign && (a.callsign === `${icao}_ATIS` || a.callsign.startsWith(icao)));
            if (ivaoAtis && ivaoAtis.atis) {
                const text = (ivaoAtis.atis.lines || []).join(' ');
                sources.ivao.available = true;
                sources.ivao.callsign = ivaoAtis.callsign;
                sources.ivao.text = text;
                sources.ivao.code = (text.match(/INFO(?:RMATION)?\s+([A-Z])/i) || [])[1] || null;

                const parsed = parseAtisRunways(text);
                sources.ivao.landing_runways = parsed.landing;
                sources.ivao.departing_runways = parsed.departing;

                const w = parseWindFromText(text);
                sources.ivao.wind_dir = w.dir;
                sources.ivao.wind_speed = w.speed;
                sources.ivao.wind_gust = w.gust;

                const alt = parseAtisAltimeter(text, icao);
                if (alt) sources.ivao.altim_display = alt.display;
            }
        }
    } catch (e) {}

    // 4. Live METAR
    try {
        const metarData = await fetchJson(`https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`);
        if (metarData && Array.isArray(metarData) && metarData.length > 0) {
            const m0 = metarData[0];
            sources.metar.available = true;
            sources.metar.raw = m0.rawOb || null;
            sources.metar.wind_dir = m0.wdir !== undefined && m0.wdir !== 'VRB' ? Number(m0.wdir) : null;
            sources.metar.wind_speed = m0.wspd !== undefined ? Number(m0.wspd) : null;
            sources.metar.wind_gust = m0.wgst !== undefined ? Number(m0.wgst) : null;
            sources.metar.temp = m0.temp !== undefined ? Number(m0.temp) : null;
            sources.metar.dew = m0.dewp !== undefined ? Number(m0.dewp) : null;
            sources.metar.flight_category = m0.fltcat || null;

            // Accurate Altimeter parsing based on raw observation and geographical region
            let altimInHg = null;
            let altimHpa = null;
            let altimDisplay = null;
            let altimUnit = 'inHg';

            const rawText = m0.rawOb || '';
            const matchA = rawText.match(/\bA(\d{4})\b/);
            const matchQ = rawText.match(/\bQ(\d{4})\b/);

            if (matchA) {
                const valInt = parseInt(matchA[1], 10);
                altimInHg = Number((valInt / 100).toFixed(2));
                altimHpa = Math.round(altimInHg * 33.863886666667);
                altimUnit = 'inHg';
                altimDisplay = `${altimInHg.toFixed(2)} inHg (${altimHpa} hPa)`;
            } else if (matchQ) {
                altimHpa = parseInt(matchQ[1], 10);
                altimInHg = Number((altimHpa * 0.0295299830714).toFixed(2));
                altimUnit = 'hPa';
                altimDisplay = `${altimHpa} hPa (${altimInHg.toFixed(2)} inHg)`;
            } else if (m0.altim !== undefined) {
                const apiHpa = Number(m0.altim);
                altimHpa = Math.round(apiHpa);
                altimInHg = Number((apiHpa * 0.0295299830714).toFixed(2));

                const isNorthAmerica = /^(K|P|C|MM)/i.test(icao);
                if (isNorthAmerica) {
                    altimUnit = 'inHg';
                    altimDisplay = `${altimInHg.toFixed(2)} inHg (${altimHpa} hPa)`;
                } else {
                    altimUnit = 'hPa';
                    altimDisplay = `${altimHpa} hPa (${altimInHg.toFixed(2)} inHg)`;
                }
            }

            sources.metar.qnh = altimHpa;
            sources.metar.altim_inhg = altimInHg;
            sources.metar.altim_hpa = altimHpa;
            sources.metar.altim_unit = altimUnit;
            sources.metar.altim_display = altimDisplay;
        }
    } catch (e) {}

    multiSourceCache[icao] = { timestamp: now, sources };
    return sources;
}

// ── Resolve Active Operational Context based on User Preference ──────────────

function resolveActiveOperational(sources, userPref = 'real_world') {
    if (!sources) return null;

    const hierarchy = ['real_world', 'vatsim', 'ivao', 'metar'];
    let order = [userPref, ...hierarchy.filter(s => s !== userPref)];

    let activeSrc = null;
    for (const srcKey of order) {
        if (sources[srcKey] && sources[srcKey].available) {
            activeSrc = sources[srcKey];
            break;
        }
    }

    if (!activeSrc) {
        activeSrc = sources.metar;
    }

    const isAtis = activeSrc.type !== 'metar';
    let label = 'METAR';
    if (activeSrc.type === 'real_world') label = activeSrc.code ? `Real ATIS (Info ${activeSrc.code})` : 'Real ATIS';
    else if (activeSrc.type === 'vatsim') label = activeSrc.code ? `VATSIM ATIS (Info ${activeSrc.code})` : 'VATSIM ATIS';
    else if (activeSrc.type === 'ivao')   label = activeSrc.code ? `IVAO ATIS (Info ${activeSrc.code})` : 'IVAO ATIS';

    // Best wind fallback
    const windDir = activeSrc.wind_dir ?? sources.metar?.wind_dir ?? null;
    const windSpeed = activeSrc.wind_speed ?? sources.metar?.wind_speed ?? null;
    const windGust = activeSrc.wind_gust ?? sources.metar?.wind_gust ?? null;

    const notamResult = parseAirportNotams(activeSrc.text || sources.real_world?.text || sources.vatsim?.text || '');

    return {
        selected_preference: userPref,
        active_source_type: activeSrc.type,
        source: isAtis ? activeSrc.type : 'METAR',
        source_label: label,
        landing_runways: activeSrc.landing_runways || [],
        departing_runways: activeSrc.departing_runways || [],
        atis_code: activeSrc.code || null,
        atis_text: activeSrc.text || null,
        metar: sources.metar?.raw || null,
        wind_dir: windDir,
        wind_speed: windSpeed,
        wind_gust: windGust,
        closed_runways: notamResult.closedRunways,
        notams: notamResult.notams,
        all_sources: sources
    };
}

// ── Analyze Runway Landing Direction with Active Operational Context ──────────

function analyzeRunwayLanding(lat, lon, rwy, operationalCtx, airportElev) {
    const leLat = rwy.le_latitude, leLon = rwy.le_longitude;
    const heLat = rwy.he_latitude, heLon = rwy.he_longitude;
    if (leLat === null || heLat === null || leLon === null || heLon === null) return null;

    const totalLen_m = (rwy.length_ft || 0) * M_PER_FT;
    const halfWidth_m = ((rwy.width_ft || 45) * M_PER_FT) / 2 + 5;

    const endMetrics = {};
    for (const end of ['le', 'he']) {
        const lat1 = end === 'le' ? leLat : heLat;
        const lon1 = end === 'le' ? leLon : heLon;
        const lat2 = end === 'le' ? heLat : leLat;
        const lon2 = end === 'le' ? heLon : leLon;

        const xtd_m  = crossTrack(lat1, lon1, lat2, lon2, lat, lon);
        const atd_m  = alongTrack(lat1, lon1, lat2, lon2, lat, lon);
        const sign   = end === 'le' ? 1 : -1;
        const dev_m  = xtd_m * sign;

        const dt_m = (end === 'le'
            ? (rwy.le_displaced_threshold_ft || 0)
            : (rwy.he_displaced_threshold_ft || 0)) * M_PER_FT;

        const effectiveDist_m = atd_m - dt_m;
        const remaining_m     = Math.max(0, totalLen_m - atd_m);
        const onRunway = Math.abs(xtd_m) <= halfWidth_m && atd_m >= -10 && atd_m <= totalLen_m + 10;
        const nearRunway = Math.abs(xtd_m) <= (halfWidth_m + 60) && atd_m >= -60 && atd_m <= totalLen_m + 60;
        const pctUsed = totalLen_m > 0 ? (atd_m / totalLen_m) * 100 : 50;

        const runwayHeadingDeg = end === 'le'
            ? (rwy.centerline_bearing_deg || 0)
            : ((rwy.centerline_bearing_deg + 180) % 360);

        let headwindKt = null;
        let crosswindKt = null;
        if (operationalCtx && operationalCtx.wind_dir !== null && operationalCtx.wind_speed !== null && operationalCtx.wind_dir !== 'VRB') {
            const headingDiffRad = (operationalCtx.wind_dir - runwayHeadingDeg) * RAD;
            headwindKt = Math.round(operationalCtx.wind_speed * Math.cos(headingDiffRad) * 10) / 10;
            crosswindKt = Math.round(operationalCtx.wind_speed * Math.sin(headingDiffRad) * 10) / 10;
        }

        const elevFt = (end === 'le' ? rwy.le_elevation_ft : rwy.he_elevation_ft) ?? airportElev ?? null;

        endMetrics[end] = {
            end_code: end,
            runway_end_ident: end === 'le' ? rwy.le_ident : rwy.he_ident,
            runway_heading_deg: runwayHeadingDeg,
            on_runway: onRunway,
            near_runway: nearRunway,
            pct_runway_used: Math.round(pctUsed * 10) / 10,
            deviation_m: Math.round(dev_m * 100) / 100,
            deviation_ft: Math.round(dev_m * FT_PER_M * 10) / 10,
            side: Math.abs(dev_m) < 0.5 ? 'center' : dev_m < 0 ? 'left' : 'right',
            distance_from_threshold_m: Math.round(effectiveDist_m * 10) / 10,
            distance_from_threshold_ft: Math.round(effectiveDist_m * FT_PER_M * 10) / 10,
            remaining_m: Math.round(remaining_m * 10) / 10,
            remaining_ft: Math.round(remaining_m * FT_PER_M * 10) / 10,
            elevation_ft: elevFt,
            elevation_m: elevFt !== null ? Math.round(elevFt * 0.3048) : null,
            headwind_kt: headwindKt,
            crosswind_kt: crosswindKt,
            touchdown_zone: touchdownZone(effectiveDist_m * FT_PER_M),
            atd_m, xtd_m: Math.abs(xtd_m)
        };
    }

    // ── Direction Resolution Hierarchy ──────────────────────────────────────
    let chosenEnd = 'le';
    const leClean = (rwy.le_ident || '').toUpperCase().replace(/^0+/, '');
    const heClean = (rwy.he_ident || '').toUpperCase().replace(/^0+/, '');

    // 1. ATIS Landing Runway Check
    if (operationalCtx && operationalCtx.landing_runways.length > 0) {
        const atisRwys = operationalCtx.landing_runways.map(r => r.replace(/^0+/, ''));
        const leMatches = atisRwys.includes(leClean);
        const heMatches = atisRwys.includes(heClean);

        if (leMatches && !heMatches) {
            chosenEnd = 'le';
        } else if (heMatches && !leMatches) {
            chosenEnd = 'he';
        }
    }
    // 2. METAR Wind Headwind Check
    else if (operationalCtx && endMetrics.le.headwind_kt !== null) {
        const hwLe = endMetrics.le.headwind_kt;
        const hwHe = endMetrics.he.headwind_kt;
        if (hwLe - hwHe > 1.5) {
            chosenEnd = 'le';
        } else if (hwHe - hwLe > 1.5) {
            chosenEnd = 'he';
        }
    }

    // 3. 50% Length Threshold Distance Rule (Geometry Baseline)
    if (endMetrics[chosenEnd].pct_runway_used > 50.0) {
        chosenEnd = (chosenEnd === 'le') ? 'he' : 'le';
    }

    const chosenMetrics = endMetrics[chosenEnd];
    const leNum = (rwy.le_ident || '').toUpperCase().replace(/^0+/, '');
    const heNum = (rwy.he_ident || '').toUpperCase().replace(/^0+/, '');
    const isClosedNotam = operationalCtx && operationalCtx.closed_runways && 
        (operationalCtx.closed_runways.includes(leNum) || operationalCtx.closed_runways.includes(heNum));
    
    let closureReason = null;
    if (isClosedNotam && operationalCtx.notams) {
        const matching = operationalCtx.notams.find(n => n.is_closure);
        if (matching) closureReason = matching.text;
    }

    chosenMetrics.is_closed = !!isClosedNotam;
    chosenMetrics.closure_reason = closureReason;
    return chosenMetrics;
}

// ── Spatial Lookup Helpers ───────────────────────────────────────────────────

function findNearbyGridItems(grid, lat, lon, radiusDeg = 0.12) {
    const results = new Set();
    const minR = Math.floor((lat - radiusDeg) / CELL_SIZE);
    const maxR = Math.ceil( (lat + radiusDeg) / CELL_SIZE);
    const minC = Math.floor((lon - radiusDeg) / CELL_SIZE);
    const maxC = Math.ceil( (lon + radiusDeg) / CELL_SIZE);

    for (let r = minR; r <= maxR; r++) {
        for (let c = minC; c <= maxC; c++) {
            const key = `${r},${c}`;
            if (grid[key]) {
                for (const item of grid[key]) results.add(item);
            }
        }
    }
    return [...results];
}

// ── API Routes ────────────────────────────────────────────────────────────────

// ── Production / Dev mode ─────────────────────────────────────────────────────
const crypto = require('crypto');
const IS_PROD = process.env.NODE_ENV === 'production';
console.log('🌐 Running in ' + (IS_PROD ? 'PRODUCTION' : 'DEVELOPMENT') + ' mode');

// Serve index.html with APP_MODE injected so the frontend can gate UI.
app.get('/', (req, res) => {
    const htmlFile = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(htmlFile, 'utf8');
    html = html.replace('__APP_MODE__', IS_PROD ? 'production' : 'development');
    res.type('html').send(html);
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.use(express.json());

const DEFAULT_MB = Buffer.from('cGsuZXlKMUlqb2liWGwwWldOb2NtVjJhV1YzSWl3aVlTSTZJbU50YTNJM2JXTjVlVEJpTnpBelpuQjFkM3BuTm1WMWFXMGlmUS5lM1A2MG9ybF93U0NVYjUtMVJKR3pn', 'base64').toString('utf8');

// ── API Key Management — File-based key store ────────────────────────────────
const API_KEYS_PATH = path.join(__dirname, 'data', 'api-keys.json');
const MASTER_API_KEY = process.env.API_KEY || null; // legacy single-key fallback
const ADMIN_KEY = process.env.ADMIN_KEY || null;

function loadApiKeys() {
    try {
        if (!fs.existsSync(API_KEYS_PATH)) return { keys: [] };
        return JSON.parse(fs.readFileSync(API_KEYS_PATH, 'utf8'));
    } catch { return { keys: [] }; }
}

function saveApiKeys(db) {
    fs.writeFileSync(API_KEYS_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function generateApiKey() {
    return 'rwy_' + crypto.randomBytes(24).toString('hex');
}

function requireApiKey(req, res, next) {
    const provided = (req.headers['x-api-key'] || req.query.api_key || '').trim();

    // No keys configured at all = open access (dev convenience)
    if (!MASTER_API_KEY) {
        const db = loadApiKeys();
        if (!db.keys || db.keys.filter(k => k.enabled).length === 0) return next();
    }

    if (!provided) {
        return res.status(401).json({ error: 'Missing X-API-Key header.' });
    }

    // Check file-based key store first
    const db = loadApiKeys();
    const match = db.keys.find(k => k.enabled && k.key === provided);
    if (match) {
        match.last_used_at = new Date().toISOString();
        match.use_count = (match.use_count || 0) + 1;
        saveApiKeys(db);
        return next();
    }

    // Fall back to master env key
    if (MASTER_API_KEY && provided === MASTER_API_KEY) {
        return next();
    }

    return res.status(401).json({ error: 'Invalid or revoked API key.' });
}

// ── Admin panel middleware (Direct Open Access for Local Dev) ─────────────────
function requireAdminKey(req, res, next) {
    // If in production and ADMIN_KEY is explicitly configured, enforce it; otherwise allow direct open access
    if (IS_PROD && ADMIN_KEY) {
        const provided = req.headers['x-admin-key'] || req.query.admin_key;
        if (!provided || provided !== ADMIN_KEY) {
            const auth = req.headers['authorization'] || '';
            if (auth.startsWith('Basic ')) {
                const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
                const [, pass] = decoded.split(':');
                if (pass === ADMIN_KEY) return next();
            }
            res.set('WWW-Authenticate', 'Basic realm="Admin"');
            return res.status(401).json({ error: 'Admin authentication required in production.' });
        }
    }
    next();
}

// ── Dev-only guard ─────────────────────────────────────────────────────────────
function devOnly(req, res, next) {
    if (IS_PROD) return res.status(403).json({ error: 'This endpoint is disabled in production.' });
    next();
}

app.get('/api/terminals', async (req, res) => {
    const icao = (req.query.icao || '').toUpperCase().trim();
    if (!icao) return res.status(400).json({ error: 'icao is required' });
    const apt = airportsDb[icao];
    const data = await getAirportTerminals(icao, apt?.latitude, apt?.longitude);
    res.json({
        icao,
        terminals_count: data.terminals.length,
        gates_count: data.gates.length,
        stands_count: data.stands.length,
        ...data
    });
});

app.get('/api/taxiways', async (req, res) => {
    const icao = (req.query.icao || '').toUpperCase().trim();
    if (!icao) return res.status(400).json({ error: 'icao is required' });
    const taxiways = await getAirportTaxiways(icao);
    res.json({ icao, count: taxiways.length, taxiways });
});


// ── GET /api/airport-search — Instant Search across 85,917 Airports ─────────

app.get('/api/airport-search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const upperQ = q.toUpperCase();
  const lowerQ = q.toLowerCase();

  const exactMatches = [];
  const startsWithMatches = [];
  const containsMatches = [];

  for (const [icao, apt] of Object.entries(airportsDb)) {
    if (!apt.latitude || !apt.longitude) continue;

    const icaoMatch = icao === upperQ;
    const iataMatch = apt.iata && apt.iata.toUpperCase() === upperQ;

    if (icaoMatch || iataMatch) {
      exactMatches.push(apt);
      continue;
    }

    if (icao.startsWith(upperQ) || (apt.iata && apt.iata.toUpperCase().startsWith(upperQ))) {
      startsWithMatches.push(apt);
      continue;
    }

    const nameLower = (apt.name || '').toLowerCase();
    const cityLower = (apt.city || '').toLowerCase();

    if (nameLower.startsWith(lowerQ) || cityLower.startsWith(lowerQ)) {
      startsWithMatches.push(apt);
    } else if (nameLower.includes(lowerQ) || cityLower.includes(lowerQ)) {
      containsMatches.push(apt);
    }
  }

  function sortRank(a, b) {
    const weightA = a.type === 'large_airport' ? 3 : (a.type === 'medium_airport' ? 2 : 1);
    const weightB = b.type === 'large_airport' ? 3 : (b.type === 'medium_airport' ? 2 : 1);
    return weightB - weightA;
  }

  exactMatches.sort(sortRank);
  startsWithMatches.sort(sortRank);
  containsMatches.sort(sortRank);

  const combined = [...exactMatches, ...startsWithMatches, ...containsMatches].slice(0, 10);
  res.json(combined);
});

app.get('/api/config', (req, res) => {
    res.json({
        mapboxToken: process.env.MAPBOX_TOKEN || DEFAULT_MB
    });
});


/**
 * POST /api/analyze
 * Body: { lat, lon, preferredSource: 'real_world' | 'vatsim' | 'ivao' | 'metar' }
 */
app.post('/api/analyze', async (req, res) => {
    let { lat, lon, icao: explicitIcao, preferredSource } = req.body;

    if (explicitIcao && (!lat || !lon)) {
        const aptMatch = airportsDb[explicitIcao.toUpperCase().trim()];
        if (aptMatch && aptMatch.latitude && aptMatch.longitude) {
            lat = aptMatch.latitude;
            lon = aptMatch.longitude;
        }
    }

    if (typeof lat !== 'number' || typeof lon !== 'number') {
        return res.status(400).json({ error: 'lat and lon must be numbers' });
    }

    const candidateRunways = findNearbyGridItems(runwayGrid, lat, lon, 0.25);
    const candidateAirports = findNearbyGridItems(airportGrid, lat, lon, 0.30);

    // 1. Explicit ICAO or Direct Runway Pavement Check
    let selectedAirportIcao = null;

    if (explicitIcao && airportsDb[explicitIcao.toUpperCase().trim()]) {
        selectedAirportIcao = explicitIcao.toUpperCase().trim();
    } else {
        for (const rwy of candidateRunways) {
            if (rwy.surface === 'water') continue;
            const apt = airportsDb[rwy.airport_icao] || {};
            if (apt.type === 'seaplane_base' || apt.type === 'heliport') continue;

            const leLat = rwy.le_latitude, leLon = rwy.le_longitude;
            const heLat = rwy.he_latitude, heLon = rwy.he_longitude;
            if (leLat === null || heLat === null || leLon === null || heLon === null) continue;

            const totalLen_m = (rwy.length_ft || 0) * M_PER_FT;
            const halfWidth_m = ((rwy.width_ft || 45) * M_PER_FT) / 2 + 5;
            const xtd = Math.abs(crossTrack(leLat, leLon, heLat, heLon, lat, lon));
            const atd = alongTrack(leLat, leLon, heLat, heLon, lat, lon);

            if (xtd <= halfWidth_m && atd >= -10 && atd <= totalLen_m + 10) {
                selectedAirportIcao = rwy.airport_icao;
                break;
            }
        }
    }

    // 2. Airport Reference Distance Check (Extended to 25km radius for city/centroid pins)
    if (!selectedAirportIcao) {
        const scoredAirports = [];
        for (const apt of candidateAirports) {
            if (apt.latitude === null || apt.longitude === null) continue;
            const dist = haversine(lat, lon, apt.latitude, apt.longitude);
            if (dist > 25000) continue;

            let weight = 1.0;
            if (apt.type === 'large_airport') weight = 0.15;
            else if (apt.type === 'medium_airport') weight = 0.35;
            else if (apt.type === 'small_airport') weight = 0.8;
            else if (apt.type === 'seaplane_base') weight = 15.0;
            else if (apt.type === 'heliport') weight = 10.0;
            else if (apt.type === 'closed') weight = 20.0;

            scoredAirports.push({ icao: apt.icao, dist, weightedDist: dist * weight, apt });
        }
        scoredAirports.sort((a, b) => a.weightedDist - b.weightedDist);
        if (scoredAirports.length > 0) selectedAirportIcao = scoredAirports[0].icao;
    }

    const primaryAirport = selectedAirportIcao ? (airportsDb[selectedAirportIcao] || { icao: selectedAirportIcao }) : null;

    // 3. Fetch Multi-Source Operational Intelligence (Real ATIS + VATSIM + IVAO + METAR)
    const allSources = selectedAirportIcao ? await fetchAllAirportSources(selectedAirportIcao) : null;
    const operationalCtx = resolveActiveOperational(allSources, preferredSource || 'real_world');

    // 4. Process all runways of the selected airport
    const airportRunways = selectedAirportIcao ? (runwaysByIcao[selectedAirportIcao] || []) : [];
    const analyzedRunways = [];

    for (const rwy of airportRunways) {
        const result = analyzeRunwayLanding(lat, lon, rwy, operationalCtx, primaryAirport?.elevation_ft);
        if (!result) continue;

        const leLat = rwy.le_latitude, heLat = rwy.he_latitude;
        const midLat = (leLat + heLat) / 2;
        const midLon = (rwy.le_longitude + rwy.he_longitude) / 2;
        const dist = haversine(lat, lon, midLat, midLon);

        analyzedRunways.push({
            airport_icao: rwy.airport_icao,
            airport_name: primaryAirport?.name || rwy.airport_icao,
            le_ident: rwy.le_ident,
            he_ident: rwy.he_ident,
            length_ft: rwy.length_ft,
            length_m: rwy.length_m,
            width_ft: rwy.width_ft,
            width_m: rwy.width_ft ? Math.round(rwy.width_ft * 0.3048) : null,
            surface: rwy.surface,
            lighted: rwy.lighted,
            le_latitude: rwy.le_latitude,
            le_longitude: rwy.le_longitude,
            he_latitude: rwy.he_latitude,
            he_longitude: rwy.he_longitude,
            centerline_bearing_deg: rwy.centerline_bearing_deg,
            dist_to_midpoint_m: Math.round(dist),
            is_closed: result.is_closed,
            closure_reason: result.closure_reason,
            analysis: result
        });
    }

    // If no ATIS landing runway was explicitly listed, calculate preferred runways from METAR wind
    if (operationalCtx && operationalCtx.landing_runways.length === 0 && analyzedRunways.length > 0) {
        const sortedByWind = [...analyzedRunways].filter(r => r.analysis.headwind_kt !== null)
            .sort((a, b) => (b.analysis.headwind_kt ?? -999) - (a.analysis.headwind_kt ?? -999));
        if (sortedByWind.length > 0) {
            operationalCtx.landing_runways = [sortedByWind[0].analysis.runway_end_ident];
            operationalCtx.departing_runways = [sortedByWind[0].analysis.runway_end_ident];
        }
    }

    analyzedRunways.sort((a, b) => {
        if (a.analysis.on_runway !== b.analysis.on_runway)
            return a.analysis.on_runway ? -1 : 1;
        return a.dist_to_midpoint_m - b.dist_to_midpoint_m;
    });

    const onRunway = analyzedRunways.find(r => r.analysis.on_runway) || null;
    const isNearRunwayScope = analyzedRunways.some(r => r.analysis.near_runway || r.analysis.on_runway);
    const activeRunway = onRunway || (isNearRunwayScope ? analyzedRunways[0] : null);

    // 5. Fetch & Correlate Taxiways with NOTAMs
    const rawTaxiways = selectedAirportIcao ? await getAirportTaxiways(selectedAirportIcao, primaryAirport?.latitude, primaryAirport?.longitude) : [];
    const terminalData = selectedAirportIcao ? await getAirportTerminals(selectedAirportIcao, primaryAirport?.latitude, primaryAirport?.longitude) : { terminals: [], gates: [], stands: [] };
    
    // Extract closed taxiway designators from NOTAMs
    const closedTwyMap = new Map();
    if (operationalCtx && operationalCtx.notams) {
        for (const n of operationalCtx.notams) {
            if (/\b(?:TAXIWAY|TWY|APRON|RAMP)\b/i.test(n.text) && /\b(?:CLSD|CLOSED|UNUSABLE)\b/i.test(n.text)) {
                n.is_closure = true;
                const m = n.text.match(/\b(?:TAXIWAY|TWY)\s+([A-Z0-9]+(?:\s+[A-Z0-9]+)*)/i);
                if (m && m[1]) {
                    const parts = m[1].split(/\s+/);
                    for (const p of parts) {
                        const up = p.toUpperCase();
                        if (['CLOSED', 'CLSD', 'WEST', 'EAST', 'NORTH', 'SOUTH', 'OF', 'FOR', 'BETWEEN', 'AND'].includes(up)) break;
                        closedTwyMap.set(up, n.text);
                    }
                }
            }
        }
    }

    const analyzedTaxiways = rawTaxiways.map(twy => {
        let isClosed = false;
        let closureReason = null;
        if (twy.ref && closedTwyMap.has(twy.ref)) {
            isClosed = true;
            closureReason = closedTwyMap.get(twy.ref);
        }
        return {
            ...twy,
            is_closed: isClosed,
            closure_reason: closureReason
        };
    });

    let onTaxiway = false;
    let activeTaxiway = null;

    if (!onRunway && analyzedTaxiways.length > 0) {
        let closestDist = Infinity;
        let closestTwy = null;

        for (const twy of analyzedTaxiways) {
            const distM = distanceToPolylineM(lat, lon, twy.coordinates);
            const halfWidthM = (twy.width_m || 23) / 2 + 5;
            if (distM <= halfWidthM && distM < closestDist) {
                closestDist = distM;
                closestTwy = {
                    ...twy,
                    distance_to_centerline_m: Math.round(distM * 10) / 10,
                    distance_to_centerline_ft: Math.round(distM * FT_PER_M * 10) / 10
                };
            }
        }

        if (closestTwy) {
            onTaxiway = true;
            activeTaxiway = closestTwy;
        }
    }

    // Off-airfield detection (distance > 3.5km from airport reference and not on runway/taxiway)
    const distToAirportM = (primaryAirport?.latitude && primaryAirport?.longitude)
        ? haversine(lat, lon, primaryAirport.latitude, primaryAirport.longitude)
        : 99999;
    const isOffAirfield = !onRunway && !onTaxiway && !isNearRunwayScope && (distToAirportM > 3500);
    const distToAirportNm = Math.round((distToAirportM / 1852) * 10) / 10;

    res.json({
        lat, lon,
        is_off_airfield: isOffAirfield,
        distance_to_airport_m: Math.round(distToAirportM),
        distance_to_airport_nm: distToAirportNm,
        airport: primaryAirport ? {
            icao: selectedAirportIcao,
            iata: primaryAirport.iata || null,
            name: primaryAirport.name || selectedAirportIcao,
            city: primaryAirport.city || null,
            country: primaryAirport.country || null,
            country_name: primaryAirport.country_name || null,
            elevation_ft: primaryAirport.elevation_ft || null,
            elevation_m: primaryAirport.elevation_ft ? Math.round(primaryAirport.elevation_ft * 0.3048) : null,
            latitude: primaryAirport.latitude || null,
            longitude: primaryAirport.longitude || null,
            type: primaryAirport.type || null
        } : null,
        operational: operationalCtx,
        on_runway: !!onRunway,
        within_runway_scope: isNearRunwayScope,
        active_runway: activeRunway,
        on_taxiway: onTaxiway,
        active_taxiway: activeTaxiway,
        taxiways: analyzedTaxiways,
        terminals: terminalData.terminals || [],
        gates: terminalData.gates || [],
        stands: terminalData.stands || [],
        bays: terminalData.bays || mergeGatesAndStands(terminalData.gates || [], terminalData.stands || []),
        hold_points: terminalData.hold_points || seedTerminals[selectedAirportIcao]?.hold_points || [],
        runways: analyzedRunways
    });
});



function calculateBearing(lat1, lon1, lat2, lon2) {
  const RAD = Math.PI / 180;
  const phi1 = lat1 * RAD, phi2 = lat2 * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function mergeGatesAndStands(gates = [], stands = []) {
  const bays = [];
  const usedStands = new Set();
  const usedRefs = new Map();

  // 1. Process Gates
  (gates || []).forEach(g => {
    if (!g.lat || !g.lon || !g.ref) return;
    const cleanRef = g.ref.toUpperCase().trim();

    // Match only stands sharing the same base reference (e.g. 48 with 48, 48A with 48A)
    let match = (stands || []).find(s => s.ref && s.ref.toUpperCase().trim() === cleanRef && !usedStands.has(s.id));
    if (!match) {
      match = (stands || []).find(s => {
        if (!s.ref || usedStands.has(s.id) || !s.lat || !s.lon) return false;
        const sRef = s.ref.toUpperCase().trim();
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

  // 2. Process Remaining Stands (e.g. 48A, 48R, remote apron stands)
  (stands || []).forEach(s => {
    if (!s.lat || !s.lon || !s.ref || usedStands.has(s.id)) return;
    const cleanRef = s.ref.toUpperCase().trim();
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



// ── POST /api/taxiways/save — Persist Renamed & Calibrated Taxiway Labels ───────

app.post('/api/taxiways/save', devOnly, (req, res) => {
  try {
    const { icao, segments } = req.body;
    if (!icao) {
      return res.status(400).json({ error: 'icao is required' });
    }

    const upperIcao = icao.toUpperCase().trim();
    const cleanSegments = Array.isArray(segments) ? segments : [];

    const taxiwayData = {
      icao: upperIcao,
      segments: cleanSegments
    };

    // 1. Update in-memory seed DB
    seedTaxiways[upperIcao] = taxiwayData;

    // 2. Persist to data/taxiways.json on disk
    let allDb = {};
    if (fs.existsSync(TAXIWAYS_DB_PATH)) {
      try {
        allDb = JSON.parse(fs.readFileSync(TAXIWAYS_DB_PATH, 'utf8'));
      } catch (e) {
        allDb = {};
      }
    }
    allDb[upperIcao] = taxiwayData;
    fs.writeFileSync(TAXIWAYS_DB_PATH, JSON.stringify(allDb, null, 2), 'utf8');

    // 3. Persist to disk cache
    try {
      const cacheFile = path.join(TAXIWAY_CACHE_DIR, `${upperIcao}.json`);
      fs.writeFileSync(cacheFile, JSON.stringify(taxiwayData, null, 2), 'utf8');
    } catch (e) {}

    console.log(`💾 [TAXIWAY PERSISTENCE] Successfully saved ${cleanSegments.length} taxiway segments for ${upperIcao} to data/taxiways.json`);

    return res.json({
      success: true,
      icao: upperIcao,
      count: cleanSegments.length,
      segments: cleanSegments
    });
  } catch (err) {
    console.error('Error saving taxiways:', err);
    res.status(500).json({ error: err.message });
  }
});


// ── POST /api/runways/save — Persist Calibrated Runway Heading & Positions ─────

app.post('/api/runways/save', devOnly, (req, res) => {
  try {
    const { icao, runways } = req.body;
    if (!icao || !Array.isArray(runways)) {
      return res.status(400).json({ error: 'icao and runways array required' });
    }

    const upperIcao = icao.toUpperCase().trim();
    
    // 1. Update in-memory runwaysByIcao
    if (!runwaysByIcao[upperIcao]) {
      runwaysByIcao[upperIcao] = [];
    }
    const existingList = runwaysByIcao[upperIcao];
    
    runways.forEach(r => {
      const match = existingList.find(ex => 
        (r.id && ex.id === r.id) || 
        (ex.le_ident === r.le_ident && ex.he_ident === r.he_ident) ||
        (normalizeIdent(ex.le_ident) === normalizeIdent(r.le_ident) && normalizeIdent(ex.he_ident) === normalizeIdent(r.he_ident)) ||
        (normalizeIdent(ex.le_ident) === normalizeIdent(r.he_ident) && normalizeIdent(ex.he_ident) === normalizeIdent(r.le_ident))
      );
      if (match) {
        if (r.le_latitude !== undefined) match.le_latitude = r.le_latitude;
        if (r.le_longitude !== undefined) match.le_longitude = r.le_longitude;
        if (r.he_latitude !== undefined) match.he_latitude = r.he_latitude;
        if (r.he_longitude !== undefined) match.he_longitude = r.he_longitude;
        if (r.latitude_deg !== undefined) match.latitude_deg = r.latitude_deg;
        if (r.longitude_deg !== undefined) match.longitude_deg = r.longitude_deg;
        if (r.he_heading_degT !== undefined) match.he_heading_degT = r.he_heading_degT;
        if (r.le_heading_degT !== undefined) match.le_heading_degT = r.le_heading_degT;
        if (r.centerline_bearing_deg !== undefined) match.centerline_bearing_deg = r.centerline_bearing_deg;
        if (r.length_ft !== undefined) match.length_ft = r.length_ft;
        if (r.width_ft !== undefined) match.width_ft = r.width_ft;
      } else {
        existingList.push({
          airport_icao: upperIcao,
          le_ident: r.le_ident,
          he_ident: r.he_ident,
          le_latitude: r.le_latitude,
          le_longitude: r.le_longitude,
          he_latitude: r.he_latitude,
          he_longitude: r.he_longitude,
          centerline_bearing_deg: r.centerline_bearing_deg,
          length_ft: r.length_ft,
          width_ft: r.width_ft,
          latitude_deg: (r.le_latitude && r.he_latitude) ? (r.le_latitude + r.he_latitude) / 2 : undefined,
          longitude_deg: (r.le_longitude && r.he_longitude) ? (r.le_longitude + r.he_longitude) / 2 : undefined
        });
      }
    });

    // 2. Persist to data/runways-flat.json
    if (fs.existsSync(RUNWAY_DB_PATH)) {
      try {
        const allRunways = [];
        for (const list of Object.values(runwaysByIcao)) {
          allRunways.push(...list);
        }
        fs.writeFileSync(RUNWAY_DB_PATH, JSON.stringify(allRunways, null, 2), 'utf8');
      } catch (e) {
        console.warn('Could not write full RUNWAY_DB_PATH', e);
      }
    }

    console.log(`💾 [RUNWAYS PERSISTENCE] Saved ${runways.length} calibrated runways for ${upperIcao} to disk`);

    return res.json({
      success: true,
      icao: upperIcao,
      count: runways.length
    });
  } catch (err) {
    console.error('Error saving runways:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/holdpoints/save — Persist Labeled Holding Position Symbols ────────

app.post('/api/holdpoints/save', devOnly, (req, res) => {
  try {
    const { icao, hold_points } = req.body;
    if (!icao) {
      return res.status(400).json({ error: 'icao is required' });
    }

    const upperIcao = icao.toUpperCase().trim();
    const cleanHoldPoints = Array.isArray(hold_points) ? hold_points : [];

    if (!seedTerminals[upperIcao]) {
      seedTerminals[upperIcao] = { icao: upperIcao, terminals: [], gates: [], stands: [], bays: [] };
    }
    seedTerminals[upperIcao].hold_points = cleanHoldPoints;

    // Persist to data/terminals.json on disk
    let allDb = {};
    if (fs.existsSync(TERMINALS_DB_PATH)) {
      try { allDb = JSON.parse(fs.readFileSync(TERMINALS_DB_PATH, 'utf8')); } catch (e) { allDb = {}; }
    }
    if (!allDb[upperIcao]) allDb[upperIcao] = seedTerminals[upperIcao];
    allDb[upperIcao].hold_points = cleanHoldPoints;
    fs.writeFileSync(TERMINALS_DB_PATH, JSON.stringify(allDb, null, 2), 'utf8');

    // 2. Persist to disk cache
    try {
      const cacheFile = path.join(TERMINALS_CACHE_DIR, `${upperIcao}.json`);
      let cacheData = {};
      if (fs.existsSync(cacheFile)) {
        try { cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cacheData = {}; }
      }
      cacheData.icao = upperIcao;
      cacheData.hold_points = cleanHoldPoints;
      fs.writeFileSync(cacheFile, JSON.stringify(cacheData, null, 2), 'utf8');
    } catch (e) {}

    console.log(`💾 [HOLD POINTS PERSISTENCE] Saved ${cleanHoldPoints.length} hold short spots for ${upperIcao} to data/terminals.json & cache`);

    return res.json({
      success: true,
      icao: upperIcao,
      count: cleanHoldPoints.length,
      hold_points: cleanHoldPoints
    });
  } catch (err) {
    console.error('Error saving hold points:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/terminals/save — Persist Calibrated Gates, Stands & Lead-In Paths ─

app.post('/api/terminals/save', devOnly, (req, res) => {
  try {
    const { icao, bays, terminals } = req.body;
    if (!icao) {
      return res.status(400).json({ error: 'icao is required' });
    }

    const upperIcao = icao.toUpperCase().trim();
    const cleanBays = Array.isArray(bays) ? bays : [];

    // Derive synchronized gates and stands directly from cleanBays
    const cleanGates = [];
    const cleanStands = [];

    cleanBays.forEach((b, idx) => {
      if (!b.ref || !b.lat || !b.lon) return;
      const refStr = String(b.ref).toUpperCase().trim();
      const isGate = b.type === 'gate' || b.has_jetbridge;
      
      if (isGate) {
        cleanGates.push({
          id: b.gate_id || parseInt('610' + String(idx).padStart(5, '0')),
          ref: refStr,
          name: b.name || ('Gate ' + refStr),
          lat: b.jetbridge_lat || b.lat,
          lon: b.jetbridge_lon || b.lon,
          lead_in_coords: b.lead_in_coords || null
        });
        cleanStands.push({
          id: b.stand_id || parseInt('100' + String(idx).padStart(5, '0')),
          ref: refStr,
          name: 'Stand ' + refStr,
          max_wingspan_m: b.max_wingspan_m || null,
          lat: b.lat,
          lon: b.lon,
          lead_in_coords: b.lead_in_coords || null
        });
      } else {
        cleanStands.push({
          id: b.stand_id || parseInt('100' + String(idx).padStart(5, '0')),
          ref: refStr,
          name: 'Stand ' + refStr,
          max_wingspan_m: b.max_wingspan_m || null,
          lat: b.lat,
          lon: b.lon,
          lead_in_coords: b.lead_in_coords || null
        });
      }
    });

    const airportData = {
      icao: upperIcao,
      terminals: Array.isArray(terminals) ? terminals : (seedTerminals[upperIcao]?.terminals || []),
      gates: cleanGates,
      stands: cleanStands,
      bays: cleanBays,
      hold_points: req.body.hold_points || seedTerminals[upperIcao]?.hold_points || []
    };

    // 1. Update in-memory seed DB
    seedTerminals[upperIcao] = airportData;

    // 2. Persist to data/terminals.json on disk
    let allDb = {};
    if (fs.existsSync(TERMINALS_DB_PATH)) {
      try {
        allDb = JSON.parse(fs.readFileSync(TERMINALS_DB_PATH, 'utf8'));
      } catch (e) {
        allDb = {};
      }
    }
    allDb[upperIcao] = airportData;
    fs.writeFileSync(TERMINALS_DB_PATH, JSON.stringify(allDb, null, 2), 'utf8');

    // 3. Persist to disk cache
    try {
      const cacheFile = path.join(TERMINALS_CACHE_DIR, `${upperIcao}.json`);
      fs.writeFileSync(cacheFile, JSON.stringify(airportData, null, 2), 'utf8');
    } catch (e) {}

    console.log(`💾 [DISK PERSISTENCE] Successfully wrote ${cleanBays.length} parking positions & lead-in curves for ${upperIcao} to data/terminals.json`);

    return res.json({
      success: true,
      icao: upperIcao,
      count: cleanBays.length,
      bays: cleanBays
    });
  } catch (err) {
    console.error('Error saving terminals:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/taxi-route — Progressive Taxi Routing API ───────────────────────

function normalizeIdent(str) {
  if (!str) return "";
  return str.toUpperCase().trim().replace(/^(RWY|RUNWAY|RW|TWY|TAXIWAY|GATE|GT|STAND|ST|SPOT)s*/i, "").replace(/^0+/, "");
}

function getTurnAngleDeg(p1, p2, p3) {
  if (!p1 || !p2 || !p3) return 0;
  const b1 = calculateBearing(p1[0], p1[1], p2[0], p2[1]);
  const b2 = calculateBearing(p2[0], p2[1], p3[0], p3[1]);
  let diff = Math.abs(b2 - b1);
  if (diff > 180) diff = 360 - diff;
  return diff;
}

function parseToken(s, idx, totalTokens, runwayIdents, bayRefs) {
  let raw = s.toUpperCase().trim();
  let clean = normalizeIdent(raw);
  let type = "TWY";
  let display = raw;

  if (/^(RWY|RUNWAY|RW)/i.test(raw) || (idx === 0 && runwayIdents && runwayIdents.has(clean))) {
    type = "RWY";
    display = "RW" + (clean.length === 1 ? "0" + clean : clean);
  } else if (/^(GATE|GT|GTE)/i.test(raw)) {
    type = "GATE";
    clean = raw.replace(/^(GATE|GT|GTE)s*/i, "").toUpperCase().trim();
    display = "GATE " + clean;
  } else if (/^(STAND|ST|STD|STN|STANCE|SPOT)/i.test(raw)) {
    type = "STAND";
    clean = raw.replace(/^(STAND|ST|STD|STN|STANCE|SPOT)s*/i, "").toUpperCase().trim();
    display = "STAND " + clean;
  } else if (/^(LANE|LN|TL|TAXILANE)/i.test(raw)) {
    type = "LANE";
    clean = raw.replace(/^(LANE|LN|TL|TAXILANE)s*/i, "").toUpperCase().trim();
    display = "LANE " + clean;
  } else if (bayRefs && (bayRefs.has(raw) || bayRefs.has(clean))) {
    const matchRef = bayRefs.has(raw) ? raw : clean;
    type = "GATE";
    clean = matchRef;
    display = "SPOT " + matchRef;
  } else if (idx === totalTokens - 1 && idx > 0 && bayRefs && bayRefs.size > 0) {
    for (const ref of bayRefs) {
      if (ref === raw || ref === clean || normalizeIdent(ref) === clean) {
        type = "GATE";
        clean = ref;
        display = "SPOT " + ref;
        break;
      }
    }
  }

  return { raw, clean, type, display };
}

class TaxiwayGraph {
  constructor(taxiways, runways, gates = [], stands = [], bays = []) {
    this.nodes = [];
    this.adj = new Map();
    this.bayNodeMap = new Map();
    this.bayJunctionMap = new Map();
    this.bayRefs = new Set();
    this.runwayIdents = new Set();

    (runways || []).forEach(r => {
      if (r.le_ident) this.runwayIdents.add(normalizeIdent(r.le_ident));
      if (r.he_ident) this.runwayIdents.add(normalizeIdent(r.he_ident));
    });

    const unifiedBays = (gates || []).concat(stands || []).concat(bays || []);
    (unifiedBays || []).forEach(b => {
      if (b.ref) {
        this.bayRefs.add(b.ref.toUpperCase().trim());
        this.bayRefs.add(normalizeIdent(b.ref));
      }
    });

    this.init(taxiways, runways, unifiedBays);
  }

  addNode(lat, lon, mergeThresholdM = 0.5) {
    for (let i = 0; i < this.nodes.length; i++) {
      if (haversine(lat, lon, this.nodes[i][0], this.nodes[i][1]) <= mergeThresholdM) {
        return i;
      }
    }
    const id = this.nodes.length;
    this.nodes.push([lat, lon]);
    this.adj.set(id, []);
    return id;
  }

  addEdge(u, v, ref, isRwy, weight, coords, isConnector = false) {
    if (u === v) return;
    this.adj.get(u).push({ to: v, ref, isRwy, weight, coords, isConnector });
    this.adj.get(v).push({ to: u, ref, isRwy, weight, coords: [...coords].reverse(), isConnector });
  }

  init(taxiways, runways, bays) {
    const endpoints = [];

    // Pre-insert all gate lead-in vertices so taxiway segments can snap to them
    const leadInPts = [];
    (bays || []).forEach(bay => {
      if (bay.lead_in_coords && Array.isArray(bay.lead_in_coords)) {
        bay.lead_in_coords.forEach(p => leadInPts.push(p));
      }
    });

    // 1. Add taxiway segments with intermediate vertex interpolation
    (taxiways || []).forEach(seg => {
      const ref = normalizeIdent(seg.ref) || "TWY";
      let coords = [...(seg.coordinates || [])];
      if (coords.length < 2) return;

      // Insert any nearby lead-in entrance that falls along this taxiway segment
      const refinedCoords = [coords[0]];
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i];
        const p2 = coords[i+1];
        const segDist = haversine(p1[0], p1[1], p2[0], p2[1]);

        // Find candidate intermediate points
        const intermediates = [];
        leadInPts.forEach(pt => {
          const d1 = haversine(p1[0], p1[1], pt[0], pt[1]);
          const d2 = haversine(p2[0], p2[1], pt[0], pt[1]);
          if (d1 > 1.0 && d2 > 1.0 && (d1 + d2) < (segDist + 1.5)) {
            intermediates.push({ pt, d1 });
          }
        });

        intermediates.sort((a, b) => a.d1 - b.d1);
        intermediates.forEach(item => refinedCoords.push(item.pt));
        refinedCoords.push(p2);
      }

      const firstNode = this.addNode(refinedCoords[0][0], refinedCoords[0][1]);
      const lastNode = this.addNode(refinedCoords[refinedCoords.length - 1][0], refinedCoords[refinedCoords.length - 1][1]);
      endpoints.push(firstNode, lastNode);

      let prevNode = firstNode;
      for (let i = 1; i < refinedCoords.length; i++) {
        const currNode = (i === refinedCoords.length - 1) ? lastNode : this.addNode(refinedCoords[i][0], refinedCoords[i][1]);
        const w = haversine(refinedCoords[i-1][0], refinedCoords[i-1][1], refinedCoords[i][0], refinedCoords[i][1]);
        this.addEdge(prevNode, currNode, ref, false, w, [refinedCoords[i-1], refinedCoords[i]], false);
        prevNode = currNode;
      }
    });

    // 2. Add runways
    (runways || []).forEach(rwy => {
      const leRef = normalizeIdent(rwy.le_ident);
      const heRef = normalizeIdent(rwy.he_ident);
      const pLe = [rwy.le_latitude, rwy.le_longitude];
      const pHe = [rwy.he_latitude, rwy.he_longitude];
      if (pLe[0] === null || pHe[0] === null) return;

      const totalLen = haversine(pLe[0], pLe[1], pHe[0], pHe[1]);
      const numSteps = Math.max(2, Math.ceil(totalLen / 50));
      let prevNode = this.addNode(pLe[0], pLe[1], 1.0);
      endpoints.push(prevNode);
      for (let k = 1; k <= numSteps; k++) {
        const frac = k / numSteps;
        const lat = pLe[0] + frac * (pHe[0] - pLe[0]);
        const lon = pLe[1] + frac * (pHe[1] - pLe[1]);
        const currNode = this.addNode(lat, lon, 1.0);
        endpoints.push(currNode);
        const w = haversine(this.nodes[prevNode][0], this.nodes[prevNode][1], lat, lon);
        this.addEdge(prevNode, currNode, leRef, true, w, [this.nodes[prevNode], [lat, lon]], false);
        this.addEdge(prevNode, currNode, heRef, true, w, [this.nodes[prevNode], [lat, lon]], false);
        prevNode = currNode;
      }
    });

    const numTaxiwayNodes = this.nodes.length;

    // 3. Connect segment endpoints to nearby taxiway nodes within 12m
    for (const u of endpoints) {
      for (let v = 0; v < numTaxiwayNodes; v++) {
        if (u === v) continue;
        const d = haversine(this.nodes[u][0], this.nodes[u][1], this.nodes[v][0], this.nodes[v][1]);
        if (d <= 12.0) {
          const already = this.adj.get(u).some(e => e.to === v);
          if (!already) {
            this.addEdge(u, v, "CONNECTOR", false, d, [this.nodes[u], this.nodes[v]], true);
          }
        }
      }
    }

    // 4. Connect Bays & Lead-in curves
    (bays || []).forEach(bay => {
      if (!bay.lat || !bay.lon) return;
      const bNode = this.addNode(bay.lat, bay.lon, 0.5);
      const cleanRef = bay.ref.toUpperCase().trim();
      this.bayNodeMap.set(cleanRef, bNode);
      this.bayNodeMap.set(normalizeIdent(cleanRef), bNode);

      if (bay.lead_in_coords && Array.isArray(bay.lead_in_coords) && bay.lead_in_coords.length >= 2) {
        let orderedCoords = [...bay.lead_in_coords];
        const dFirstToBay = haversine(orderedCoords[0][0], orderedCoords[0][1], bay.lat, bay.lon);
        const dLastToBay = haversine(orderedCoords[orderedCoords.length - 1][0], orderedCoords[orderedCoords.length - 1][1], bay.lat, bay.lon);

        if (dFirstToBay < dLastToBay) {
          orderedCoords.reverse();
        }

        let prevLeadNode = null;
        for (let k = 0; k < orderedCoords.length; k++) {
          const pt = orderedCoords[k];
          const currLeadNode = this.addNode(pt[0], pt[1], 0.5);
          
          if (k === 0) {
            this.bayJunctionMap.set(cleanRef, currLeadNode);
            this.bayJunctionMap.set(normalizeIdent(cleanRef), currLeadNode);
          }
          if (prevLeadNode !== null) {
            const w = haversine(this.nodes[prevLeadNode][0], this.nodes[prevLeadNode][1], this.nodes[currLeadNode][0], this.nodes[currLeadNode][1]);
            this.addEdge(prevLeadNode, currLeadNode, "LEADIN_" + cleanRef, false, w, [this.nodes[prevLeadNode], this.nodes[currLeadNode]], false);
            this.addEdge(prevLeadNode, currLeadNode, cleanRef, false, w, [this.nodes[prevLeadNode], this.nodes[currLeadNode]], false);
          }
          prevLeadNode = currLeadNode;
        }

        if (prevLeadNode !== null && prevLeadNode !== bNode) {
          const w = haversine(this.nodes[prevLeadNode][0], this.nodes[prevLeadNode][1], this.nodes[bNode][0], this.nodes[bNode][1]);
          this.addEdge(prevLeadNode, bNode, "LEADIN_" + cleanRef, false, w, [this.nodes[prevLeadNode], this.nodes[bNode]], false);
          this.addEdge(prevLeadNode, bNode, cleanRef, false, w, [this.nodes[prevLeadNode], this.nodes[bNode]], false);
        }

        const startLeadNode = this.bayJunctionMap.get(cleanRef);
        let closestTaxiNode = null;
        let minTaxiD = Infinity;
        for (let i = 0; i < numTaxiwayNodes; i++) {
          const d = haversine(this.nodes[startLeadNode][0], this.nodes[startLeadNode][1], this.nodes[i][0], this.nodes[i][1]);
          if (d < minTaxiD && d < 75.0) {
            minTaxiD = d;
            closestTaxiNode = i;
          }
        }
        if (closestTaxiNode !== null && closestTaxiNode !== startLeadNode) {
          this.addEdge(startLeadNode, closestTaxiNode, "CONNECTOR", false, minTaxiD, [this.nodes[startLeadNode], this.nodes[closestTaxiNode]], true);
        }
      } else {
        let closestNode = null;
        let minD = Infinity;
        for (let i = 0; i < numTaxiwayNodes; i++) {
          const d = haversine(bay.lat, bay.lon, this.nodes[i][0], this.nodes[i][1]);
          if (d < minD && d < 250.0) {
            minD = d;
            closestNode = i;
          }
        }
        if (closestNode !== null) {
          this.bayJunctionMap.set(cleanRef, closestNode);
          this.bayJunctionMap.set(normalizeIdent(cleanRef), closestNode);
          this.addEdge(bNode, closestNode, "LEADIN_" + cleanRef, false, minD, [this.nodes[bNode], this.nodes[closestNode]], false);
          this.addEdge(bNode, closestNode, cleanRef, false, minD, [this.nodes[bNode], this.nodes[closestNode]], false);
        }
      }
    });
  }

  findNodesForParsedToken(t) {
    if (t.type === "GATE" || t.type === "STAND" || t.type === "BAY") {
      const bNode = this.bayNodeMap.get(t.clean) || this.bayNodeMap.get(normalizeIdent(t.clean));
      if (bNode !== undefined) return [bNode];
      const jNode = this.bayJunctionMap.get(t.clean) || this.bayJunctionMap.get(normalizeIdent(t.clean));
      if (jNode !== undefined) return [jNode];
    }

    const set = new Set();
    for (const [u, edges] of this.adj.entries()) {
      for (const e of edges) {
        if (e.ref === t.clean || e.ref === normalizeIdent(t.clean)) {
          set.add(u);
          set.add(e.to);
        }
      }
    }
    return Array.from(set);
  }

  findShortestPath(startNode, targetPredicate, preferredRef, isTargetingGate = false, prevHeadingVector = null) {
    const cleanPref = preferredRef;
    const distMap = new Map();
    const prev = new Map();
    const pq = [{ node: startNode, cost: 0, fromNode: prevHeadingVector ? prevHeadingVector.fromNode : null }];
    distMap.set(startNode, 0);

    let targetNode = null;

    while (pq.length > 0) {
      pq.sort((a, b) => a.cost - b.cost);
      const { node: curr, cost, fromNode: parent } = pq.shift();
      if (distMap.get(curr) < cost) continue;

      if (targetPredicate(curr, this.nodes[curr])) {
        targetNode = curr;
        break;
      }

      for (const edge of this.adj.get(curr)) {
        if (edge.to === parent) continue; // Don't backtrack

        let turnAngle = 0;
        let penaltyCost = 0;
        if (parent !== null) {
          turnAngle = getTurnAngleDeg(this.nodes[parent], this.nodes[curr], this.nodes[edge.to]);
          if (turnAngle > 115) {
            // STRICTLY FORBID acute / reverse hairpin turns (> 115 deg)
            continue;
          } else if (turnAngle > 60) {
            penaltyCost = 25;
          }
        }

        const isExactMatch = cleanPref && (edge.ref === cleanPref || edge.ref.endsWith("_" + cleanPref) || edge.ref === normalizeIdent(cleanPref));
        
        let multiplier = 1.0;
        if (isExactMatch) {
          multiplier = 0.05;
        } else if (edge.ref.startsWith('LEADIN_') || edge.isConnector) {
          multiplier = 0.15;
        } else if (/^[0-9]+$/.test(edge.ref) || /^LN/i.test(edge.ref)) {
          multiplier = 2.5;
        } else {
          multiplier = 5.0;
        }

        const edgeCost = (edge.weight * multiplier) + penaltyCost;
        const newCost = cost + edgeCost;

        if (!distMap.has(edge.to) || newCost < distMap.get(edge.to)) {
          distMap.set(edge.to, newCost);
          prev.set(edge.to, { from: curr, edge });
          pq.push({ node: edge.to, cost: newCost, fromNode: curr });
        }
      }
    }

    if (targetNode === null) return null;

    const pathCoords = [this.nodes[targetNode]];
    let curr = targetNode;
    while (prev.has(curr)) {
      const { from, edge } = prev.get(curr);
      const eCoords = [...edge.coords];
      if (haversine(eCoords[eCoords.length - 1][0], eCoords[eCoords.length - 1][1], this.nodes[curr][0], this.nodes[curr][1]) > 1) {
        eCoords.reverse();
      }
      for (let k = eCoords.length - 2; k >= 0; k--) {
        pathCoords.unshift(eCoords[k]);
      }
      curr = from;
    }

    let trueDistM = 0;
    for (let k = 0; k < pathCoords.length - 1; k++) {
      trueDistM += haversine(pathCoords[k][0], pathCoords[k][1], pathCoords[k+1][0], pathCoords[k+1][1]);
    }

    const lastTwo = pathCoords.length >= 2 ? {
      fromNode: curr,
      p1: pathCoords[pathCoords.length - 2],
      p2: pathCoords[pathCoords.length - 1]
    } : null;

    return { targetNode, pathCoords, distM: trueDistM, lastTwo };
  }

  routeSequential(rawTokens, closedRefs = new Set(), allowClosed = false) {
    if (!rawTokens || rawTokens.length === 0) return null;

    const norm = rawTokens.map((t, idx) => {
      const p = parseToken(t, idx, rawTokens.length, this.runwayIdents, this.bayRefs);
      const isClosed = closedRefs.has(p.clean) || closedRefs.has(p.raw) || closedRefs.has(normalizeIdent(p.clean));
      return { ...p, isClosed };
    });

    // Check for NOTAM closures
    const closedHits = norm.filter(n => n.isClosed);
    if (closedHits.length > 0 && !allowClosed) {
      return {
        notam_warning: true,
        closed_taxiways: closedHits.map(c => c.clean),
        message: `Taxiway ${closedHits.map(c => c.clean).join(', ')} is marked CLOSED in active NOTAMs. Do you wish to proceed?`
      };
    }

    const legs = [];
    let currNode = null;
    let fullCoords = [];

    const token0Nodes = this.findNodesForParsedToken(norm[0]);
    const token1Nodes = norm.length > 1 ? this.findNodesForParsedToken(norm[1]) : [];

    if (token0Nodes.length === 0) return null;
    if (norm.length > 1 && token1Nodes.length === 0) return null;

    if (norm[0].type === "RWY") {
      let minD = Infinity;
      for (const u of token0Nodes) {
        for (const v of token1Nodes) {
          const d = haversine(this.nodes[u][0], this.nodes[u][1], this.nodes[v][0], this.nodes[v][1]);
          if (d < minD) {
            minD = d;
            currNode = v;
          }
        }
      }
    } else {
      let bestStart = null;
      let maxDistTo1 = -1;
      for (const u of token0Nodes) {
        let minDTo1 = Math.min(...token1Nodes.map(v => haversine(this.nodes[u][0], this.nodes[u][1], this.nodes[v][0], this.nodes[v][1])));
        if (minDTo1 > maxDistTo1) {
          maxDistTo1 = minDTo1;
          bestStart = u;
        }
      }
      currNode = bestStart;
    }

    if (currNode === null) return null;

    const startIndex = norm[0].type === "RWY" ? 1 : 0;
    let prevVector = null;

    for (let i = startIndex; i < norm.length - 1; i++) {
      const currentToken = norm[i];
      const nextToken = norm[i+1];
      const targetNodes = new Set(this.findNodesForParsedToken(nextToken));
      const isTargetingGate = (nextToken.type === 'GATE' || nextToken.type === 'STAND' || nextToken.type === 'BAY');

      const res = this.findShortestPath(currNode, (nodeId) => targetNodes.has(nodeId), currentToken.clean, isTargetingGate, prevVector);
      if (!res) break;

      prevVector = res.lastTwo;

      const midIdx = Math.floor(res.pathCoords.length / 2);
      legs.push({
        step: legs.length + 1,
        token: currentToken.raw,
        ref: currentToken.clean,
        type: currentToken.type,
        is_closed: currentToken.isClosed,
        distance_ft: Math.round(res.distM * 3.28084),
        distance_m: Math.round(res.distM),
        start_point: res.pathCoords[0],
        mid_point: res.pathCoords[midIdx],
        end_point: res.pathCoords[res.pathCoords.length - 1],
        coordinates: res.pathCoords
      });

      currNode = res.targetNode;

      if (fullCoords.length === 0) {
        fullCoords.push(...res.pathCoords);
      } else {
        for (let k = 1; k < res.pathCoords.length; k++) {
          fullCoords.push(res.pathCoords[k]);
        }
      }
    }

    let totalDistM = 0;
    for (let k = 0; k < fullCoords.length - 1; k++) {
      totalDistM += haversine(fullCoords[k][0], fullCoords[k][1], fullCoords[k+1][0], fullCoords[k+1][1]);
    }

    return {
      has_closures: legs.some(l => l.is_closed),
      total_distance_ft: Math.round(totalDistM * 3.28084),
      total_distance_m: Math.round(totalDistM),
      est_time_sec: totalDistM > 0 ? Math.round(totalDistM / 7.7) : 0,
      legs,
      path_coordinates: fullCoords
    };
  }
}

app.post("/api/taxi-route", devOnly, async (req, res) => {
  try {
    const { icao, route, allowClosed } = req.body;
    if (!icao || !route) {
      return res.status(400).json({ error: "icao and route are required" });
    }

    const upperIcao = icao.toUpperCase().trim();
    const apt = airportsDb[upperIcao];
    const taxiways = await getAirportTaxiways(upperIcao, apt?.latitude, apt?.longitude);
    const airportRunways = runwaysByIcao[upperIcao] || [];
    const terminalData = await getAirportTerminals(upperIcao, apt?.latitude, apt?.longitude);
    const allSources = await fetchAllAirportSources(upperIcao);
    const operational = resolveActiveOperational(allSources, "real_world");

    const closedRefs = new Set();
    const closedNotamTexts = [];
    if (operational && operational.notams) {
      for (const n of operational.notams) {
        if (/\b(?:TAXIWAY|TWY|APRON|RAMP)\b/i.test(n.text) && /\b(?:CLSD|CLOSED|UNUSABLE)\b/i.test(n.text)) {
          const m = n.text.match(/\b(?:TAXIWAY|TWY)\s+([A-Z0-9]+(?:\s+[A-Z0-9]+)*)/i);
          if (m && m[1]) {
            const parts = m[1].split(/\s+/);
            for (const p of parts) {
              const up = p.toUpperCase();
              if (["CLOSED", "CLSD", "WEST", "EAST", "NORTH", "SOUTH", "OF", "FOR", "BETWEEN", "AND"].includes(up)) break;
              closedRefs.add(up);
              closedNotamTexts.push({ twy: up, text: n.text });
            }
          }
        }
      }
    }

    const tokens = route
      .split(/[\s,\->+]+/g)
      .map(t => t.trim().toUpperCase())
      .filter(Boolean);

    if (tokens.length === 0) {
      return res.status(400).json({ error: "No valid taxiway tokens found" });
    }

    const graph = new TaxiwayGraph(taxiways, airportRunways, terminalData.gates, terminalData.stands, terminalData.bays);
    const routingResult = graph.routeSequential(tokens, closedRefs, allowClosed === true);

    if (routingResult && routingResult.notam_warning) {
      const matchNotams = closedNotamTexts.filter(c => routingResult.closed_taxiways.includes(c.twy));
      return res.json({
        warning: 'NOTAM_CLOSURE',
        closed_taxiways: routingResult.closed_taxiways,
        notams: matchNotams,
        message: routingResult.message
      });
    }

    if (!routingResult || routingResult.path_coordinates.length === 0) {
      return res.status(404).json({ error: "Could not find a continuous connected taxiway route for the given sequence." });
    }

    return res.json({
      icao: upperIcao,
      route_raw: route,
      tokens,
      ...routingResult
    });

  } catch (err) {
    console.error("Taxi route error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC REST API  v1  —  Requires X-API-Key header (if API_KEY env var is set)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/airports/search?q=<query>
 * Instant search across 85,917 airports.
 */
app.get('/api/v1/airports/search', requireApiKey, (req, res) => {
    const q = (req.query.q || '').trim().toUpperCase();
    if (!q) return res.status(400).json({ error: 'q parameter required' });
    const results = Object.values(airportsDb).filter(a =>
        (a.icao && a.icao.includes(q)) ||
        (a.iata && a.iata.includes(q)) ||
        (a.name && a.name.toUpperCase().includes(q)) ||
        (a.city && a.city.toUpperCase().includes(q))
    ).slice(0, 15).map(a => ({
        icao: a.icao, iata: a.iata || null, name: a.name,
        city: a.city || null, country: a.country || null,
        latitude: parseFloat(a.latitude), longitude: parseFloat(a.longitude),
        elevation_ft: a.elevation_ft ? parseInt(a.elevation_ft) : null,
    }));
    res.json(results);
});

/**
 * GET /api/v1/airport/:icao
 * Full airport information.
 */
app.get('/api/v1/airport/:icao', requireApiKey, (req, res) => {
    const icao = req.params.icao.toUpperCase().trim();
    const apt = airportsDb[icao];
    if (!apt) return res.status(404).json({ error: 'Airport not found: ' + icao });
    res.json({
        icao: apt.icao,
        iata: apt.iata || null,
        name: apt.name,
        city: apt.city || null,
        country: apt.country || null,
        latitude: parseFloat(apt.latitude),
        longitude: parseFloat(apt.longitude),
        elevation_ft: apt.elevation_ft ? parseInt(apt.elevation_ft) : null,
        timezone: apt.tz || null,
        type: apt.type || null,
    });
});

/**
 * GET /api/v1/airport/:icao/runways
 * All runways for an airport, including calibrated coordinates and headings.
 */
app.get('/api/v1/airport/:icao/runways', requireApiKey, (req, res) => {
    const icao = req.params.icao.toUpperCase().trim();
    const runways = runwaysByIcao[icao];
    if (!runways || runways.length === 0) {
        return res.status(404).json({ error: 'No runway data found for ' + icao });
    }
    const formatted = runways.map(r => ({
        le_ident: r.le_ident,
        he_ident: r.he_ident,
        length_ft: r.length_ft ? parseInt(r.length_ft) : null,
        width_ft: r.width_ft ? parseInt(r.width_ft) : null,
        surface: r.surface || null,
        le_heading_degT: r.le_heading_degT != null ? parseFloat(r.le_heading_degT) : null,
        he_heading_degT: r.he_heading_degT != null ? parseFloat(r.he_heading_degT) : null,
        le_latitude_deg: r.le_latitude_deg != null ? parseFloat(r.le_latitude_deg) : null,
        le_longitude_deg: r.le_longitude_deg != null ? parseFloat(r.le_longitude_deg) : null,
        he_latitude_deg: r.he_latitude_deg != null ? parseFloat(r.he_latitude_deg) : null,
        he_longitude_deg: r.he_longitude_deg != null ? parseFloat(r.he_longitude_deg) : null,
        is_closed: !!(r.closed || r.is_closed),
        lighted: !!(r.lighted),
    }));
    res.json({ icao, runway_count: formatted.length, runways: formatted });
});

/**
 * GET /api/v1/airport/:icao/weather
 * Live METAR + ATIS data for an airport.
 */
app.get('/api/v1/airport/:icao/weather', requireApiKey, async (req, res) => {
    const icao = req.params.icao.toUpperCase().trim();
    try {
        const sources = await fetchAllAirportSources(icao);
        const result = { icao, sources: {} };
        if (sources.metar) result.sources.metar = sources.metar;
        if (sources.real_world) result.sources.real_world = sources.real_world;
        if (sources.vatsim) result.sources.vatsim = sources.vatsim;
        if (sources.ivao) result.sources.ivao = sources.ivao;
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: 'Weather fetch failed: ' + err.message });
    }
});

/**
 * GET /api/v1/airport/:icao/notams
 * Active NOTAMs for an airport.
 */
app.get('/api/v1/airport/:icao/notams', requireApiKey, async (req, res) => {
    const icao = req.params.icao.toUpperCase().trim();
    try {
        const sources = await fetchAllAirportSources(icao);
        const activeSrc = sources.real_world || sources.vatsim || sources.ivao || sources.metar;
        const notamResult = parseAirportNotams(activeSrc ? (activeSrc.text || '') : '');
        res.json({
            icao,
            source: activeSrc ? activeSrc.source : null,
            count: notamResult.notams.length,
            closed_runways: notamResult.closedRunways,
            notams: notamResult.notams,
        });
    } catch (err) {
        res.status(500).json({ error: 'NOTAM fetch failed: ' + err.message });
    }
});


// ── DEPLOY ENV VARS ────────────────────────────────────────────────────────────
const DEPLOY_SSH_HOST = process.env.DEPLOY_SSH_HOST || null;
const DEPLOY_SSH_USER = process.env.DEPLOY_SSH_USER || 'ubuntu';
const DEPLOY_SSH_PATH = process.env.DEPLOY_SSH_PATH || '/opt/icao-runway-tester';

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN PANEL  —  Requires ADMIN_KEY env var
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /admin — Serve admin panel HTML (No password prompt required) */
app.get('/admin', (req, res) => {
    if (IS_PROD && ADMIN_KEY) {
        const auth = req.headers['authorization'] || '';
        const queryKey = req.query.admin_key || req.headers['x-admin-key'];
        let authenticated = false;
        if (queryKey === ADMIN_KEY) {
            authenticated = true;
        } else if (auth.startsWith('Basic ')) {
            const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
            const [, pass] = decoded.split(':');
            if (pass === ADMIN_KEY) authenticated = true;
        }
        if (!authenticated) {
            res.set('WWW-Authenticate', 'Basic realm="ICAO Admin"');
            return res.status(401).send('Authentication required in production.');
        }
    }
    const adminHtmlPath = path.join(__dirname, 'public', 'admin.html');
    if (!fs.existsSync(adminHtmlPath)) {
        return res.status(404).send('Admin panel not found. Ensure public/admin.html exists.');
    }
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    res.sendFile(adminHtmlPath);
});

/** GET /admin/api/keys — List all API keys */
app.get('/admin/api/keys', requireAdminKey, (req, res) => {
    const db = loadApiKeys();
    const masked = db.keys.map(k => ({
        ...k,
        key: k.key.slice(0, 8) + '...' + k.key.slice(-4),
        key_full: k.key // full key returned here for admin use
    }));
    res.json({ count: masked.length, keys: masked });
});

/** POST /admin/api/keys — Create a new API key */
app.post('/admin/api/keys', requireAdminKey, (req, res) => {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'name is required' });
    }
    const db = loadApiKeys();
    const newKey = {
        id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
        name: name.trim(),
        description: (description || '').trim(),
        key: generateApiKey(),
        created_at: new Date().toISOString(),
        last_used_at: null,
        use_count: 0,
        enabled: true
    };
    db.keys.push(newKey);
    saveApiKeys(db);
    res.status(201).json({ message: 'API key created', key: newKey });
});

/** PATCH /admin/api/keys/:id — Enable or disable a key */
app.patch('/admin/api/keys/:id', requireAdminKey, (req, res) => {
    const db = loadApiKeys();
    const key = db.keys.find(k => k.id === req.params.id);
    if (!key) return res.status(404).json({ error: 'Key not found' });
    if (typeof req.body.enabled === 'boolean') key.enabled = req.body.enabled;
    if (req.body.name) key.name = req.body.name.trim();
    if (req.body.description !== undefined) key.description = req.body.description.trim();
    saveApiKeys(db);
    res.json({ message: 'Key updated', key });
});

/** DELETE /admin/api/keys/:id — Revoke a key */
app.delete('/admin/api/keys/:id', requireAdminKey, (req, res) => {
    const db = loadApiKeys();
    const idx = db.keys.findIndex(k => k.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Key not found' });
    const removed = db.keys.splice(idx, 1)[0];
    saveApiKeys(db);
    res.json({ message: 'Key revoked', id: removed.id, name: removed.name });
});

/** GET /admin/api/status — Git status for deploy panel */
app.get('/admin/api/status', requireAdminKey, (req, res) => {
    const { execSync } = require('child_process');
    try {
        const statusRaw = execSync('git status --porcelain', { cwd: __dirname }).toString().trim();
        const logRaw = execSync('git log --oneline -5', { cwd: __dirname }).toString().trim();
        const branchRaw = execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname }).toString().trim();
        const files = statusRaw ? statusRaw.split('\n').map(l => ({ status: l.slice(0,2).trim(), file: l.slice(3) })) : [];
        res.json({ branch: branchRaw, modified_files: files, recent_commits: logRaw.split('\n') });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** POST /admin/api/deploy — Commit, push to GitHub, optionally SSH deploy */
app.post('/admin/api/deploy', requireAdminKey, async (req, res) => {
    const { message = 'chore: production deploy from admin panel', ssh_deploy = false } = req.body;
    const { execSync, exec } = require('child_process');

    // Stream output via SSE or just collect and return
    const log = [];
    const run = (cmd, opts = {}) => {
        try {
            const out = execSync(cmd, { cwd: __dirname, ...opts }).toString().trim();
            if (out) log.push(out);
            return out;
        } catch (err) {
            const errMsg = 'ERROR: ' + (err.stderr ? err.stderr.toString() : err.message);
            log.push(errMsg);
            throw new Error(errMsg);
        }
    };

    try {
        run('git add -A');
        log.push('Staged all changes');

        // Check if there's anything to commit
        const statusCheck = execSync('git status --porcelain', { cwd: __dirname }).toString().trim();
        if (!statusCheck) {
            log.push('Nothing to commit — already up to date');
        } else {
            run('git commit -m ' + JSON.stringify(message));
            log.push('Committed: ' + message);
        }

        run('git push origin main');
        log.push('Pushed to GitHub — Docker build triggered via GitHub Actions');

        // Optional SSH deploy to production server
        if (ssh_deploy && DEPLOY_SSH_HOST) {
            const sshCmd = [
                'ssh',
                '-o StrictHostKeyChecking=no',
                DEPLOY_SSH_USER + '@' + DEPLOY_SSH_HOST,
                '"cd ' + DEPLOY_SSH_PATH + ' && docker-compose pull && docker-compose up -d"'
            ].join(' ');
            log.push('SSHing into ' + DEPLOY_SSH_HOST + ' to pull new image...');
            run(sshCmd);
            log.push('Production container restarted with new image ✅');
        } else if (ssh_deploy && !DEPLOY_SSH_HOST) {
            log.push('SSH deploy skipped — DEPLOY_SSH_HOST not configured');
        }

        res.json({ success: true, log });
    } catch (err) {
        res.status(500).json({ success: false, log, error: err.message });
    }
});


/**
 * POST /api/v1/touchdown
 * Comprehensive Touchdown GPS Telemetry Analyzer.
 * 
 * Body: {
 *   lat: number (required),
 *   lon: number (required),
 *   heading?: number,
 *   vertical_speed_fpm?: number,
 *   ias_kt?: number,
 *   g_force?: number,
 *   bank_deg?: number,
 *   pitch_deg?: number,
 *   icao?: string
 * }
 */


// ── Build Runway GeoJSON Overlay (Runway Polygon, Centerline, Deviation Vector & Dot) ──
function buildRunwayGeoJsonOverlay(lat, lon, activeRunway) {
    const cleanLat = parseFloat(lat);
    const cleanLon = parseFloat(lon);

    if (!activeRunway || !activeRunway.le_latitude || !activeRunway.he_latitude) {
        return {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { name: 'Touchdown Point', 'marker-color': 'ff1e42', 'marker-size': 'small' },
                    geometry: { type: 'Point', coordinates: [cleanLon, cleanLat] }
                }
            ]
        };
    }

    const rwy = activeRunway;
    const halfWidthM = ((rwy.width_ft || 150) * 0.3048) / 2;
    const brng = rwy.centerline_bearing_deg || 0;

    const c1 = destinationPoint(rwy.le_latitude, rwy.le_longitude, brng - 90, halfWidthM);
    const c2 = destinationPoint(rwy.le_latitude, rwy.le_longitude, brng + 90, halfWidthM);
    const c3 = destinationPoint(rwy.he_latitude, rwy.he_longitude, brng + 90, halfWidthM);
    const c4 = destinationPoint(rwy.he_latitude, rwy.he_longitude, brng - 90, halfWidthM);

    const a = rwy.analysis || {};
    const dt_m = ((a.end_code === 'le' ? rwy.le_displaced_threshold_ft : rwy.he_displaced_threshold_ft) || 0) * 0.3048;
    const totalAlongM = (a.distance_from_threshold_m || 0) + dt_m;
    const originLat = a.end_code === 'le' ? rwy.le_latitude : rwy.he_latitude;
    const originLon = a.end_code === 'le' ? rwy.le_longitude : rwy.he_longitude;
    const rwyHdg = a.runway_heading_deg || brng;
    const projPoint = destinationPoint(originLat, originLon, rwyHdg, totalAlongM);

    const features = [
        // 1. Runway Outline Polygon
        {
            type: 'Feature',
            properties: {
                name: `Runway ${rwy.le_ident || ''}/${rwy.he_ident || ''}`,
                stroke: '#00ff88',
                'stroke-width': 2,
                fill: '#00ff88',
                'fill-opacity': 0.16
            },
            geometry: {
                type: 'Polygon',
                coordinates: [[
                    [c1.longitude, c1.latitude],
                    [c2.longitude, c2.latitude],
                    [c3.longitude, c3.latitude],
                    [c4.longitude, c4.latitude],
                    [c1.longitude, c1.latitude]
                ]]
            }
        },
        // 2. White Runway Centerline
        {
            type: 'Feature',
            properties: {
                name: 'Centerline',
                stroke: '#ffffff',
                'stroke-width': 2,
                'stroke-opacity': 0.85
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [rwy.le_longitude, rwy.le_latitude],
                    [rwy.he_longitude, rwy.he_latitude]
                ]
            }
        }
    ];

    // 3. Centerline Deviation Vector (if deviation exists)
    if (a.deviation_ft && Math.abs(a.deviation_ft) > 0.5) {
        features.push({
            type: 'Feature',
            properties: {
                name: 'Centerline Deviation Vector',
                deviation_ft: a.deviation_ft,
                deviation_m: a.deviation_m,
                side: a.side,
                stroke: '#ff1e42',
                'stroke-width': 3.5,
                'stroke-opacity': 1.0
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [cleanLon, cleanLat],
                    [projPoint.longitude, projPoint.latitude]
                ]
            }
        });
    }

    // 4. Touchdown Marker Point
    features.push({
        type: 'Feature',
        properties: {
            name: 'Touchdown Point',
            'marker-color': 'ff1e42',
            'marker-size': 'small'
        },
        geometry: {
            type: 'Point',
            coordinates: [cleanLon, cleanLat]
        }
    });

    return { type: 'FeatureCollection', features };
}

// ── Mapbox Static Map Generator ───────────────────────────────────────────────
function buildMapboxStaticUrl({
    lat,
    lon,
    zoom = 16,
    width = 800,
    height = 500,
    bearing = 0,
    pitch = 0,
    style = 'satellite-v9',
    activeRunway = null,
    markerColor = 'ff1e42',
    retina = true
}) {
    const token = process.env.MAPBOX_TOKEN || DEFAULT_MB;
    let styleId = style;
    if (style === 'satellite') styleId = 'mapbox/satellite-v9';
    else if (style === 'satellite-streets') styleId = 'mapbox/satellite-streets-v12';
    else if (style === 'dark') styleId = 'mapbox/dark-v11';
    else if (style === 'streets') styleId = 'mapbox/streets-v12';
    else if (style === 'outdoors') styleId = 'mapbox/outdoors-v12';
    else if (!styleId.includes('/')) styleId = `mapbox/${styleId}`;

    const w = Math.min(1280, Math.max(100, parseInt(width) || 800));
    const h = Math.min(1280, Math.max(100, parseInt(height) || 500));
    const z = Math.min(22, Math.max(1, parseFloat(zoom) || 16));
    const b = Math.min(360, Math.max(0, parseFloat(bearing) || 0));
    const p = Math.min(60, Math.max(0, parseFloat(pitch) || 0));
    const retinaStr = retina ? '@2x' : '';

    const cleanLat = parseFloat(lat);
    const cleanLon = parseFloat(lon);

    const geojsonObj = buildRunwayGeoJsonOverlay(cleanLat, cleanLon, activeRunway);
    const geojsonStr = encodeURIComponent(JSON.stringify(geojsonObj));
    return `https://api.mapbox.com/styles/v1/${styleId}/static/geojson(${geojsonStr})/${cleanLon.toFixed(6)},${cleanLat.toFixed(6)},${z},${b},${p}/${w}x${h}${retinaStr}?access_token=${token}`;
}

app.get('/api/v1/map/static', requireApiKey, async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lon = parseFloat(req.query.lon);

        if (isNaN(lat) || isNaN(lon)) {
            return res.status(400).json({ error: 'lat and lon query parameters are required numbers' });
        }

        const zoom = req.query.zoom || 17.5;
        const width = req.query.width || 800;
        const height = req.query.height || 500;
        const bearing = req.query.bearing || req.query.heading || 0;
        const pitch = req.query.pitch || 0;
        const style = req.query.style || 'satellite-v9';
        const markerColor = req.query.marker !== 'false' ? (req.query.marker || 'ff1e42') : null;
        const retina = req.query.retina !== 'false';
        const format = (req.query.format || 'image').toLowerCase();

        const candidateRunways = findNearbyGridItems(runwayGrid, lat, lon, 0.25);
        let activeRwy = null;
        if (candidateRunways.length > 0) {
            for (const rwy of candidateRunways) {
                const res = analyzeRunwayLanding(lat, lon, rwy, null, null);
                if (res && (res.on_runway || res.near_runway)) {
                    activeRwy = { ...rwy, analysis: res };
                    break;
                }
            }
            if (!activeRwy && candidateRunways.length > 0) {
                const rwy = candidateRunways[0];
                activeRwy = { ...rwy, analysis: analyzeRunwayLanding(lat, lon, rwy, null, null) };
            }
        }

        const staticUrl = buildMapboxStaticUrl({
            lat, lon, zoom, width, height, bearing, pitch, style, activeRunway: activeRwy, markerColor, retina
        });

        if (format === 'json') {
            return res.json({
                status: 'ok',
                coordinates: { latitude: lat, longitude: lon },
                zoom: parseFloat(zoom),
                dimensions: { width: parseInt(width), height: parseInt(height) },
                bearing: parseFloat(bearing),
                pitch: parseFloat(pitch),
                style,
                image_url: staticUrl
            });
        }

        if (format === 'redirect') {
            return res.redirect(302, staticUrl);
        }

        // Default: Stream the image binary directly with cache headers
        const imgResp = await fetch(staticUrl);
        if (!imgResp.ok) {
            return res.status(imgResp.status).json({ error: 'Failed to fetch static map from Mapbox' });
        }

        res.set({
            'Content-Type': imgResp.headers.get('content-type') || 'image/png',
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*'
        });

        const arrayBuffer = await imgResp.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
    } catch (err) {
        console.error('Error in /api/v1/map/static:', err);
        res.status(500).json({ error: 'Static map error: ' + err.message });
    }
});

app.post('/api/v1/touchdown', requireApiKey, async (req, res) => {
    try {
        let { lat, lon, heading, vertical_speed_fpm, ias_kt, g_force, bank_deg, pitch_deg, icao } = req.body;

        if (typeof lat !== 'number' || typeof lon !== 'number') {
            return res.status(400).json({ error: 'lat and lon must be numbers representing GPS decimal coordinates' });
        }

        // Query spatial grids
        const candidateRunways = findNearbyGridItems(runwayGrid, lat, lon, 0.25);
        const candidateAirports = findNearbyGridItems(airportGrid, lat, lon, 0.30);

        let selectedAirportIcao = (icao || '').toUpperCase().trim();
        if (!selectedAirportIcao && candidateAirports.length > 0) {
            candidateAirports.sort((a, b) => haversine(lat, lon, a.latitude, a.longitude) - haversine(lat, lon, b.latitude, b.longitude));
            selectedAirportIcao = candidateAirports[0].icao;
        }

        const primaryAirport = selectedAirportIcao ? airportsDb[selectedAirportIcao] : null;

        // Operational Weather & ATIS context
        let operationalCtx = null;
        let weatherSources = {};
        if (selectedAirportIcao) {
            try {
                weatherSources = await fetchAllAirportSources(selectedAirportIcao);
                operationalCtx = resolveActiveOperational(weatherSources, 'real_world');
            } catch (wErr) {
                console.warn('Weather fetch warning in /api/v1/touchdown:', wErr.message);
            }
        }

        // Analyze all runways within scope
        const airportElev = primaryAirport?.elevation_ft ? parseInt(primaryAirport.elevation_ft) : null;
        const analyzedRunways = [];

        const airportRunways = selectedAirportIcao && runwaysByIcao[selectedAirportIcao] ? runwaysByIcao[selectedAirportIcao] : candidateRunways;

        for (const rwy of airportRunways) {
            const result = analyzeRunwayLanding(lat, lon, rwy, operationalCtx, airportElev);
            if (!result) continue;

            const midLat = ((rwy.le_latitude || 0) + (rwy.he_latitude || 0)) / 2;
            const midLon = ((rwy.le_longitude || 0) + (rwy.he_longitude || 0)) / 2;
            const dist = (rwy.le_latitude && rwy.he_latitude) ? haversine(lat, lon, midLat, midLon) : 99999;

            analyzedRunways.push({
                airport_icao: rwy.airport_icao,
                le_ident: rwy.le_ident,
                he_ident: rwy.he_ident,
                length_ft: rwy.length_ft,
                length_m: rwy.length_m || (rwy.length_ft ? Math.round(rwy.length_ft * 0.3048) : null),
                width_ft: rwy.width_ft,
                width_m: rwy.width_ft ? Math.round(rwy.width_ft * 0.3048) : null,
                surface: rwy.surface,
                lighted: !!rwy.lighted,
                le_latitude: rwy.le_latitude,
                le_longitude: rwy.le_longitude,
                he_latitude: rwy.he_latitude,
                he_longitude: rwy.he_longitude,
                centerline_bearing_deg: rwy.centerline_bearing_deg,
                dist_to_midpoint_m: Math.round(dist),
                is_closed: result.is_closed,
                closure_reason: result.closure_reason,
                analysis: result
            });
        }

        analyzedRunways.sort((a, b) => {
            if (a.analysis.on_runway !== b.analysis.on_runway) return a.analysis.on_runway ? -1 : 1;
            return a.dist_to_midpoint_m - b.dist_to_midpoint_m;
        });

        const activeOnRunway = analyzedRunways.find(r => r.analysis.on_runway) || null;
        const activeRunway = activeOnRunway || (analyzedRunways.length > 0 ? analyzedRunways[0] : null);

        // Derive landing quality rating if vertical speed or g-force is provided
        let landingRating = null;
        if (typeof vertical_speed_fpm === 'number') {
            const vs = Math.abs(vertical_speed_fpm);
            if (vs < 80) landingRating = '🧈 Butter Smooth';
            else if (vs < 160) landingRating = '✨ Good Landing';
            else if (vs < 260) landingRating = '👌 Acceptable / Firm';
            else if (vs < 400) landingRating = '⚠️ Hard Landing';
            else landingRating = '💥 Severe Impact';
        }

        let touchdownSummary = null;
        if (activeRunway && activeRunway.analysis) {
            const a = activeRunway.analysis;
            touchdownSummary = {
                on_runway: a.on_runway,
                runway_ident: a.runway_end_ident,
                runway_pair: `${activeRunway.le_ident}/${activeRunway.he_ident}`,
                runway_heading_deg: a.runway_heading_deg,
                surface: activeRunway.surface || 'Unknown',
                length_ft: activeRunway.length_ft,
                width_ft: activeRunway.width_ft,
                centerline_deviation: {
                    deviation_ft: a.deviation_ft,
                    deviation_m: a.deviation_m,
                    side: a.side, // 'center', 'left', 'right'
                    text: Math.abs(a.deviation_ft) < 1.5 ? 'Centerline' : `${Math.abs(a.deviation_ft)} ft ${a.side}`
                },
                threshold_distance: {
                    distance_from_threshold_ft: a.distance_from_threshold_ft,
                    distance_from_threshold_m: a.distance_from_threshold_m,
                    touchdown_zone: a.touchdown_zone,
                    remaining_runway_ft: a.remaining_ft,
                    remaining_runway_m: a.remaining_m,
                    percent_runway_used: a.pct_runway_used
                },
                wind: {
                    headwind_kt: a.headwind_kt,
                    crosswind_kt: a.crosswind_kt,
                    summary: a.headwind_kt !== null ? `${a.headwind_kt >= 0 ? 'Headwind' : 'Tailwind'} ${Math.abs(a.headwind_kt)}kt, ${Math.abs(a.crosswind_kt || 0)}kt ${(a.crosswind_kt || 0) < 0 ? 'from left' : 'from right'}` : 'No wind data'
                },
                flight_telemetry: {
                    aircraft_heading_deg: typeof heading === 'number' ? heading : null,
                    vertical_speed_fpm: typeof vertical_speed_fpm === 'number' ? vertical_speed_fpm : null,
                    ias_kt: typeof ias_kt === 'number' ? ias_kt : null,
                    g_force: typeof g_force === 'number' ? g_force : null,
                    bank_deg: typeof bank_deg === 'number' ? bank_deg : null,
                    pitch_deg: typeof pitch_deg === 'number' ? pitch_deg : null,
                    landing_rating: landingRating
                }
            };
        }

        const distToAirportM = (primaryAirport?.latitude && primaryAirport?.longitude)
            ? haversine(lat, lon, primaryAirport.latitude, primaryAirport.longitude)
            : 99999;
        const isOffAirfield = !activeOnRunway && !activeRunway?.analysis?.near_runway && (distToAirportM > 3500);
        const distToAirportNm = Math.round((distToAirportM / 1852) * 10) / 10;

        const geojsonOverlay = buildRunwayGeoJsonOverlay(lat, lon, activeRunway);
        const staticMapData = {
            satellite_url: buildMapboxStaticUrl({ lat, lon, zoom: 16, width: 800, height: 500, style: 'satellite-v9', activeRunway }),
            runway_perspective_url: activeRunway?.analysis?.runway_heading_deg != null
                ? buildMapboxStaticUrl({ lat, lon, zoom: 16, width: 800, height: 500, bearing: activeRunway.analysis.runway_heading_deg, pitch: 25, style: 'satellite-v9', activeRunway })
                : null,
            dark_mode_url: buildMapboxStaticUrl({ lat, lon, zoom: 16, width: 800, height: 500, style: 'dark-v11', activeRunway }),
            direct_image_api: `/api/v1/map/static?lat=${lat}&lon=${lon}&zoom=16&style=satellite`
        };

        const liveMapUrl = `/?lat=${lat}&lon=${lon}&zoom=18`;

        if (isOffAirfield) {
            return res.json({
                status: 'off_airfield',
                touchdown_coordinates: { latitude: lat, longitude: lon },
                nearest_airport: primaryAirport ? {
                    label: `Near ${primaryAirport.icao} - ${primaryAirport.name}`,
                    icao: primaryAirport.icao,
                    iata: primaryAirport.iata || null,
                    name: primaryAirport.name,
                    city: primaryAirport.city || null,
                    country: primaryAirport.country || null,
                    distance_nm: distToAirportNm,
                    distance_km: Math.round((distToAirportM / 1000) * 10) / 10
                } : null,
                live_map_url: liveMapUrl,
                static_map: staticMapData,
                geojson_overlay: geojsonOverlay,
                message: primaryAirport
                    ? `Touchdown located off-airfield near ${primaryAirport.icao} (${primaryAirport.name}, ${distToAirportNm} NM away).`
                    : `Touchdown located at non-airfield coordinates: ${lat}, ${lon}.`
            });
        }

        res.json({
            status: activeOnRunway ? 'on_runway' : (activeRunway?.analysis?.near_runway ? 'near_runway' : 'off_runway'),
            touchdown_coordinates: { latitude: lat, longitude: lon },
            airport: primaryAirport ? {
                icao: primaryAirport.icao,
                iata: primaryAirport.iata || null,
                name: primaryAirport.name,
                city: primaryAirport.city || null,
                country: primaryAirport.country || null,
                elevation_ft: airportElev
            } : null,
            touchdown: touchdownSummary,
            live_map_url: liveMapUrl,
            static_map: staticMapData,
            geojson_overlay: geojsonOverlay,
            all_runways: analyzedRunways.map(r => ({
                runway: `${r.le_ident}/${r.he_ident}`,
                length_ft: r.length_ft,
                width_ft: r.width_ft,
                surface: r.surface,
                active_end: r.analysis.runway_end_ident,
                on_runway: r.analysis.on_runway,
                deviation_ft: r.analysis.deviation_ft,
                distance_from_threshold_ft: r.analysis.distance_from_threshold_ft,
                touchdown_zone: r.analysis.touchdown_zone,
                headwind_kt: r.analysis.headwind_kt,
                crosswind_kt: r.analysis.crosswind_kt
            })),
            weather: {
                metar_raw: weatherSources.metar?.text || null,
                atis_raw: (weatherSources.real_world || weatherSources.vatsim || weatherSources.ivao)?.text || null
            }
        });
    } catch (err) {
        console.error('Error in /api/v1/touchdown:', err);
        res.status(500).json({ error: 'Touchdown analysis error: ' + err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🗺  ICAO Runway Tester running at: http://localhost:${PORT}`);
});

// ── Point-to-Polyline Geodesic Distance for Taxiway Detection ────────────────

function distanceToSegmentM(pLat, pLon, aLat, aLon, bLat, bLon) {
    const lat1 = aLat * RAD, lon1 = aLon * RAD;
    const lat2 = bLat * RAD, lon2 = bLon * RAD;
    const pL   = pLat * RAD, pLo  = pLon * RAD;

    // Planar projection around centroid (highly accurate for airport scale < 5km)
    const cosLat = Math.cos((lat1 + lat2) / 2);
    const x1 = 0, y1 = 0;
    const x2 = (lon2 - lon1) * cosLat * EARTH_RADIUS_M;
    const y2 = (lat2 - lat1) * EARTH_RADIUS_M;
    const px = (pLo - lon1) * cosLat * EARTH_RADIUS_M;
    const py = (pL - lat1) * EARTH_RADIUS_M;

    const dx = x2 - x1, dy = y2 - y1;
    const segLenSq = dx * dx + dy * dy;
    if (segLenSq < 1e-6) return haversine(pLat, pLon, aLat, aLon);

    let t = (px * dx + py * dy) / segLenSq;
    t = Math.max(0, Math.min(1, t));

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const distSq = (px - projX) ** 2 + (py - projY) ** 2;
    return Math.sqrt(distSq);
}

function distanceToPolylineM(pLat, pLon, coords) {
    let minDist = Infinity;
    for (let i = 0; i < coords.length - 1; i++) {
        const [aLat, aLon] = coords[i];
        const [bLat, bLon] = coords[i+1];
        const d = distanceToSegmentM(pLat, pLon, aLat, aLon, bLat, bLon);
        if (d < minDist) minDist = d;
    }
    return minDist;
}
