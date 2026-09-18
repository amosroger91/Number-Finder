// Builds data/nppes/: healthcare organisations indexed by telephone number.
//
// CMS publishes the full NPPES provider registry as a ~1.1 GB monthly ZIP containing a multi-
// gigabyte CSV. The keyless NPI API cannot search by phone, so reverse lookup requires the bulk
// file, which is far too large either to query live or to commit. It is therefore streamed and
// reduced here, and the shards are published with the site.
//
// Only Entity Type Code 2 -- organisations -- is indexed. Type 1 records are individual
// clinicians, and this project does not identify private individuals. For the same reason the
// "Authorized Official Telephone Number" column is ignored even on organisation records: it is a
// named person's direct line, not the organisation's published number.
//
//   node data/build-nppes.mjs              download the current monthly file and build
//   node data/build-nppes.mjs --resolve    print the current filename (used for the CI cache key)
//   node data/build-nppes.mjs --zip PATH   build from an already-downloaded archive

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const PAGE = 'https://download.cms.gov/nppes/NPI_Files.html';
const BASE = 'https://download.cms.gov/nppes/';
const TAXONOMY = 'https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv';
const AGENT = 'Mozilla/5.0 (compatible; NumberFinder build; +https://github.com/amosroger91/Number-Finder)';
const OUT = new URL('./nppes/', import.meta.url);

// Column positions in npidata_pfile_*.csv, zero-indexed.
const NPI = 0;
const ENTITY_TYPE = 1;
const ORG_NAME = 4;
const MAILING_PHONE = 26;
const PRACTICE_CITY = 30;
const PRACTICE_STATE = 31;
const PRACTICE_PHONE = 34;
const DEACTIVATION_DATE = 39;
const TAXONOMY_CODE = 47;
const LAST_COLUMN = TAXONOMY_CODE;

