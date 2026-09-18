# Number Finder

### ▶︎ **[Open the app → amosroger91.github.io/Number-Finder](https://amosroger91.github.io/Number-Finder/)**

A static, privacy-conscious phone-number intelligence tool. It identifies who a number is *published* as belonging to, scores it for scam risk against federal complaint data, and reports its numbering-plan metadata.

Runs entirely in the browser. No account, no server, no database, no tracking, and **no API keys** — every data source is keyless.

---

## What it can do

- **Identify organisations.** Resolves a number to a business or institution via OpenStreetMap, Wikidata, SEC filings, the national healthcare provider registry, and the carrier caller-name database.
- **Prove some caller IDs are forged.** Unassigned area codes and exchanges, reserved ranges and placeholder digit runs are *conclusive* — no carrier can originate such a call.
- **Detect neighbour spoofing.** Save your own number and any caller ID sharing your exchange is flagged. This is the most common spoofing tactic.
- **Report federal complaint history from two independent systems.** ~1.8M FCC unwanted-call complaints reaching back years, plus FTC Do Not Call reports covering the last few weeks. A number appearing in **both** is called out as its own signal.
- **Synthesise identity across sources.** Rather than listing what each registry said, it reports whether they *agree*, in explainable bands (Confirmed / Strong / Possible / Conflicting / Unknown) that count distinct sources, never a fabricated percentage.
- **Answer "on behalf of who".** The FCC dataset records the business a complainant said a call was made *for*, queried in both directions.
- **Work offline.** Parsing, formatting and all structural spoof checks run with no network at all. A verdict is always produced.
- **Tell you what it couldn't check.** Every source reports separately, so "checked and found nothing" is never conflated with "could not reach the database".

## What it cannot do

- **Identify a private individual.** Registry lookups cover organisations. Most personal and mobile lines appear in no public dataset. This is a deliberate limit, not a gap to be filled.
- **Tell you who is actually calling.** Caller ID is trivially forged. Every result describes the *number displayed*, not the person dialling.
- **Give you the current carrier.** Both carrier sources report the block a number was *allocated* to. After two decades of portability that is routinely not who carries it today, and no keyless source exposes live routing.
- **Prove a number is safe.** A clean result is an absence of evidence. Most fraud comes from numbers with no history at all, because they are discarded within days.
- **Cover the world equally.** Complaint data, carrier data, SEC filings and CNAM are all US/NANP-only. Non-NANP numbers get parsing, formatting, geography, timezone, OpenStreetMap and Wikidata.
- **Show crowdsourced reputation.** Sites like 800notes block every relay a static site could use (see below).
- **Return a legally usable answer.** Nothing here is suitable for FCRA decisions, employment, credit or tenancy screening.

---

## APIs and data sources

**Direct** means the origin sends `Access-Control-Allow-Origin` and the browser calls it straight from GitHub Pages. **Relayed** means it sends no CORS headers and must go through a public proxy.

### Identity

| Source | Endpoint | Access | Provides |
| --- | --- | --- | --- |
| **FreeCNAM** | `freecnam.org/dip?q=<10 digits>` | Relayed | Caller name (CNAM), the 15-character string carriers display on a handset |
| **Overpass / OpenStreetMap** | `overpass-api.de/api/interpreter` (+2 mirrors) | Direct | Business name, address, website, category |
| **Wikidata** | `query.wikidata.org/sparql` | Direct | Organisations via property `P1329`, plus website (`P856`) and type (`P31`) |
| **SEC EDGAR** | `efts.sec.gov/LATEST/search-index` | Relayed | Public companies and registrants whose filings print the number |
| **CMS NPPES** | `download.cms.gov/nppes/` | Build-time | ~1.97M healthcare organisations: practice name, NPI, city/state, specialty |

### Risk and carrier

| Source | Endpoint | Access | Provides |
| --- | --- | --- | --- |
| **FCC Consumer Complaints** | `opendata.fcc.gov/resource/vakf-fz8e.json` | Direct | ~1.8M unwanted-call complaints (Socrata/SoQL), reaching back years |
| **FTC Do Not Call reports** | `search.ftc.gov/.../DNC_Complaint_Numbers_*.csv` | Build-time | Daily reported-call files: originating number, robocall flag, subject, consumer state |
| **areacode.fyi** | `areacode.fyi/api/v1/carrier/<10 digits>` | Direct | NANPA block allocation: carrier, rate centre, line type, **and whether the exchange is assigned at all** |

### Metadata

