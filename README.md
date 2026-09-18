# Number Finder

### ▶︎ **[Open the app → amosroger91.github.io/Number-Finder](https://amosroger91.github.io/Number-Finder/)**

A static, privacy-conscious phone-number intelligence tool. It identifies who a number is *published* as belonging to, scores it for scam risk against federal complaint data, and reports its numbering-plan metadata.

Runs entirely in the browser. No account, no server, no database, no tracking, and **no API keys** — every data source is keyless.

---

## What it can do

- **Identify organisations.** Resolves a number to a business or institution via OpenStreetMap, Wikidata, SEC filings and the carrier caller-name database.
- **Prove some caller IDs are forged.** Unassigned area codes and exchanges, reserved ranges and placeholder digit runs are *conclusive* — no carrier can originate such a call.
- **Detect neighbour spoofing.** Save your own number and any caller ID sharing your exchange is flagged. This is the most common spoofing tactic.
- **Report federal complaint history.** Complaint counts, call types, geographic spread and recency from ~1.8M FCC unwanted-call complaints.
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

### Risk and carrier

| Source | Endpoint | Access | Provides |
| --- | --- | --- | --- |
| **FCC Consumer Complaints** | `opendata.fcc.gov/resource/vakf-fz8e.json` | Direct | ~1.8M unwanted-call complaints (Socrata/SoQL) |
| **areacode.fyi** | `areacode.fyi/api/v1/carrier/<10 digits>` | Direct | NANPA block allocation: carrier, rate centre, line type, **and whether the exchange is assigned at all** |

### Metadata

| Source | Endpoint | Access | Provides |
| --- | --- | --- | --- |
| **libphonenumber-js 1.11.20** | vendored, `vendor/` | None | Parsing, validity, number type, all formats |
| **libphonenumber-geo-carrier** | `cdn.jsdelivr.net/npm/...@2.0.0` | Direct | Geocode and timezone prefix data (BSON) |
| **Area-Code-Geolocation-Database** | `raw.githubusercontent.com/ravisorg/...` | Direct | Area-code geography; build input for `data/nanp.json` |
| **`data/nanp.json`** | bundled, generated | None | 336 NANP area codes for offline structural checks |

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
| Listed in a public registry | −25 | Trust — but withheld once spoofing is proven |

## Architecture

```text
Browser -> index.html -> app.js ---> sources.js -> keyless public APIs
                              \----> risk.js    -> offline scoring
                              \----> data/nanp.json
                              \----> localStorage (recent checks, your own number)
```

`app.js` renders the local parse immediately, then fills each section as sources answer.

## Quick start

```text
python -m http.server 8000
```

Then visit `http://localhost:8000`. Opening `index.html` over `file://` will not work — it is an ES module and fetches `data/nanp.json`.

## GitHub Pages

Push to GitHub, then set **Settings → Pages → Source** to **GitHub Actions**. The included workflow deploys every push to `main`, regenerating `data/nanp.json` first so a newly activated area code is never reported as spoofed.

## Project structure

```text
index.html           Application markup
styles.css           Responsive visual design
app.js               Orchestration, progressive rendering, interaction
sources.js           Keyless external data sources
risk.js              Offline scam scoring
data/nanp.json       Generated area-code table (committed)
data/build-nanp.mjs  Regenerates the table; run by CI on deploy
vendor/              Vendored libphonenumber-js
```

Regenerate the offline table with `node data/build-nanp.mjs`.

## Privacy

- Nothing is sent to any server operated by this project, because there isn't one.
- Your own number is stored in `localStorage` only and is **never transmitted** — it is compared against the looked-up number entirely in the browser.
- Recent searches are local to the browser and can be cleared from the interface.
- The number you look up is necessarily sent to the third-party APIs listed above.