async function text(url) {
  const response = await fetch(url, { headers: { 'User-Agent': AGENT } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function resolveArchive() {
  const page = await text(PAGE);
  const match = page.match(/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip/);
  if (!match) throw new Error('Could not find the monthly NPPES archive on the CMS download page.');
  return match[0];
}

if (process.argv.includes('--resolve')) {
  console.log(await resolveArchive());
  process.exit(0);
}

// Splits only as far as the last column of interest. The file has well over 300 columns and tens of
// millions of rows, so parsing the whole line would dominate the build.
function fields(line) {
  const out = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= line.length; i += 1) {
    if (out.length > LAST_COLUMN) break;
    const char = line[i];
    if (char === '"') { quoted = !quoted; continue; }
    if (i === line.length || (char === ',' && !quoted)) {
      out.push(line.slice(start, i).replace(/^"|"$/g, ''));
      start = i + 1;
    }
  }
  return out;
}

async function taxonomyNames() {
  try {
    const rows = (await text(TAXONOMY)).split(/\r?\n/).filter(Boolean);
    const header = rows[0].split(',');
    const display = header.indexOf('Display Name');
    const names = new Map();
    for (const row of rows.slice(1)) {
      const parts = (row.match(/("[^"]*"|[^,]*)(,|$)/g) || []).map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, ''));
      if (parts[0] && parts[display]) names.set(parts[0], parts[display]);
    }
    console.log(`taxonomy: ${names.size} codes`);
    return names;
  } catch (error) {
    // A readable specialty is a nicety; losing it must not fail the build.
    console.warn(`taxonomy unavailable (${error.message}); codes will be published as-is`);
    return new Map();
  }
}

const zipArgIndex = process.argv.indexOf('--zip');
let archivePath = zipArgIndex >= 0 ? process.argv[zipArgIndex + 1] : null;
let archiveName = archivePath ? archivePath.split(/[\\/]/).pop() : null;
let downloaded = false;

if (!archivePath) {
  archiveName = await resolveArchive();
  // Staged outside the repository: it is a gigabyte, and anything left under data/ would be
  // swept into the published Pages artifact.
  archivePath = join(tmpdir(), archiveName);
  downloaded = true;
  console.log(`downloading ${archiveName} ...`);
  const response = await fetch(BASE + archiveName, { headers: { 'User-Agent': AGENT } });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));
  console.log(`downloaded ${((await stat(archivePath)).size / 1e6).toFixed(0)} MB`);
}

const names = await taxonomyNames();

// Streamed straight out of the archive. Extracting to disk would need roughly ten gigabytes of
// scratch space, which is more than a hosted runner reliably has.
// UNZIP_BIN exists for Windows, where unzip ships with Git but is not on the PATH Node inherits.
// On a CI runner the bare name resolves.
const unzip = spawn(process.env.UNZIP_BIN || 'unzip', ['-p', archivePath, 'npidata_pfile_*.csv'], { stdio: ['ignore', 'pipe', 'inherit'] });
unzip.on('error', (error) => {
  console.error(`could not run unzip (${error.message}). Set UNZIP_BIN to its full path.`);
  process.exit(1);
});

// Each organisation is held as ONE delimited string rather than an array of five, and city, state
// and specialty are interned. Holding ~1.6M records as separate objects exhausted a default V8
// heap; packing them keeps the whole index in a few hundred megabytes.
const UNIT = String.fromCharCode(31);
const byNumber = new Map();
const overflow = new Map();
const intern = new Map();
const pool = (value) => {
  const existing = intern.get(value);
  if (existing !== undefined) return existing;
  intern.set(value, value);
  return value;
};

let rows = 0;
let orgs = 0;
let indexed = 0;
let headerSeen = false;

function handle(line) {
  if (!headerSeen) { headerSeen = true; return; }
  if (!line) return;
  rows += 1;
  const f = fields(line);
  if (f[ENTITY_TYPE] !== '2') return;
  orgs += 1;
  // A deactivated NPI no longer describes a working organisation.
  if (f[DEACTIVATION_DATE]) return;
  const name = (f[ORG_NAME] || '').trim();
  if (!name) return;
  const raw = (f[PRACTICE_PHONE] || f[MAILING_PHONE] || '').replace(/\D/g, '');
  const digits = raw.length === 11 && raw[0] === '1' ? raw.slice(1) : raw;
  // Registry phone fields carry placeholders such as 0000000000 and 9999999999. Real NANP numbers
  // begin their area code and their exchange with 2-9, which rejects those without a lookup.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return;
  indexed += 1;
  const list = byNumber.get(digits);
  // One switchboard legitimately serves many NPIs; a few are informative, hundreds are not.
  if (list && list.length >= 4) {
    overflow.set(digits, (overflow.get(digits) || 0) + 1);
    return;
  }
  const packed = [
    name,
    f[NPI],
    pool((f[PRACTICE_CITY] || '').trim()),
    pool((f[PRACTICE_STATE] || '').trim()),
    pool(names.get(f[TAXONOMY_CODE]) || f[TAXONOMY_CODE] || '')
  ].join(UNIT);
  if (list) list.push(packed); else byNumber.set(digits, [packed]);
}

unzip.stdout.setEncoding('utf8');
for await (const line of createInterface({ input: unzip.stdout, crlfDelay: Infinity })) {
  handle(line);
}

const code = await new Promise((resolve) => unzip.on('close', resolve));
if (code !== 0) throw new Error(`unzip exited ${code}`);
if (!indexed) throw new Error('No organisation records were indexed; the file layout may have changed.');

// Same shard geometry as the FTC data: area code plus the first digit of the exchange.
const shards = new Map();
for (const [digits, list] of byNumber) {
  const key = digits.slice(0, 4);
  if (!shards.has(key)) shards.set(key, {});
  const rowsOut = list.map((packed) => packed.split(UNIT));
  const more = overflow.get(digits);
  shards.get(key)[digits] = more ? { o: rowsOut, more } : rowsOut;
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
let bytes = 0;
let biggest = 0;
for (const [key, payload] of shards) {
  const json = JSON.stringify(payload);
  bytes += json.length;
  biggest = Math.max(biggest, json.length);
  await mkdir(new URL(`./${key.slice(0, 3)}/`, OUT), { recursive: true });
  await writeFile(new URL(`./${key.slice(0, 3)}/${key[3]}.json`, OUT), json);
}

await writeFile(new URL('./index.json', OUT), JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  archive: archiveName,
  organisations: orgs,
  numbers: byNumber.size,
  shards: shards.size,
  source: 'CMS NPPES (public domain), organisational NPIs only'
}));

if (downloaded) await rm(archivePath, { force: true });

console.log(`rows ${rows} -> ${orgs} organisations, ${indexed} with a usable number -> ${byNumber.size} numbers, ${shards.size} shards, ${(bytes / 1e6).toFixed(1)} MB, largest ${(biggest / 1e3).toFixed(0)} kB`);
