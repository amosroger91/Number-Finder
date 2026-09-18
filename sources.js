// External data sources. Every endpoint here is keyless and, unless routed through `viaProxy`,
// sends CORS headers that let a static GitHub Pages origin call it directly.
//
// Verified browser-reachable (Access-Control-Allow-Origin present):
//   opendata.fcc.gov  areacode.fyi  overpass-api.de  query.wikidata.org  cdn.jsdelivr.net
//   raw.githubusercontent.com
// Requires a proxy (no CORS headers of their own):
//   efts.sec.gov  freecnam.org

const TIMEOUT = 20000;
const cache = new Map();

// One in-flight request per key, and the settled promise is reused for the rest of the session.
function once(key, run) {
  if (!cache.has(key)) cache.set(key, run().catch((error) => { cache.delete(key); throw error; }));
  return cache.get(key);
}

async function request(url, { timeout = TIMEOUT, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// Public CORS relays for the two sources that serve no CORS headers. These are third-party free
// tiers with no availability guarantee, so callers must treat a rejection as "unknown", not "clean".
const PROXIES = [
  (url) => `https://r.jina.ai/${url}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
];

async function viaProxy(url, { timeout = 30000 } = {}) {
  let lastError;
  for (const build of PROXIES) {
    try {
      return await (await request(build(url), { timeout, headers: { Accept: 'text/plain, */*' } })).text();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No proxy available');
}

// --- Number formatting helpers -------------------------------------------------------------

// The same number as written by the many conventions open datasets use, for exact-match lookups.
function formatVariants(phone) {
  const national = phone.nationalNumber;
  const cc = phone.countryCallingCode;
  const variants = new Set([phone.number, phone.formatInternational(), phone.formatNational(), national, `+${cc}${national}`]);
  if (national.length === 10) {
    const [npa, nxx, line] = [national.slice(0, 3), national.slice(3, 6), national.slice(6)];
    for (const body of [`${npa}-${nxx}-${line}`, `(${npa}) ${nxx}-${line}`, `${npa}.${nxx}.${line}`, `${npa} ${nxx} ${line}`]) {
      variants.add(body);
      variants.add(`+${cc} ${body}`);
      variants.add(`+${cc}-${body}`);
    }
  }
  return [...variants].filter(Boolean);
}

// --- FCC consumer complaints ---------------------------------------------------------------
// opendata.fcc.gov dataset vakf-fz8e: ~1.8M unwanted-call complaints, refreshed daily, keyless,
// CORS-enabled. `caller_id_number` is the number that called; `advertiser_business_phone_number`
// is the business the complainant said the call was made on behalf of.

const FCC = 'https://opendata.fcc.gov/resource/vakf-fz8e.json';

function soql(params) {
  return `${FCC}?${new URLSearchParams(params)}`;
}

// The dataset stores numbers as NNN-NNN-NNNN, so only NANP numbers can be matched.
function fccKey(phone) {
  const national = phone.nationalNumber;
  if (phone.countryCallingCode !== '1' || national.length !== 10) return null;
  return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
}

export function fccComplaints(phone) {
  const key = fccKey(phone);
  if (!key) return Promise.resolve(null);
  return once(`fcc:${key}`, async () => {
    const where = `caller_id_number='${key}'`;
    const [totals, byType, byState, advertisers, recent] = await Promise.all([
      request(soql({ $select: 'count(id) as n', $where: where })).then((r) => r.json()),
      request(soql({ $select: 'type_of_call_or_messge, count(id) as n', $where: where, $group: 'type_of_call_or_messge', $order: 'n DESC', $limit: '5' })).then((r) => r.json()),
      request(soql({ $select: 'state, count(id) as n', $where: `${where} and state IS NOT NULL`, $group: 'state', $order: 'n DESC', $limit: '60' })).then((r) => r.json()),
      // Who the caller claimed to be calling for, seen from the other side of the same dataset.
      request(soql({ $select: 'advertiser_business_phone_number, count(id) as n', $where: `${where} and advertiser_business_phone_number NOT IN('None','')`, $group: 'advertiser_business_phone_number', $order: 'n DESC', $limit: '5' })).then((r) => r.json()),
      request(soql({ $select: 'issue_date, state, type_of_call_or_messge', $where: where, $order: 'issue_date DESC', $limit: '5' })).then((r) => r.json())
    ]);
    const total = Number(totals[0]?.n || 0);
    return {
      total,
      key,
      states: byState.length,
      topStates: byState.slice(0, 5).map((row) => `${row.state} (${row.n})`),
      topType: byType[0]?.type_of_call_or_messge || null,
      types: byType.filter((row) => row.type_of_call_or_messge).map((row) => `${row.type_of_call_or_messge} (${row.n})`),
      advertisers: advertisers.map((row) => row.advertiser_business_phone_number),
      recent: recent.map((row) => ({ date: row.issue_date?.slice(0, 10), state: row.state, type: row.type_of_call_or_messge })),
      url: `https://opendata.fcc.gov/resource/vakf-fz8e.json?caller_id_number=${encodeURIComponent(key)}`
    };
  });
}

