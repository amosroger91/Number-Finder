import { parsePhoneNumberFromString } from 'https://cdn.jsdelivr.net/npm/libphonenumber-js@1.11.20/+esm';
import { deserialize } from 'https://cdn.jsdelivr.net/npm/bson@6.10.4/lib/bson.mjs';

const form = document.querySelector('#lookup-form');
const input = document.querySelector('#phone-input');
const region = document.querySelector('#region-select');
const results = document.querySelector('#results');
const errorMessage = document.querySelector('#error-message');
const resultTitle = document.querySelector('#result-title');
const resultGrid = document.querySelector('#result-grid');
const statusBanner = document.querySelector('#status-banner');
const history = document.querySelector('#history');
const historyKey = 'number-finder-history';
let currentResult = null;
const metadataCache = new Map();

const labels = {
  country: 'Country / region', callingCode: 'Calling code', countryCode: 'Country code', area: 'Numbering area', carrier: 'Original carrier', timezones: 'Likely time zone(s)',
  national: 'National format', international: 'International format', uri: 'Tel URI',
  type: 'Number type', possible: 'Possible length', digits: 'Digits', extension: 'Extension'
};

function display(value) {
  return value === undefined || value === null || value === '' ? 'Not available' : value;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character]);
}

function typeName(type) {
  return ({ MOBILE: 'Mobile', FIXED_LINE: 'Landline', FIXED_LINE_OR_MOBILE: 'Landline or mobile', TOLL_FREE: 'Toll-free', PREMIUM_RATE: 'Premium rate', VOIP: 'VoIP', PAGER: 'Pager', UAN: 'Universal access', VOICEMAIL: 'Voicemail' })[type] || 'Unknown';
}

function areaDescription(phone) {
  if (phone.country === 'US' || phone.country === 'CA') {
    return `NANP area code ${phone.nationalNumber.slice(0, 3)} (original assignment)`;
  }
  return phone.country ? 'Country-level numbering region' : 'Not available';
}

async function prefixMetadata(kind, countryCallingCode, digits) {
  const cacheKey = `${kind}:${countryCallingCode}`;
  let data = metadataCache.get(cacheKey);
  if (!data) {
    const resource = kind === 'timezone' ? 'timezones.bson' : `${kind}/en/${countryCallingCode}.bson`;
    const response = await fetch(`https://cdn.jsdelivr.net/npm/libphonenumber-geo-carrier@2.0.0/resources/${resource}`);
    if (!response.ok) return null;
    data = deserialize(new Uint8Array(await response.arrayBuffer()));
    metadataCache.set(cacheKey, data);
  }
  let prefix = digits;
  while (prefix.length) {
    if (data[prefix]) return data[prefix];
    prefix = prefix.slice(0, -1);
  }
  return null;
}

async function renderResult(phone) {
  const country = phone.country || 'Unknown';
  const [originalCarrier, numberingArea, timezones] = await Promise.all([
    prefixMetadata('carrier', phone.countryCallingCode, phone.nationalNumber).catch(() => null),
    prefixMetadata('geocodes', phone.countryCallingCode, phone.nationalNumber).catch(() => null),
    prefixMetadata('timezone', phone.countryCallingCode, phone.number.replace(/^\+/, '')).catch(() => null)
  ]);
  const data = {
    country: country === 'Unknown' ? country : new Intl.DisplayNames(['en'], { type: 'region' }).of(country),
    callingCode: `+${phone.countryCallingCode}`,
    countryCode: country,
    area: numberingArea || areaDescription(phone),
    carrier: originalCarrier || 'Not available in prefix metadata',
    timezones: timezones || 'Not available in prefix metadata',
    national: phone.formatNational(),
    international: phone.formatInternational(),
    uri: phone.getURI(),
    type: typeName(phone.getType()),
    possible: phone.isPossible() ? 'Yes' : 'No',
    digits: phone.nationalNumber,
    extension: phone.ext || 'None'
  };
  currentResult = { input: input.value.trim(), ...data, valid: phone.isValid() };
  resultTitle.textContent = data.international;
  statusBanner.classList.toggle('invalid', !phone.isValid());
  statusBanner.textContent = phone.isValid() ? 'This number matches a valid numbering pattern.' : phone.isPossible() ? 'This number is possible, but could not be confirmed as valid.' : 'This number does not match a possible numbering pattern.';
  resultGrid.innerHTML = Object.entries(data).map(([key, value]) => `<dl class="result-item"><dt>${labels[key]}</dt><dd>${escapeHTML(display(value))}</dd></dl>`).join('');
  results.hidden = false;
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  saveHistory(currentResult);
}

function saveHistory(item) {
  const entries = JSON.parse(localStorage.getItem(historyKey) || '[]').filter((entry) => entry.input !== item.input);
  entries.unshift({ input: item.input, international: item.international, country: item.country });
  localStorage.setItem(historyKey, JSON.stringify(entries.slice(0, 5)));
  renderHistory();
}

function renderHistory() {
  const entries = JSON.parse(localStorage.getItem(historyKey) || '[]');
  history.innerHTML = entries.length ? entries.map((entry) => `<button class="history-item" type="button" data-number="${escapeHTML(entry.input)}"><span class="history-number">${escapeHTML(entry.international)}</span><span class="history-region">${escapeHTML(entry.country)}</span></button>`).join('') : '<p class="empty-state">Your recent checks will appear here, on this device only.</p>';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  try {
    const phone = parsePhoneNumberFromString(input.value, region.value);
    if (!phone) throw new Error('Enter a phone number with enough digits to analyze.');
    await renderResult(phone);
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
    results.hidden = true;
  }
});

document.querySelector('#copy-button').addEventListener('click', async () => {
  if (!currentResult) return;
  await navigator.clipboard.writeText(JSON.stringify(currentResult, null, 2));
  document.querySelector('#copy-button').textContent = 'Copied';
  setTimeout(() => { document.querySelector('#copy-button').textContent = 'Copy JSON'; }, 1500);
});

document.querySelector('#search-button').addEventListener('click', () => {
  if (!currentResult) return;
  const query = encodeURIComponent(`"${currentResult.international}"`);
  window.open(`https://duckduckgo.com/?q=${query}`, '_blank', 'noopener,noreferrer');
});

document.querySelector('#clear-button').addEventListener('click', () => { results.hidden = true; input.focus(); });
document.querySelector('#clear-history').addEventListener('click', () => { localStorage.removeItem(historyKey); renderHistory(); });
history.addEventListener('click', (event) => { const button = event.target.closest('[data-number]'); if (button) { input.value = button.dataset.number; form.requestSubmit(); } });
renderHistory();