| Source | Endpoint | Access | Provides |
| --- | --- | --- | --- |
| **libphonenumber-js 1.11.20** | vendored, `vendor/` | None | Parsing, validity, number type, all formats |
| **libphonenumber-geo-carrier** | `cdn.jsdelivr.net/npm/...@2.0.0` | Direct | Geocode and timezone prefix data (BSON) |
| **Area-Code-Geolocation-Database** | `raw.githubusercontent.com/ravisorg/...` | Direct | Area-code geography; build input for `data/nanp.json` |
| **`data/nanp.json`** | bundled, generated | None | 336 NANP area codes for offline structural checks |
| **`data/ftc/`** | generated in CI | None | ~264k numbers sharded by NPA + exchange digit |
| **`data/nppes/`** | generated in CI | None | 1.45M numbers across 4,162 shards (191 MB) |

Relays used for the two CORS-less sources: `r.jina.ai`, then `api.allorigins.win`.

---

### Notes on each source

**FCC Consumer Complaints (`vakf-fz8e`)** — the backbone of scam detection. Keyless, CORS-enabled, refreshed daily (97,679 complaints filed in 2026 to date). `caller_id_number` is the number that called; `advertiser_business_phone_number` is the business the complainant said the call was for. Six aggregate queries run per lookup (totals, call types, states, advertisers, recency, and the reverse "who dialled for this number" lookup).

*Limits:* NANP only — numbers are stored as `NNN-NNN-NNNN`. Placeholder values are extremely common (`None` appears in ~556k rows, empty in ~186k). Complaints are unverified consumer reports filed against a **spoofable** caller ID, so they describe the displayed number, not a confirmed originator.

**areacode.fyi** — republishes NANPA central-office code assignments as keyless JSON (data current to 2026-09-13). Also supplies the strongest structural spoof check. Its two flags must be read together: only `covered: true` **and** `prefix_found: false` means unassigned. `covered: false` (toll-free, or an area code outside the dataset) and a null response both mean *unknown* and are never scored as evidence.

**Overpass / OpenStreetMap** — matched by exact tag value across ~20 spellings of the number. Sampling 400 real US `phone` tags showed this covers **99.8%** of them, which is why no fuzzy fallback is used: a digit-tolerant regex scan would have rescued 1 listing while adding 28–45s to every lookup of a number absent from OSM.

*Reliability:* the primary instance returns **504 or 429 under load roughly half the time**, and the two alternates have been measured at over two minutes. Requests are hedged across all three plus a retry of the primary, giving **~67% success in 1–6s**; the rest fail cleanly at ~27s and are reported as unreachable.

**Wikidata** — `P1329` values are written inconsistently (`+1 (310) 825-1071`, `+1 212 854 3902`, `+1 212-854-3105`), so the filter normalises both sides to digits rather than matching a spelling. Typically ~4s. Requires a `User-Agent`, which browsers send automatically.

**SEC EDGAR** — full-text search over filings; a hit is about the strongest identity confirmation an open dataset can give. Returns registrant names with filing counts. Public companies only, NANP only. **Caveat:** placeholder numbers such as `123-456-7890` genuinely appear in real filings, which is why registry listings can never offset conclusive spoofing evidence in the score.

**FreeCNAM** — the most direct answer to "who is calling" available without a paid provider. **Currently returning HTTP 500 `Error: ratelimit or other issue` for every number**, including through unrelated proxy IPs, which suggests an upstream outage rather than local rate-limiting. It is wired up and will populate if the service recovers; until then it reports *unavailable*, never "no name". It has undocumented personal and global rate limits and serves no CORS headers.

**FTC Do Not Call reports** — the FTC publishes one CSV per business day (~12,400 rows) listing every reported call. **94% carry a usable 10-digit originating number**, against roughly 40% for the FCC feed, and ~70% are flagged as recorded or robocalls. The subject taxonomy is genuinely useful, including an explicit *"calls pretending to be government, businesses, or family and friends"* category.

The files serve **no CORS headers**, and the official `api.ftc.gov` endpoint requires an API key — and returned visibly misaligned fields when tested — so neither can be queried from the browser. Instead `data/build-ftc.mjs` folds the published window into static shards at build time: currently 27 days, 322,876 reports, 263,501 distinct numbers, ~30 MB across 3,899 shards with the largest at 295 kB.

*This is a recency signal, not a history.* The published window is about five weeks, so the two federal datasets answer different questions — the FCC's top robocaller in this repo's tests (715 complaints, last active 2021) does not appear in the FTC window at all. **The totals are never added together**: a consumer may report the same call to both agencies, so summing would double-count. The heavier of the two is scored, the other is shown beside it, and appearing in both is its own signal.

