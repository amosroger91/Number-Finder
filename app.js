// Vendored rather than loaded from a CDN: this is the one dependency the app cannot degrade
// without. An import failure aborts the whole module, so a blocked or unreachable CDN would leave
// a form that silently does nothing, instead of a page that still parses and scores offline.
import { parsePhoneNumberFromString } from './vendor/libphonenumber-js.min.mjs';
import * as sources from './sources.js';
import { assess } from './risk.js';
import { identityConfidence } from './evidence.js';
import { assume, loadAgent } from './agent.js';

const el = (id) => document.querySelector(id);
const form = el('#lookup-form');
const input = el('#phone-input');
const region = el('#region-select');
const results = el('#results');
const errorMessage = el('#error-message');
const resultTitle = el('#result-title');
const resultGrid = el('#result-grid');
const statusBanner = el('#status-banner');
const history = el('#history');
const assumptionCard = el('#assumption-card');
const riskCard = el('#risk-card');
const identityCard = el('#identity-card');
const complaintCard = el('#complaint-card');
const ownNumberInput = el('#own-number');

const historyKey = 'number-finder-history';
const ownKey = 'number-finder-own';

const labels = {
  country: 'Country / region', callingCode: 'Calling code', countryCode: 'Country code', area: 'Numbering area',
  carrier: 'Allocated carrier', carrierKind: 'Block line type', rateCenter: 'Rate center', lata: 'LATA', timezones: 'Likely time zone(s)',
  national: 'National format', international: 'International format', uri: 'Tel URI',
  type: 'Number type', possible: 'Possible length', digits: 'Digits', extension: 'Extension'
};

// Each enrichment source reports its own outcome so the interface can distinguish "checked and
// found nothing" from "could not check". Treating those as the same thing is how a lookup tool
// ends up implying a number is safe when it simply failed to reach a database.
const PENDING = 'pending';
const OK = 'ok';
const EMPTY = 'empty';
const FAILED = 'failed';

let state = null;
let token = 0;

