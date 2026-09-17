# Number Finder

A privacy-conscious, static phone-number intelligence tool for quick formatting, validation, and numbering-plan metadata.

## Overview

Number Finder runs entirely in the browser and is suitable for GitHub Pages. It parses numbers with Google's open-source libphonenumber metadata, showing country, calling code, formats, number type, and validity. It does not attempt to identify a private person, expose a caller's location, or send numbers to a private lookup service.

## Architecture

```text
Browser -> index.html -> app.js -> libphonenumber-js CDN
                    \-> localStorage (optional recent searches)
```

There is no server, database, build pipeline, or API key.

## Quick start

Open `index.html` in a browser, or serve the folder with any static web server:

```text
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## GitHub Pages

Push the repository to GitHub, then enable **Settings → Pages → GitHub Actions** as the source. The included workflow deploys every push to `main`.

## Configuration

No configuration is required. There are no secrets or environment variables.

## Usage

Enter a phone number with a country calling code, or select a likely region before entering a national-format number. The app reports local numbering-plan metadata and lets you copy a JSON result.

## Project structure

```text
index.html  Application markup
styles.css  Responsive visual design
app.js      Browser-only parsing and interaction logic
```

## Tech stack

- HTML, CSS, and modern browser JavaScript
- `libphonenumber-js` loaded from jsDelivr
- GitHub Pages-compatible static hosting

## Notes / conventions

- No secrets belong in this repository.
- Recent searches are stored only in the browser's local storage and can be cleared from the interface.
- A static site cannot securely use a paid reverse-lookup API. Add a backend only after selecting a lawful provider and defining its privacy policy.
