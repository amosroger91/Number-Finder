// Builds data/ftc/: FTC Do Not Call complaints, aggregated per originating number.
//
// The FTC publishes one CSV per business day listing every reported call, keyed on the number that
// called. Unlike the FCC dataset this is not queryable over the network -- the files serve no CORS
// headers, and the official api.ftc.gov endpoint requires an API key -- so the corpus is folded
// into static shards here and served alongside the site.
//
// The published window is rolling (about five weeks), which makes this a RECENCY signal rather
// than a history: a number appearing here was reported in the last few weeks, whereas the FCC
// dataset reaches back years. The two answer different questions and are never summed.
//
// Run with `node data/build-ftc.mjs`. CI re-runs it on every deploy.

import { mkdir, writeFile, rm } from 'node:fs/promises';

const INDEX = 'https://search.ftc.gov/policy-notices/open-government/data-sets/do-not-call-data';
const FILES = 'https://search.ftc.gov/sites/default/files/';
const AGENT = 'Mozilla/5.0 (compatible; NumberFinder build; +https://github.com/amosroger91/Number-Finder)';
const OUT = new URL('./ftc/', import.meta.url);

async function text(url) {
  const response = await fetch(url, { headers: { 'User-Agent': AGENT } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

// Splits a CSV row, honouring the quoted fields the subject column uses for its commas.
function fields(row) {
  return (row.match(/("[^"]*"|[^,]*)(,|$)/g) || []).map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').trim());
}

const days = [...new Set((await text(INDEX)).match(/DNC_Complaint_Numbers_[\d-]+\.csv/g) || [])].sort();
if (!days.length) throw new Error('No daily complaint files found; the FTC page layout may have changed.');
console.log(`${days.length} daily files: ${days[0]} .. ${days.at(-1)}`);

const byNumber = new Map();
let rows = 0;
let skipped = 0;

for (const day of days) {
  let body;
  try {
    body = await text(FILES + day);
  } catch (error) {
    // One missing day must not fail the build; the window is wide enough to absorb it.
    console.warn(`  skip ${day}: ${error.message}`);
    continue;
  }
  for (const line of body.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const [number, , violation, , state, , subject, robocall] = fields(line);
    rows += 1;
    // Roughly 6% of reports carry no usable originating number; they cannot be attributed.
    if (!/^\d{10}$/.test(number)) { skipped += 1; continue; }
    let entry = byNumber.get(number);
    if (!entry) {
      entry = { n: 0, r: 0, subjects: new Map(), states: new Set(), first: null, last: null };
      byNumber.set(number, entry);
    }
    entry.n += 1;
    if (robocall === 'Y') entry.r += 1;
    if (subject && subject !== 'No Subject Provided') entry.subjects.set(subject, (entry.subjects.get(subject) || 0) + 1);
    if (state) entry.states.add(state);
    const date = (violation || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      if (!entry.first || date < entry.first) entry.first = date;
      if (!entry.last || date > entry.last) entry.last = date;
    }
  }
}

// Sharded on area code plus the first digit of the exchange. Area code alone leaves the toll-free
// ranges close to a megabyte, because one 8xx number can attract thousands of reports; this keeps
// the file a lookup actually downloads to roughly a hundred kilobytes.
const shards = new Map();
for (const [number, entry] of byNumber) {
  const key = number.slice(0, 4);
  if (!shards.has(key)) shards.set(key, {});
  shards.get(key)[number] = {
    n: entry.n,
    r: entry.r,
    s: [...entry.subjects].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([subject]) => subject),
    st: entry.states.size,
    first: entry.first,
    last: entry.last
  };
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
  windowStart: days[0].match(/[\d-]{10}/)[0],
  windowEnd: days.at(-1).match(/[\d-]{10}/)[0],
  days: days.length,
  reports: rows,
  numbers: byNumber.size,
  shards: shards.size,
  source: 'FTC Do Not Call reported calls (public domain)'
}));

console.log(`rows ${rows} (${skipped} without a usable number) -> ${byNumber.size} numbers, ${shards.size} shards, ${(bytes / 1e6).toFixed(1)} MB total, largest shard ${(biggest / 1e3).toFixed(0)} kB`);