function display(value) {
  return value === undefined || value === null || value === '' ? 'Not available' : value;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

// Only http(s) links are ever rendered: listing URLs come from third-party datasets, and escaping
// alone would not stop a javascript: or data: URL in an href.
function safeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function typeName(type) {
  return ({ MOBILE: 'Mobile', FIXED_LINE: 'Landline', FIXED_LINE_OR_MOBILE: 'Landline or mobile', TOLL_FREE: 'Toll-free', PREMIUM_RATE: 'Premium rate', VOIP: 'VoIP', PAGER: 'Pager', UAN: 'Universal access', VOICEMAIL: 'Voicemail' })[type] || 'Unknown';
}

function areaDescription(phone) {
  if (phone.country === 'US' || phone.country === 'CA') {
    return `NANP area code ${phone.nationalNumber.slice(0, 3)}`;
  }
  return phone.country ? 'Country-level numbering region' : 'Not available';
}

function ownDigits() {
  const parsed = parsePhoneNumberFromString(localStorage.getItem(ownKey) || '', 'US');
  return parsed?.countryCallingCode === '1' ? parsed.nationalNumber : null;
}

// --- Rendering ---------------------------------------------------------------------------------


function renderAssumption() {
  if (!state) return;
  const result = assume(state);
  state.assumption = result;
  const tone = ({ scam: 'danger', company: 'good', person: 'info', unknown: 'info' })[result.kind] || 'info';
  const reasons = result.reasons.length
    ? result.reasons.map((entry) => `<li class="signal signal-${tone}"><strong>${escapeHTML(entry.label)}</strong><span>${escapeHTML(entry.detail)}</span></li>`).join('')
    : '';
  const caveats = result.caveats.map((text) => `<p class="source-note">${escapeHTML(text)}</p>`).join('');
  const name = result.name ? `<p class="confidence-name">${escapeHTML(result.name)}</p>` : '';
  const meter = result.status === 'ok'
    ? `<span class="assumption-confidence">${escapeHTML(result.confidenceLabel)} confidence</span>`
    : '';
  assumptionCard.innerHTML = `
    <div class="assumption-head assumption-${escapeHTML(result.kind)}${result.status === 'failed' ? ' assumption-failed' : ''}">
      <div>
        <p class="coverage-label">Working assumption</p>
        <strong>${escapeHTML(result.headline)}</strong>
      </div>
      ${meter}
    </div>
    ${name}
    <p class="source-note">${escapeHTML(result.detail)}</p>
    ${reasons ? `<ul class="signal-list">${reasons}</ul>` : ''}
    ${caveats}`;
}

function renderRisk() {
  const { phone, digits, nanp, prefix, complaints, ftc, identity, status } = state;
  const verdict = assess({ phone, digits, nanp, ownNumber: ownDigits(), prefix, complaints, ftc, identity: identity?.length ? identity : null });
  state.verdict = verdict;

  const checking = Object.entries(status).filter(([, value]) => value === PENDING).map(([key]) => key);
  const unavailable = Object.entries(status).filter(([, value]) => value === FAILED).map(([key]) => key);
  const signals = verdict.signals.length
    ? verdict.signals.map((signal) => `<li class="signal signal-${signal.level}"><strong>${escapeHTML(signal.label)}</strong><span>${escapeHTML(signal.detail)}</span></li>`).join('')
    : '<li class="signal signal-info"><strong>No risk signals</strong><span>Nothing in the checks below flagged this number.</span></li>';

  riskCard.innerHTML = `
    <div class="risk-head risk-${verdict.band}">
      <div>
        <p class="coverage-label">Risk assessment</p>
        <strong>${escapeHTML(verdict.label)}</strong>
      </div>
      <div class="risk-score" aria-label="Risk score ${verdict.score} out of 100"><span>${verdict.score}</span><small>/100</small></div>
    </div>
    <ul class="signal-list">${signals}</ul>
    ${checking.length ? `<p class="source-note">Still checking: ${escapeHTML(checking.join(', '))}.</p>` : ''}
    ${unavailable.length ? `<p class="source-note warn-note">Could not reach: ${escapeHTML(unavailable.join(', '))}. A number with no result from these is <strong>not</strong> confirmed safe.</p>` : ''}
    <p class="source-note">Scoring is heuristic. Caller ID is trivially forged, so a clean result never proves a call is genuine.</p>`;
}

function identityRow(entry) {
  const url = entry.url ? safeURL(entry.url) : null;
  const site = entry.website ? safeURL(entry.website) : null;
  const meta = [entry.kind, entry.address, entry.phone].filter(Boolean).map(escapeHTML).join(' &middot; ');
  const title = escapeHTML(entry.name || 'Unnamed listing');
  return `<article class="business-result">
    <p class="listing-source">${escapeHTML(entry.source)}${entry.count ? ` &middot; ${entry.count} filing${entry.count === 1 ? '' : 's'}` : ''}</p>
    ${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<strong>${title}</strong>`}
    ${meta ? `<p>${meta}</p>` : ''}
    ${entry.note ? `<p>${escapeHTML(entry.note)}</p>` : ''}
    ${site ? `<p><a href="${escapeHTML(site)}" target="_blank" rel="noopener noreferrer">${escapeHTML(site)}</a></p>` : ''}
  </article>`;
}

function renderIdentity() {
  const { cnam, identity, status } = state;
  const generic = cnam && sources.GENERIC_CNAM.test(cnam.name);
  const cnamBlock = status['caller name'] === PENDING
    ? '<p class="empty-state">Checking the caller-name database…</p>'
    : cnam
      ? `<p class="cnam-value">${escapeHTML(cnam.name)}</p><p class="source-note">${generic
        ? 'This is a generic placeholder the carrier returns when no subscriber name is on file. It describes the line, not the caller.'
        : 'Caller name (CNAM) as carriers would display it. It is set by the line’s own provider and is not independently verified.'}</p>`
      : `<p class="empty-state">${status['caller name'] === FAILED
        ? 'The caller-name service could not be reached, so no name was retrieved. This is not the same as the number having no name.'
        : 'No caller name is published for this number.'}</p>`;

  const listings = identity?.length
    ? identity.map(identityRow).join('')
    : `<p class="empty-state">${status.listings === PENDING ? 'Searching public business registries…' : status.listings === FAILED
      ? 'Registry lookups could not be completed.'
      : 'No public business registry lists this number. Most private and mobile lines are not listed anywhere.'}</p>`;

  // Synthesised across every identity source, because agreement between independent registries is
  // a stronger claim than anything one of them says on its own.
  // Per source, not per group. Grouping hides a partial failure: if SEC answers while OpenStreetMap
  // is down, the group reads OK and the interface would imply every registry was consulted. The
  // confidence a reader places in "one source agreed" depends on knowing the others were asked.
  const confidence = identityConfidence({
    listings: identity || [],
    cnam,
    generic,
    status: {
      OpenStreetMap: state.raw.osm,
      Wikidata: state.raw.wikidata,
      'SEC EDGAR': state.raw.sec,
      'CMS NPPES': state.raw.nppes,
      'caller name': state.raw.cnam
    }
  });
  state.confidence = confidence;
  const FILLED = { confirmed: 5, strong: 4, possible: 2, conflicting: 2, unknown: 0 }[confidence.band];
  const meter = '█'.repeat(FILLED) + '░'.repeat(5 - FILLED);

  identityCard.innerHTML = `
    <div class="confidence-head confidence-${confidence.band}">
      <div>
        <p class="coverage-label">Identity confidence</p>
        <strong>${escapeHTML(confidence.label)}</strong>
      </div>
      <span class="confidence-meter" aria-hidden="true">${meter}</span>
    </div>
    ${confidence.name ? `<p class="confidence-name">${escapeHTML(confidence.name)}</p>` : ''}
    <p class="source-note">${escapeHTML(confidence.detail)}</p>
    ${confidence.agreeing.length ? `<p class="source-note">Agreeing: ${escapeHTML(confidence.agreeing.join(', '))}.</p>` : ''}
    ${confidence.alternatives.length ? `<p class="source-note warn-note">Sources disagree: ${confidence.alternatives.map((alt) => `${escapeHTML(alt.name)} (${escapeHTML(alt.sources.join(', '))})`).join(' · ')}</p>` : ''}
    ${confidence.noMatch.length ? `<p class="source-note">Checked, no match: ${escapeHTML(confidence.noMatch.join(', '))}.</p>` : ''}
    ${confidence.unavailable.length ? `<p class="source-note warn-note">Could not check: ${escapeHTML(confidence.unavailable.join(', '))}.</p>` : ''}
    <div class="business-results-heading listing-heading">
      <p class="coverage-label">Caller name</p>
      <strong>${status['caller name'] === PENDING ? 'Checking' : cnam ? 'Found' : 'None published'}</strong>
    </div>
    ${cnamBlock}
    <div class="business-results-heading listing-heading">
      <p class="coverage-label">Public registry listings</p>
      <strong>${identity?.length ? `${identity.length} match${identity.length === 1 ? '' : 'es'}` : status.listings === PENDING ? 'Searching' : 'None'}</strong>
    </div>
    ${listings}
    <p class="source-note">Sources: FreeCNAM, OpenStreetMap, Wikidata, SEC EDGAR and CMS NPPES. These list organisations, not private individuals.</p>`;
}

// The FTC block is rendered separately from the FCC block and the totals are never added together:
// the same call can be reported to both agencies, and the two corpora cover different periods.
function ftcBlock() {
  const { ftc, ftcWindow, status } = state;
  const heading = (value) => `<div class="business-results-heading listing-heading"><p class="coverage-label">FTC Do Not Call reports</p><strong>${value}</strong></div>`;
  if (status['FTC reports'] === PENDING) return `${heading('Checking')}<p class="empty-state">Looking up FTC reported calls…</p>`;
  if (status['FTC reports'] === FAILED) return `${heading('Unavailable')}<p class="empty-state">The FTC dataset could not be loaded, so recent reporting activity is unknown.</p>`;
  if (!ftc) return `${heading('Not applicable')}<p class="empty-state">This dataset only covers numbers in the North American Numbering Plan.</p>`;

  const window = ftcWindow ? ` covering ${ftcWindow.windowStart} to ${ftcWindow.windowEnd}` : '';
  if (!ftc.total) {
    return `${heading('None on file')}<p class="empty-state">No FTC Do Not Call report names this number in the published window${window}. The window is only a few weeks, so this says nothing about earlier activity.</p>`;
  }
  return `${heading(`${ftc.total} report${ftc.total === 1 ? '' : 's'}`)}
    <dl class="complaint-facts">
      <div><dt>Reports</dt><dd>${ftc.total}</dd></div>
      <div><dt>Robocalls</dt><dd>${ftc.robocalls || 0}</dd></div>
      <div><dt>States</dt><dd>${ftc.states || 'Unknown'}</dd></div>
    </dl>
    ${ftc.subjects?.length ? `<p class="source-note">Reported subjects: ${escapeHTML(ftc.subjects.join(' · '))}.</p>` : ''}
    <p class="source-note">Reported between ${escapeHTML(ftc.first || '?')} and ${escapeHTML(ftc.last || '?')}${window ? `, within a published window${window}` : ''}.</p>`;
}

function renderComplaints() {
  const { complaints, advertisedBy, status } = state;
  if (status['FCC complaints'] === PENDING) {
    complaintCard.innerHTML = `<div class="business-results-heading"><p class="coverage-label">FCC complaint record</p><strong>Checking</strong></div><p class="empty-state">Querying the FCC consumer complaint database…</p>${ftcBlock()}`;
    return;
  }
  if (status['FCC complaints'] === FAILED) {
    complaintCard.innerHTML = `<div class="business-results-heading"><p class="coverage-label">FCC complaint record</p><strong>Unavailable</strong></div><p class="empty-state">The FCC database could not be reached, so the complaint history is unknown.</p>${ftcBlock()}`;
    return;
  }
  if (!complaints) {
    complaintCard.innerHTML = `<div class="business-results-heading"><p class="coverage-label">FCC complaint record</p><strong>Not applicable</strong></div><p class="empty-state">This dataset only covers numbers in the North American Numbering Plan.</p>${ftcBlock()}`;
    return;
  }

  const rows = complaints.total
    ? `<dl class="complaint-facts">
        <div><dt>Complaints filed</dt><dd>${complaints.total}</dd></div>
        <div><dt>States affected</dt><dd>${complaints.states || 'Unknown'}</dd></div>
        <div><dt>Most reported as</dt><dd>${escapeHTML(display(complaints.topType))}</dd></div>
       </dl>
       ${complaints.types.length ? `<p class="source-note">Reported call types: ${escapeHTML(complaints.types.join(', '))}.</p>` : ''}
       ${complaints.topStates.length ? `<p class="source-note">Most complaints from: ${escapeHTML(complaints.topStates.join(', '))}.</p>` : ''}
       ${complaints.recent.length ? `<p class="source-note">Most recent: ${escapeHTML(complaints.recent.map((entry) => `${entry.date}${entry.state ? ` (${entry.state})` : ''}`).join(', '))}.</p>` : ''}`
    : '<p class="empty-state">No consumer has filed an FCC unwanted-call complaint naming this caller ID. Note that complaints are filed against the displayed number, which a spoofer can change at will.</p>';

  const onBehalf = advertisedBy?.length
    ? `<div class="business-results-heading listing-heading"><p class="coverage-label">Calls made on behalf of this number</p><strong>${advertisedBy.length}</strong></div>
       <p class="source-note">Complainants reported these caller IDs as dialling to advertise this number: ${escapeHTML(advertisedBy.map((entry) => `${entry.number} (${entry.count})`).join(', '))}.</p>`
    : '';

  complaintCard.innerHTML = `
    <div class="business-results-heading">
      <p class="coverage-label">FCC complaint record</p>
      <strong>${complaints.total ? `${complaints.total} complaint${complaints.total === 1 ? '' : 's'}` : 'None on file'}</strong>
    </div>
    ${rows}
    ${onBehalf}
    ${ftcBlock()}
    <p class="source-note">Sources: FCC Consumer Complaint Data (dataset vakf-fz8e) and FTC Do Not Call reported calls. Both are unverified consumer reports filed against a caller ID that can be forged, and the two totals are deliberately not added together.</p>`;
}

function renderGrid() {
  const { phone, prefix, geo, timezones, carrier } = state;
  const country = phone.country || 'Unknown';
  const data = {
    country: country === 'Unknown' ? country : new Intl.DisplayNames(['en'], { type: 'region' }).of(country),
    callingCode: `+${phone.countryCallingCode}`,
    countryCode: country,
    area: geo || areaDescription(phone),
    // Both available sources report the carrier a number BLOCK was allocated to, not who carries
    // the number today: after two decades of portability those routinely differ, and no keyless
    // source exposes live routing. The label says "allocated" so the result is not over-read.
    carrier: prefix?.company || carrier || 'Not available',
    carrierKind: prefix?.lineType
      ? `${prefix.lineType[0].toUpperCase()}${prefix.lineType.slice(1)} block`
      : sources.carrierTypeName(prefix?.companyType) || typeName(phone.getType()),
    rateCenter: prefix ? [prefix.rateCenter, prefix.region].filter(Boolean).join(', ') : 'Not available',
    lata: prefix?.lata || 'Not available',
    timezones: timezones || 'Not available',
    national: phone.formatNational(),
    international: phone.formatInternational(),
    uri: phone.getURI(),
    type: typeName(phone.getType()),
    possible: phone.isPossible() ? 'Yes' : 'No',
    digits: phone.nationalNumber,
    extension: phone.ext || 'None'
  };
  state.data = data;
  resultGrid.innerHTML = Object.entries(data).map(([key, value]) => `<dl class="result-item"><dt>${labels[key]}</dt><dd>${escapeHTML(display(value))}</dd></dl>`).join('');
}

function renderAll() {
  renderGrid();
  renderRisk();
  renderIdentity();
  renderAssumption();
  renderComplaints();
}

// --- Lookup ------------------------------------------------------------------------------------

// Several independent sources feed one section of the report, so their outcomes are tracked
// individually and then collapsed. A section counts as reachable if any of its sources answered;
// it is only reported unavailable when every source behind it failed.
const GROUPS = {
  'caller name': ['cnam'],
  listings: ['osm', 'wikidata', 'sec', 'nppes'],
  'FCC complaints': ['fcc', 'fccAdvertisers'],
  'FTC reports': ['ftc'],
  'carrier records': ['exchange']
};

function groupStatus(members) {
  const values = members.map((member) => state.raw[member]);
  if (values.includes(PENDING)) return PENDING;
  if (values.includes(OK)) return OK;
  if (values.every((value) => value === FAILED)) return FAILED;
  return EMPTY;
}

function syncStatus() {
  for (const [group, members] of Object.entries(GROUPS)) state.status[group] = groupStatus(members);
}

// Every source is optional. A rejection marks that source unavailable and leaves the rest of the
// report intact rather than failing the whole lookup.
function track(id, promise, apply) {
  const mine = token;
  return promise.then(
    (value) => {
      if (mine !== token) return;
      state.raw[id] = value && (!Array.isArray(value) || value.length) ? OK : EMPTY;
      apply(value);
    },
    () => {
      if (mine !== token) return;
      state.raw[id] = FAILED;
    }
  ).then(() => {
    if (mine !== token) return;
    syncStatus();
    renderAll();
  });
}

async function lookup(phone) {
  token += 1;
  state = {
    phone,
    digits: phone.nationalNumber,
    nanp: null,
    prefix: null,
    complaints: null,
    advertisedBy: null,
    ftc: null,
    ftcWindow: null,
    identity: [],
    cnam: null,
    geo: null,
    timezones: null,
    carrier: null,
    raw: { cnam: PENDING, osm: PENDING, wikidata: PENDING, sec: PENDING, nppes: PENDING, fcc: PENDING, fccAdvertisers: PENDING, ftc: PENDING, exchange: PENDING },
    status: {}
  };
  syncStatus();

  // The local parse is rendered before any network call so the report is useful immediately and
  // stays useful if every remote source is unreachable.
  resultTitle.textContent = phone.formatInternational();
  statusBanner.classList.toggle('invalid', !phone.isValid());
  statusBanner.textContent = phone.isValid()
    ? 'This number matches a valid numbering pattern.'
    : phone.isPossible()
      ? 'This number is possible, but could not be confirmed as valid.'
      : 'This number does not match a possible numbering pattern.';
  results.hidden = false;
  renderAll();
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  saveHistory(phone);

  const addListings = (value) => { state.identity = [...state.identity, ...(value || [])]; };

  await Promise.all([
    // Offline numbering-plan table: drives the structural spoofing checks with no network at all.
    sources.nanpTable().then((table) => { if (state) state.nanp = table; renderRisk(); }).catch(() => {}),
    track('fcc', sources.fccComplaints(phone), (value) => { state.complaints = value; }),
    track('fccAdvertisers', sources.fccAdvertisedBy(phone), (value) => { state.advertisedBy = value; }),
    track('ftc', sources.ftcReports(phone), (value) => { state.ftc = value; }),
    sources.ftcWindow().then((value) => { if (state) state.ftcWindow = value; }).catch(() => {}),
    track('exchange', sources.exchangeRecord(phone), (value) => { state.prefix = value; }),
    track('cnam', sources.callerName(phone), (value) => { state.cnam = value; }),
    track('osm', sources.osmListings(phone), addListings),
    track('wikidata', sources.wikidataListings(phone), addListings),
    track('sec', sources.secFilings(phone), addListings),
    track('nppes', sources.nppesOrganisations(phone), addListings),
    sources.prefixMetadata('geocodes', phone.countryCallingCode, phone.nationalNumber)
      .then((value) => { if (value) state.geo = value; })
      .catch(() => sources.areaCodeLocation(phone).then((value) => { if (value) state.geo = value; }).catch(() => {})),
    sources.prefixMetadata('timezone', phone.countryCallingCode, phone.number.replace(/^\+/, ''))
      .then((value) => { if (value) state.timezones = Array.isArray(value) ? value.join(', ') : value; }).catch(() => {}),
    sources.prefixMetadata('carrier', phone.countryCallingCode, phone.nationalNumber)
      .then((value) => { if (value) state.carrier = value; }).catch(() => {})
  ]);
  renderAll();
}

// --- History -----------------------------------------------------------------------------------

function saveHistory(phone) {
  // Keyed on E.164 so the same number typed in two formats is one entry.
  const entry = { key: phone.number, input: phone.number, international: phone.formatInternational(), country: phone.country || 'Unknown' };
  const entries = JSON.parse(localStorage.getItem(historyKey) || '[]').filter((item) => (item.key || item.input) !== entry.key);
  entries.unshift(entry);
  localStorage.setItem(historyKey, JSON.stringify(entries.slice(0, 6)));
  renderHistory();
}

function renderHistory() {
  const entries = JSON.parse(localStorage.getItem(historyKey) || '[]');
  history.innerHTML = entries.length
    ? entries.map((entry) => `<button class="history-item" type="button" data-number="${escapeHTML(entry.input)}"><span class="history-number">${escapeHTML(entry.international)}</span><span class="history-region">${escapeHTML(entry.country)}</span></button>`).join('')
    : '<p class="empty-state">Your recent checks will appear here, on this device only.</p>';
}

// --- Events ------------------------------------------------------------------------------------

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  const phone = parsePhoneNumberFromString(input.value, region.value);
  if (!phone) {
    errorMessage.textContent = 'Enter a phone number with enough digits to analyze.';
    errorMessage.hidden = false;
    results.hidden = true;
    return;
  }
  try {
    await lookup(phone);
  } catch (error) {
    errorMessage.textContent = `The lookup could not be completed: ${error.message}`;
    errorMessage.hidden = false;
  }
});

ownNumberInput.value = localStorage.getItem(ownKey) || '';
ownNumberInput.addEventListener('change', () => {
  const value = ownNumberInput.value.trim();
  if (value) localStorage.setItem(ownKey, value); else localStorage.removeItem(ownKey);
  if (state) renderRisk();
});

el('#copy-button').addEventListener('click', async () => {
  if (!state) return;
  const payload = {
    input: state.phone.number,
    ...state.data,
    valid: state.phone.isValid(),
    risk: state.verdict ? { score: state.verdict.score, band: state.verdict.band, signals: state.verdict.signals.map((s) => s.label) } : null,
    callerName: state.cnam?.name || null,
    listings: state.identity,
    identityConfidence: state.confidence ? { band: state.confidence.band, name: state.confidence.name, agreeing: state.confidence.agreeing } : null,
    assumption: state.assumption ? { kind: state.assumption.kind, confidence: state.assumption.confidence, headline: state.assumption.headline, name: state.assumption.name, reasons: state.assumption.reasons.map((entry) => entry.label) } : null,
    fccComplaints: state.complaints,
    ftcReports: state.ftc,
    sourceStatus: state.status
  };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  el('#copy-button').textContent = 'Copied';
  setTimeout(() => { el('#copy-button').textContent = 'Copy JSON'; }, 1500);
});

el('#search-button').addEventListener('click', () => {
  if (!state) return;
  window.open(`https://duckduckgo.com/?q=${encodeURIComponent(`"${state.phone.formatInternational()}"`)}`, '_blank', 'noopener,noreferrer');
});

el('#clear-button').addEventListener('click', () => { results.hidden = true; state = null; token += 1; input.focus(); });
el('#clear-history').addEventListener('click', () => { localStorage.removeItem(historyKey); renderHistory(); });
history.addEventListener('click', (event) => {
  const button = event.target.closest('[data-number]');
  if (button) { input.value = button.dataset.number; form.requestSubmit(); }
});
renderHistory();

loadAgent().then(() => { if (state) renderAll(); });
