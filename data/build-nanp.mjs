// Builds data/nanp.json: the offline NANP area-code table used for zero-network risk checks.
// Source: ravisorg/Area-Code-Geolocation-Database (public domain area-code geography).
// Run with `node data/build-nanp.mjs`. CI re-runs it on every deploy so the table stays current.

import { writeFile } from 'node:fs/promises';

const BASE = 'https://raw.githubusercontent.com/ravisorg/Area-Code-Geolocation-Database/master';

async function csv(name) {
  const response = await fetch(`${BASE}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return (await response.text()).split(/\r?\n/).filter(Boolean);
}

// Splits a CSV row honouring the "quoted, with commas" fields the source uses for place names.
function fields(row) {
  return (row.match(/("[^"]*"|[^,]*)(,|$)/g) || []).map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, ''));
}

function haversine(aLat, aLon, bLat, bLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

async function region(country, geoFile, cityFile) {
  const centroids = new Map();
  for (const row of await csv(geoFile)) {
    const [npa, lat, lon] = fields(row);
    if (/^\d{3}$/.test(npa)) centroids.set(npa, [Number(lat), Number(lon)]);
  }
  const cities = new Map();
  for (const row of await csv(cityFile)) {
    const [npa, city, state, , lat, lon] = fields(row);
    if (!centroids.has(npa)) continue;
    if (!cities.has(npa)) cities.set(npa, []);
    cities.get(npa).push({ city, state, lat: Number(lat), lon: Number(lon) });
  }
  const table = {};
  for (const [npa, [lat, lon]] of centroids) {
    const candidates = cities.get(npa) || [];
    // The city nearest the area code's centroid is the most representative label for it.
    const anchor = candidates.slice().sort((a, b) => haversine(lat, lon, a.lat, a.lon) - haversine(lat, lon, b.lat, b.lon))[0];
    // States actually covered by the area code, most-used first: an NPA can straddle a border.
    const states = [...candidates.reduce((counts, entry) => counts.set(entry.state, (counts.get(entry.state) || 0) + 1), new Map())]
      .sort((a, b) => b[1] - a[1]).map(([state]) => state);
    table[npa] = { country, city: anchor?.city || null, states, lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) };
  }
  return table;
}

const npa = { ...(await region('US', 'us-area-code-geo.csv', 'us-area-code-cities.csv')), ...(await region('CA', 'ca-area-code-geo.csv', 'ca-area-code-cities.csv')) };

// Easily-recognisable codes reserved by the NANP administrator; none can originate a real call.
const reserved = {
  '456': 'Inbound international carrier-selection code',
  '500': 'Personal communications service', '521': 'Personal communications service', '522': 'Personal communications service',
  '533': 'Personal communications service', '544': 'Personal communications service', '566': 'Personal communications service',
  '577': 'Personal communications service', '588': 'Personal communications service',
  '600': 'Canadian non-geographic service', '700': 'Carrier-specific service access',
  '710': 'US Government emergency network', '900': 'Premium rate'
};
const tollFree = ['800', '833', '844', '855', '866', '877', '888'];

const payload = { generated: new Date().toISOString().slice(0, 10), source: `${BASE} (ODbL / public domain)`, npa, reserved, tollFree };
await writeFile(new URL('./nanp.json', import.meta.url), `${JSON.stringify(payload)}\n`);
console.log(`nanp.json: ${Object.keys(npa).length} area codes`);