**CMS NPPES** — the national provider registry, published as a **1.08 GB monthly ZIP** containing a multi-gigabyte CSV of ~330 columns. The keyless NPI API cannot search by phone number, so reverse lookup requires the bulk file, which is too large to query live and far too large to commit. `data/build-nppes.mjs` streams it (`unzip -p` piped into a parser that splits only as far as the last column of interest, never extracting the CSV to disk, which would need ~10 GB of scratch space) and reduces it to the same shard geometry as the FTC data: **9.8M rows to 1,972,058 organisations and 1,449,025 distinct numbers, 191 MB across 4,162 shards** (median 16 kB, largest 515 kB). The build takes about 130 seconds on a hosted runner, then comes from cache.

**Only Entity Type 2 — organisations — is indexed.** Type 1 records are individual clinicians, and this project does not identify private individuals. For the same reason the *Authorized Official Telephone Number* column is skipped even on organisation records: it is a named person's direct line, not the organisation's published number. Deactivated NPIs are dropped, and registry placeholders like `0000000000` are rejected by NANP structural rules.

Because the archive is ~1.1 GB, CI caches the result on **the archive's own filename** rather than a date — CMS publishes mid-month, so a calendar-month key would keep serving the previous file for a fortnight after a new one appeared. Taxonomy codes are resolved to readable specialties via the NUCC crosswalk (884 codes); if that fetch fails the raw code is published instead rather than failing the build.

**libphonenumber-geo-carrier** — note that `carrier/en/1.bson` contains only 696 keys, all Caribbean NANP. There is **no US/Canada carrier data** in this dataset, which is why areacode.fyi is required. Geocode keys omit the country code (`479273` → `Bentonville, AR`); `timezones.bson` is one global file. The BSON decoder is loaded lazily.

**libphonenumber-js is vendored, not loaded from a CDN.** It is the one dependency that cannot degrade: an ES module import failure aborts the whole script, so a blocked or unreachable CDN would leave a form that silently does nothing instead of a page that still parses and scores offline.

---

### Sources evaluated and rejected

Documented so they are not re-attempted:

| Source | Why not |
| --- | --- |
| **localcallingguide.com** | Richer LERG data (OCN, LATA, switch CLLI) but no CORS, and its origin refuses every public relay tested (HTTP 522). This is why the LATA field stays blank. |
| **800notes, whocalled.us** | Crowdsourced reputation, but they block datacenter IP ranges (403 through relays), so unreachable from any static site. |
| **DuckDuckGo Instant Answer** | Returns nothing at all for phone numbers. The old "Find business" button could only ever render an empty state; removed. |
| **BulkVS open CNAM** | Returns HTTP 422 for every number, including valid ones. |
| **tellows** | The documented demo key returns the HTML homepage, not JSON. |
| **corsproxy.io** | Now key-gated (HTTP 401). |
| **nationalnanpa.com** | Bulk NANPA files are unreachable; `data/nanp.json` is built from an open mirror instead. |

Relays are third-party free tiers with no availability guarantee. A relay failure is always reported as **unknown**, never as a clean result.

---

## Scam scoring

`risk.js` is pure and never touches the network, so a verdict is always produced. Signals are weighted and summed, then clamped to 0–100:

| Score | Band |
| --- | --- |
| 70–100 | High risk |
| 40–69 | Elevated risk |
| 15–39 | Some caution |
| 0–14 | No risk signals found |

Any single conclusive signal reaches 70 on its own, so proven forgery always lands in the top band.

| Signal | Weight | Basis |
| --- | --- | --- |
| Your own number is calling you | 75 | Conclusive forgery |
| Area code not in service | 70 | Conclusive |
| Exchange unassigned | 70 | Conclusive |
| Placeholder digit pattern | 70 | Conclusive |
| FCC complaints | up to 78 | Scaled by log volume, plus geographic spread |
| Neighbour-spoofing pattern | 40 | Shares your full exchange |
| Premium rate | 45 | Return-call billing fraud |
| Reserved range / 555 / repeated NPA | 20–30 | Structural |
| VoIP, toll-free, competitive carrier | 5–8 | Weak context, not accusations |
| FTC Do Not Call reports | up to 78 | Scaled by volume and spread; **max** with FCC, never summed |
| Reported to both federal systems | 18 | Two independently collected corpora naming the same number |
| Listed in a public registry | −25 | Trust — but withheld once spoofing is proven |

## Identity confidence