// Complaints where THIS number is the business being advertised, i.e. other numbers dialling out
// on its behalf. This is what answers "who is the call for" when the caller ID is throwaway.
export function fccAdvertisedBy(phone) {
  const key = fccKey(phone);
  if (!key) return Promise.resolve(null);
  return once(`fccadv:${key}`, async () => {
    const rows = await request(soql({
      $select: 'caller_id_number, count(id) as n',
      $where: `advertiser_business_phone_number='${key}' and caller_id_number NOT IN('None','')`,
      $group: 'caller_id_number', $order: 'n DESC', $limit: '8'
    })).then((r) => r.json());
    return rows.map((row) => ({ number: row.caller_id_number, count: Number(row.n) }));
  });
}

// --- OpenStreetMap via Overpass --------------------------------------------------------------
// Exact-value lookups are indexed and return in about a second. The loose regex fallback must stay
// scoped to a country area; run unscoped it reliably times out on the public server.

// The public instances rate-limit independently and each returns 504 under load, so a failure on
// one is routine rather than fatal. Whichever answers first wins.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

async function overpass(query, timeout = 45000) {
  let lastError;
  for (const endpoint of OVERPASS_MIRRORS) {
    try {
      const response = await request(endpoint, { method: 'POST', body: new URLSearchParams({ data: query }), timeout });
      return (await response.json()).elements || [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No Overpass mirror available');
}

function osmEntry(element) {
  const tags = element.tags || {};
  const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'], tags['addr:state'], tags['addr:postcode']].filter(Boolean).join(' ');
  return {
    source: 'OpenStreetMap',
    name: tags.name || tags.operator || tags.brand || null,
    kind: tags.amenity || tags.shop || tags.office || tags.healthcare || tags.tourism || tags.craft || null,
    address: address || null,
    website: tags.website || tags['contact:website'] || null,
    phone: tags.phone || tags['contact:phone'] || null,
    url: `https://www.openstreetmap.org/${element.type}/${element.id}`
  };
}

export function osmListings(phone) {
  return once(`osm:${phone.number}`, async () => {
    const variants = formatVariants(phone);
    const clauses = variants.flatMap((value) => {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return [`nwr["phone"="${escaped}"];`, `nwr["contact:phone"="${escaped}"];`];
    }).join('');
    const exact = await overpass(`[out:json][timeout:25];(${clauses});out center 10;`, 20000);
    if (exact.length) return exact.map(osmEntry).filter((entry) => entry.name);

    // Nothing matched a known spelling: fall back to a digit-tolerant scan inside the number's own
    // country, which catches unusual punctuation. It is far slower than the indexed lookup above,
    // so it is given a hard ceiling rather than being allowed to hold up the whole report.
    const national = phone.nationalNumber;
    if (!phone.country || national.length < 7) return [];
    const loose = [...national].join('[^0-9]*');
    const scoped = await overpass(
      `[out:json][timeout:40];area["ISO3166-1"="${phone.country}"][admin_level=2]->.a;` +
      `nwr(area.a)[~"^(phone|contact:phone)$"~"${loose}"];out center 10;`,
      35000
    );
    return scoped.map(osmEntry).filter((entry) => entry.name);
  });
}

// --- Wikidata -------------------------------------------------------------------------------
// P1329 is "phone number". Values are written inconsistently, so the filter normalises both sides
// to digits rather than trying to match a spelling.

export function wikidataListings(phone) {
  return once(`wd:${phone.number}`, async () => {
    const national = phone.nationalNumber;
    // Comma-separated: SPARQL's IN takes an expression list. (VALUES uses spaces; they are not
    // interchangeable, and a space-separated list is a parse error, not an empty result.)
    const targets = [`${phone.countryCallingCode}${national}`, national].map((value) => `"${value}"`).join(', ');
    const query = `SELECT ?item ?itemLabel ?phone ?website ?kindLabel WHERE {
      ?item wdt:P1329 ?phone .
      FILTER(REPLACE(?phone, "[^0-9]", "") IN (${targets}))
      OPTIONAL { ?item wdt:P856 ?website . }
      OPTIONAL { ?item wdt:P31 ?kind . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
    } LIMIT 10`;
    const response = await request(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/sparql-results+json' },
      timeout: 40000
    });
    const rows = (await response.json()).results.bindings;
    const seen = new Set();
    return rows.filter((row) => !seen.has(row.item.value) && seen.add(row.item.value)).map((row) => ({
      source: 'Wikidata',
      name: row.itemLabel?.value || null,
      kind: row.kindLabel?.value || null,
      address: null,
      website: row.website?.value || null,
      phone: row.phone?.value || null,
      url: row.item.value
    }));
  });
}

// --- SEC EDGAR full-text search ---------------------------------------------------------------
// efts.sec.gov serves no CORS headers, so this goes through a relay. A hit means the number is
// printed in a public company's filings, which is about as strong an identity confirmation as
// an open dataset can give.

export function secFilings(phone) {
  const national = phone.nationalNumber;
  if (phone.countryCallingCode !== '1' || national.length !== 10) return Promise.resolve([]);
  return once(`sec:${national}`, async () => {
    const dashed = `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
    const text = await viaProxy(`https://efts.sec.gov/LATEST/search-index?q=%22${dashed}%22`);
    const payload = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const buckets = payload?.aggregations?.entity_filter?.buckets || [];
    return buckets.slice(0, 5).map((bucket) => ({
      source: 'SEC EDGAR',
      name: bucket.key.replace(/\s*\(CIK \d+\)\s*$/, '').trim(),
      kind: 'SEC registrant',
      address: null,
      website: null,
      phone: dashed,
      count: bucket.doc_count,
      url: `https://efts.sec.gov/LATEST/search-index?q=%22${dashed}%22`
    }));
  });
}

// --- Caller name (CNAM) -----------------------------------------------------------------------
// freecnam.org exposes an unauthenticated CNAM dip: GET /dip?q=<10 digits>, returning the standard
// 15-character caller-name string carriers show on a handset. This is the most direct answer to
// "who is calling" available without a paid provider.
//
// Two caveats are load-bearing. It serves no CORS headers (an OPTIONS preflight returns 204 with no
// Access-Control-Allow-Origin), so it can only be reached through a relay. And it is a free
// community service with undocumented personal and global rate limits that returns HTTP 500
// "Error: ratelimit or other issue" when it cannot serve a dip, so an unavailable answer is the
// normal case rather than an exceptional one and must never be reported as "no caller name".

const CNAM_NOISE = /^(unknown|unavailable|not ?found|no ?name|error|null|none)$/i;

function readCnam(body) {
  let text = body.trim();
  // r.jina.ai wraps the upstream body in a markdown envelope ("Title:", "URL Source:",
  // "Markdown Content:"). Take what follows the envelope, not the envelope's own first line.
  const wrapped = text.match(/Markdown Content:\s*([\s\S]*)$/i);
  if (wrapped) text = wrapped[1].trim();
  if (/returned error|ratelimit|Warning:|^undefined$/im.test(text)) return null;
  const value = text.split(/\r?\n/)[0].trim();
  if (!value || /<html|^(title|url source):/i.test(value) || value.length > 40) return null;
  if (CNAM_NOISE.test(value)) return null;
  return value;
}

export function callerName(phone) {
  const national = phone.nationalNumber;
  if (phone.countryCallingCode !== '1' || national.length !== 10) return Promise.resolve(null);
  return once(`cnam:${national}`, async () => {
    // Straight to a relay: a direct call is refused by CORS every time, and attempting it only
    // logs a console error per lookup. Revisit if freecnam.org ever sends the header.
    const name = readCnam(await viaProxy(`https://freecnam.org/dip?q=${national}`, { timeout: 25000 }));
    return name ? { name, source: 'FreeCNAM' } : null;
  });
}

// Generic placeholders a carrier returns when no subscriber name is on file. They are still worth
// showing, but they identify a line type rather than a caller.
export const GENERIC_CNAM = /^(wireless caller|cell phone|toll free|payphone|private|anonymous|v(oi)?p)\b/i;

// --- Exchange assignment ----------------------------------------------------------------------
// areacode.fyi republishes the NANPA central-office code assignments as a keyless, CORS-enabled
// JSON API, giving the carrier a block was allocated to, its rate centre and its line type.
//
// It also answers whether the exchange is assigned at all, which is the strongest structural
// spoofing check available: an unassigned exchange has no carrier able to originate a call.
// The two flags must be read together. `covered` reports whether the dataset covers that area code
// and `prefix_found` whether the exchange exists within it, so only covered:true + prefix_found:false
// means "unassigned". Anything else is "unknown" and must not be scored as evidence of spoofing.
//
// localcallingguide.com carries richer LERG data (OCN, LATA, switch CLLI) but serves no CORS
// headers, and every public relay is refused by its origin, so it is not reachable from a static
// site at all. Its absence is why LATA is left blank rather than a proxy being attempted.

export function exchangeRecord(phone) {
  const national = phone.nationalNumber;
  if (phone.countryCallingCode !== '1' || national.length !== 10) return Promise.resolve(null);
  return once(`npanxx:${national.slice(0, 6)}`, async () => {
    const data = await (await request(`https://areacode.fyi/api/v1/carrier/${national}`)).json();
    if (data.covered === true && data.prefix_found === false) {
      return { assigned: false, npa: national.slice(0, 3), nxx: national.slice(3, 6) };
    }
    if (!data.prefix_found) return null;
    return {
      assigned: true,
      npa: data.area_code || national.slice(0, 3),
      nxx: national.slice(3, 6),
      company: data.carrier || null,
      companyType: data.line_type === 'wireless' ? 'W' : data.line_type === 'landline' ? 'I' : null,
      lineType: data.line_type || null,
      rateCenter: data.rate_center || null,
      region: null,
      lata: null,
      asOf: data.data_date || null
    };
  });
}

const CARRIER_TYPES = { I: 'Incumbent local carrier', C: 'Competitive local carrier', W: 'Wireless carrier', P: 'PCS / paging' };
export const carrierTypeName = (code) => CARRIER_TYPES[code] || null;

// --- Bundled prefix metadata (unchanged sources, corrected caching) -----------------------------

export async function prefixMetadata(kind, countryCallingCode, digits) {
  // timezones.bson is a single global file, so it must not be cached per calling code.
  const resource = kind === 'timezone' ? 'timezones.bson' : `${kind}/en/${countryCallingCode}.bson`;
  const data = await once(`meta:${resource}`, async () => {
    // Loaded on demand so the BSON decoder is not in the critical path of a first lookup.
    const [{ deserialize }, response] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/bson@6.10.4/lib/bson.mjs'),
      request(`https://cdn.jsdelivr.net/npm/libphonenumber-geo-carrier@2.0.0/resources/${resource}`)
    ]);
    return deserialize(new Uint8Array(await response.arrayBuffer()));
  });
  let prefix = digits;
  while (prefix.length) {
    if (data[prefix]) return data[prefix];
    prefix = prefix.slice(0, -1);
  }
  return null;
}

export async function areaCodeLocation(phone) {
  if (phone.country !== 'US' && phone.country !== 'CA') return null;
  const country = phone.country.toLowerCase();
  const rows = await once(`area:${country}`, async () => {
    const file = country === 'us' ? 'us-area-code-cities.csv' : 'ca-area-code-cities.csv';
    const response = await request(`https://raw.githubusercontent.com/ravisorg/Area-Code-Geolocation-Database/master/${file}`);
    return (await response.text()).split(/\r?\n/);
  });
  const code = phone.nationalNumber.slice(0, 3);
  const locations = rows.filter((row) => row.startsWith(`${code},`)).slice(0, 5).map((row) => {
    const match = row.match(/^\d{3},(".*?"|[^,]+),(".*?"|[^,]+),/);
    return match ? `${match[1].replaceAll('"', '')}, ${match[2].replaceAll('"', '')}` : null;
  }).filter(Boolean);
  return [...new Set(locations)].join(' / ') || null;
}

export async function nanpTable() {
  // Resolved against this module rather than the page so it works from a project subpath.
  return once('nanp', async () => (await request(new URL('./data/nanp.json', import.meta.url))).json());
}
