# Number Finder

A privacy-conscious, static phone-number intelligence tool. It identifies who a number is published as belonging to, scores it for scam risk against public complaint data, and reports its numbering-plan metadata.

## Overview

Number Finder runs entirely in the browser and is suitable for GitHub Pages. There is no server, no database, no build pipeline for the app itself, and no API key anywhere — every data source is keyless and either CORS-enabled or routed through a public relay.

It does not identify private individuals. Registry lookups cover organisations, and caller ID is trivially forged, so every result describes the *number displayed*, not the person dialling.

## Architecture

```text
Browser -> index.html -> app.js ---> sources.js -> keyless public APIs
                              \----> risk.js    -> offline scoring
                              \----> data/nanp.json (offline area-code table)
                              \----> localStorage (recent checks, your own number)
```

`app.js` renders the local parse immediately, then fills each section as remote sources answer, so the report is useful at once and stays useful if every network call fails.

## Data sources

All keyless. "Direct" means the origin sends `Access-Control-Allow-Origin` and the browser can call it without a relay.

| Source | Access | Provides |
| --- | --- | --- |
| [libphonenumber-js](https://www.npmjs.com/package/libphonenumber-js) | Direct (CDN) | Parsing, validity, formats, number type |
| [FCC Consumer Complaints](https://opendata.fcc.gov/resource/vakf-fz8e.json) (`vakf-fz8e`) | Direct | ~1.8M unwanted-call complaints, refreshed daily. Complaint counts, call types, geographic spread, and the business a call was reportedly made *on behalf of* |
| [areacode.fyi](https://areacode.fyi) | Direct | NANPA block allocation: carrier, rate centre, line type, and whether the exchange is assigned at all |
| [Overpass / OpenStreetMap](https://overpass-api.de) | Direct | Business listings by phone tag: name, address, website |
| [Wikidata](https://query.wikidata.org) | Direct | Organisations with a published phone number (property `P1329`) |
| [SEC EDGAR full-text search](https://efts.sec.gov) | Via relay | Public companies whose filings print the number |
| [FreeCNAM](https://freecnam.org) | Via relay | Caller name (CNAM) as carriers display it |
| [Area-Code-Geolocation-Database](https://github.com/ravisorg/Area-Code-Geolocation-Database) | Direct | Area-code geography, and the build input for `data/nanp.json` |

### Sources deliberately not used

- **localcallingguide.com** has richer LERG data (OCN, LATA, switch CLLI) but serves no CORS headers, and its origin refuses every public relay tested (HTTP 522). This is why the LATA field is usually blank rather than proxied.
- **Crowdsourced reputation sites** (800notes, whocalled.us) block datacenter IP ranges, so they are unreachable through any relay a static site could use.
- **DuckDuckGo Instant Answer API** returns nothing for phone numbers; the previous "Find business" button could only ever render an empty state, and has been removed.

Relayed sources use `r.jina.ai` and `api.allorigins.win`. These are third-party free tiers with no availability guarantee, so a failure is reported as **unknown**, never as a clean result.

## Scam scoring

`risk.js` is pure and never touches the network, so a verdict is always produced even fully offline. Signals include:

- **Neighbour spoofing** — if you save your own number, a caller ID sharing your exchange is flagged. This is the most common spoofing tactic. Your number is stored only in `localStorage` and is never transmitted.
- **Structural impossibility** — unassigned area codes, unassigned exchanges, reserved ranges, 555 exchanges and placeholder digit runs. These are conclusive: no carrier can originate such a call.
- **FCC complaint volume and spread** — complaints across many states indicate automated mass dialling rather than a local nuisance.
- **Registry listings** — a public business listing lowers the score, but never offsets conclusive spoofing evidence, since placeholder numbers appear in real filings and a spoofer can display any listed number.

A clean result is an absence of evidence, not a safety rating: most fraud comes from numbers with no history, because they are discarded within days.

## Quick start

```text
python -m http.server 8000
```

Then visit `http://localhost:8000`. Opening `index.html` directly with `file://` will not work, because the app is an ES module and fetches `data/nanp.json`.

## GitHub Pages

Push to GitHub, then set **Settings → Pages → Source** to **GitHub Actions**. The included workflow deploys every push to `main` and refreshes `data/nanp.json` first.

## Configuration

None. There are no secrets or environment variables.

## Project structure

```text
index.html          Application markup
styles.css          Responsive visual design
app.js              Orchestration, progressive rendering, interaction
sources.js          Keyless external data sources
risk.js             Offline scam scoring
data/nanp.json      Generated area-code table (committed)
data/build-nanp.mjs Regenerates the table; run by CI on deploy
```

Regenerate the offline table with `node data/build-nanp.mjs`.

## Notes / conventions

- No secrets belong in this repository.
- Recent searches and your saved number are stored only in the browser and can be cleared from the interface.
- Every remote lookup distinguishes "checked and found nothing" from "could not check"; the interface reports which sources were unreachable.