`evidence.js` is pure and has no network dependency. It groups every identity result by the
organisation named, tolerating the spelling differences between registries (EDGAR files
`WAL MART STORES INC`, OpenStreetMap says `Walmart Supercenter`, Wikidata says `Walmart`), then
counts **distinct sources** — five EDGAR filings for one company are one source agreeing, not five.

| Band | Meaning |
| --- | --- |
| **Confirmed** | Three or more independent registries name the same organisation |
| **Strong** | Two independent registries agree |
| **Possible** | One registry contains the number |
| **Conflicting** | Independent sources resolve the number to different organisations |
| **Unknown** | No identity source matched |

Two deliberate rules. A *generic* CNAM such as `WIRELESS CALLER` describes the line rather than the
caller, so it never counts towards agreement. And one source listing several related entities is not
a conflict: a corporate switchboard legitimately resolves to the company, its foundation and its
officers' filings, and calling that "conflicting" would penalise exactly the large, well-documented
organisations the registries describe best. Conflict requires *independent sources* to disagree.

## Architecture

```text
Browser -> index.html -> app.js ---> sources.js  -> keyless public APIs
                              \----> risk.js     -> offline scam scoring
                              \----> evidence.js -> identity confidence
                              \----> data/nanp.json, data/ftc/  (generated)
                              \----> localStorage (recent checks, your own number)
```

Bulk datasets too large to track in git are generated by CI **straight into the Pages artifact**, so the repository stays small and its history is not rewritten on every deploy. They are listed in `.gitignore`; if a build step fails the site still deploys and reports that source as unavailable.

`app.js` renders the local parse immediately, then fills each section as sources answer.

## Quick start

```text
python -m http.server 8000
```

Then visit `http://localhost:8000`. Opening `index.html` over `file://` will not work — it is an ES module and fetches `data/nanp.json`.

## GitHub Pages

Set **Settings → Pages → Source** to **GitHub Actions** — not "Deploy from a branch".

This is load-bearing and fails silently if you get it wrong. With a branch source, Pages serves the
committed tree and **ignores the workflow artifact entirely**, while the workflow still reports a
green tick on every run. Everything keeps working right up until a build step generates a file that
is not committed — `data/ftc/` — which then 404s in production with nothing in the logs to explain
it. The API tells you which mode you are in:

```text
GET /repos/{owner}/{repo}/pages   ->   "build_type": "workflow"   (correct)
                                       "build_type": "legacy"     (serving the branch)
```

The workflow deploys every push to `main`, regenerating `data/nanp.json` and `data/ftc/` first.

## Project structure

```text
index.html           Application markup
styles.css           Responsive visual design
app.js               Orchestration, progressive rendering, interaction
sources.js           Keyless external data sources
risk.js              Offline scam scoring
evidence.js          Identity confidence across sources
data/nanp.json       Generated area-code table (committed)
data/build-nanp.mjs  Regenerates the table; run by CI on deploy
data/build-ftc.mjs   Builds FTC complaint shards; run by CI on deploy
data/build-nppes.mjs Builds NPPES organisation shards; cached monthly in CI
data/ftc/            Generated FTC shards (gitignored, published by CI)
data/nppes/          Generated NPPES shards (gitignored, published by CI)
vendor/              Vendored libphonenumber-js
```

Regenerate the offline table with `node data/build-nanp.mjs`.

## Evaluated but not yet implemented

Measured, viable, and deliberately deferred rather than forgotten:

| Source | Size / shape | What it would add |
| --- | --- | --- |
| **IRS Form 990** | XML corpus, per-year | Nonprofits, foundations, churches and universities — the whole sector SEC EDGAR misses. Form 990 carries the organisation's public telephone number. |
| **FCC ULS** | Bulk licence files | Broadcasters, telecom and public-safety licensees. Contains individuals as well, so the same organisation-only filter would apply. |
| **NANPA (official)** | `reports.nanpa.com` ZIPs | `data/nanp.json` is currently built from an open mirror. The official site is reachable at **nanpa.com** (the older `nationalnanpa.com` is not, which is why an earlier attempt failed), so CI could prefer NANPA and fall back to the mirror. |

All four are CI-preprocessing jobs of the same shape as `build-ftc.mjs`: too large to query live, too
large to commit, so they would be generated into the Pages artifact and sharded for lookup.

## Privacy

- Nothing is sent to any server operated by this project, because there isn't one.
- Your own number is stored in `localStorage` only and is **never transmitted** — it is compared against the looked-up number entirely in the browser.
- Recent searches are local to the browser and can be cleared from the interface.
- The number you look up is necessarily sent to the third-party APIs listed above.
