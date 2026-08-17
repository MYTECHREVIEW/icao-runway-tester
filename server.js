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
        real_world: { available: false, type: 'real_world', title: 'Real World D-ATIS', code: null, text: null, landing_runways: [], departing_runways: [], wind_dir: null, wind_speed: null, wind_gust: null },
        vatsim:     { available: false, type: 'vatsim', title: 'VATSIM Network ATIS', callsign: null, code: null, text: null, landing_runways: [], departing_runways: [], wind_dir: null, wind_speed: null, wind_gust: null },
        ivao:       { available: false, type: 'ivao', title: 'IVAO Network ATIS', callsign: null, code: null, text: null, landing_runways: [], departing_runways: [], wind_dir: null, wind_speed: null, wind_gust: null },
        metar:      { available: false, type: 'metar', title: 'Live METAR Observation', raw: null, wind_dir: null, wind_speed: null, wind_gust: null, temp: null, dew: null, qnh: null, flight_category: null }
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
            sources.metar.qnh = m0.altim !== undefined ? Number(m0.altim) : null;
            sources.metar.flight_category = m0.fltcat || null;
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

    return endMetrics[chosenEnd];
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

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DEFAULT_MB = Buffer.from('cGsuZXlKMUlqb2liWGwwWldOb2NtVjJhV1YzSWl3aVlTSTZJbU50YTNJM2JXTjVlVEJpTnpBelpuQjFkM3BuTm1WMWFXMGlmUS5lM1A2MG9ybF93U0NVYjUtMVJKR3pn', 'base64').toString('utf8');
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
    const { lat, lon, preferredSource } = req.body;
    if (typeof lat !== 'number' || typeof lon !== 'number') {
        return res.status(400).json({ error: 'lat and lon must be numbers' });
    }

    const candidateRunways = findNearbyGridItems(runwayGrid, lat, lon, 0.12);
    const candidateAirports = findNearbyGridItems(airportGrid, lat, lon, 0.15);

    // 1. Direct Runway Pavement Check
    let onRunwayAirportIcao = null;

    for (const rwy of candidateRunways) {
        const leLat = rwy.le_latitude, leLon = rwy.le_longitude;
        const heLat = rwy.he_latitude, heLon = rwy.he_longitude;
        if (leLat === null || heLat === null || leLon === null || heLon === null) continue;

        const totalLen_m = (rwy.length_ft || 0) * M_PER_FT;
        const halfWidth_m = ((rwy.width_ft || 45) * M_PER_FT) / 2 + 5;
        const xtd = Math.abs(crossTrack(leLat, leLon, heLat, heLon, lat, lon));
        const atd = alongTrack(leLat, leLon, heLat, heLon, lat, lon);

        if (xtd <= halfWidth_m && atd >= -10 && atd <= totalLen_m + 10) {
            const apt = airportsDb[rwy.airport_icao] || {};
            const isLand = apt.type !== 'seaplane_base' && rwy.surface !== 'water';
            if (isLand || !onRunwayAirportIcao) {
                onRunwayAirportIcao = rwy.airport_icao;
                if (isLand) break;
            }
        }
    }

    // 2. Airport Reference Distance Check
    let selectedAirportIcao = onRunwayAirportIcao;

    if (!selectedAirportIcao) {
        const scoredAirports = [];
        for (const apt of candidateAirports) {
            if (apt.latitude === null || apt.longitude === null) continue;
            const dist = haversine(lat, lon, apt.latitude, apt.longitude);
            if (dist > 8000) continue;

            let weight = 1.0;
            if (apt.type === 'large_airport') weight = 0.5;
            else if (apt.type === 'medium_airport') weight = 0.7;
            else if (apt.type === 'small_airport') weight = 0.9;
            else if (apt.type === 'seaplane_base') weight = 2.5;
            else if (apt.type === 'heliport') weight = 2.0;
            else if (apt.type === 'closed') weight = 4.0;

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

    res.json({
        lat, lon,
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
        runways: analyzedRunways
    });
});

app.listen(PORT, () => {
    console.log(`\n🗺  ICAO Runway Tester running at: http://localhost:${PORT}`);
});
