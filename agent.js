// WASM kind-assumption host. Builds an integer feature vector from lookup state, runs
// vendor/agent.wasm, and turns the packed result into copy. The agent itself never fetches.

import { GENERIC_CNAM } from './sources.js';

export const KIND = { unknown: 0, person: 1, company: 2, scam: 3 };
export const CONF = { low: 0, medium: 1, high: 2 };
export const CNAM = { none: 0, generic: 1, personal: 2, org: 3 };
export const LINE = { unknown: 0, wireless: 1, landline: 2, voip: 3, tollfree: 4, premium: 5 };
export const ASSIGNED = { unknown: 0, yes: 1, no: 2 };

export const REASON = {
  UNASSIGNED: 1 << 0,
  CONCLUSIVE_SPOOF: 1 << 1,
  PREMIUM: 1 << 2,
  COMPLAINT_MILL: 1 << 3,
  BOTH_FEDERAL: 1 << 4,
  IMPERSONATION: 1 << 5,
  HIGH_RISK: 1 << 6,
  IDENTITY_STRONG: 1 << 7,
  IDENTITY_POSSIBLE: 1 << 8,
  SEC: 1 << 9,
  REGISTRY: 1 << 10,
  CNAM_ORG: 1 << 11,
  TOLL_FREE: 1 << 12,
  WIRELESS: 1 << 13,
  GENERIC_CNAM: 1 << 14,
  PERSONAL_CNAM: 1 << 15
};

const KIND_NAME = ['unknown', 'person', 'company', 'scam'];
const CONF_NAME = ['low', 'medium', 'high'];
const ID_BAND = { unknown: 0, possible: 1, conflicting: 2, strong: 3, confirmed: 4 };

const ORG_WORDS = /\b(inc|incorporated|llc|llp|lp|ltd|limited|corp|corporation|company|plc|bank|hospital|university|school|services|department|dept|church|clinic|group|associates|foundation|trust|partners|holdings|insurance|dental|realty|motors|plumbing|hvac|roofing|solar|legal)\b/i;
const STRUCTURAL_SPOOF = /^(Area code is not in service|Exchange is unassigned|Placeholder digit pattern)$/;

export const FEATURE_ORDER = [
  'identityBand', 'listingCount', 'hasOsm', 'hasWikidata', 'hasSec',
  'cnamKind', 'lineType', 'assigned', 'riskScore', 'conclusiveSpoof',
  'ownNumberForgery', 'neighbourSpoof', 'fccTotal', 'ftcTotal', 'ftcRobocalls',
  'widestStates', 'bothFederal', 'impersonation', 'listingsPending',
  'identityFailed', 'complaintsFailed'
];

function looksOrg(name) {
  return ORG_WORDS.test(name);
}

export function looksPersonal(name) {
  if (!name || GENERIC_CNAM.test(name) || looksOrg(name)) return false;
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  return words.every((word) => /^[A-Za-z][A-Za-z.'-]*$/.test(word) && word.length >= 2 && word.length <= 14);
}

function cnamKind(cnam) {
  if (!cnam?.name) return CNAM.none;
  if (GENERIC_CNAM.test(cnam.name)) return CNAM.generic;
  if (looksOrg(cnam.name)) return CNAM.org;
  if (looksPersonal(cnam.name)) return CNAM.personal;
  return CNAM.none;
}

function lineType(state) {
  const type = state.phone?.getType?.();
  if (type === 'PREMIUM_RATE') return LINE.premium;
  if (type === 'TOLL_FREE') return LINE.tollfree;
  if (type === 'VOIP') return LINE.voip;
  if (type === 'MOBILE' || state.prefix?.lineType === 'wireless' || state.prefix?.companyType === 'W') return LINE.wireless;
  if (type === 'FIXED_LINE' || state.prefix?.lineType === 'landline') return LINE.landline;
  return LINE.unknown;
}

export function extractFeatures(state) {
  const identity = state.identity || [];
  const signals = state.verdict?.signals || [];
  const labels = new Set(signals.map((entry) => entry.label));
  const subjects = state.ftc?.subjects || [];
  return {
    identityBand: ID_BAND[state.confidence?.band] ?? 0,
    listingCount: identity.length,
    hasOsm: identity.some((entry) => entry.source === 'OpenStreetMap') ? 1 : 0,
    hasWikidata: identity.some((entry) => entry.source === 'Wikidata') ? 1 : 0,
    hasSec: identity.some((entry) => entry.source === 'SEC EDGAR') ? 1 : 0,
    cnamKind: cnamKind(state.cnam),
    lineType: lineType(state),
    assigned: state.prefix?.assigned === false ? ASSIGNED.no : state.prefix?.assigned === true ? ASSIGNED.yes : ASSIGNED.unknown,
    riskScore: state.verdict?.score ?? 0,
    conclusiveSpoof: signals.some((entry) => entry.level === 'danger' && entry.weight >= 70 && STRUCTURAL_SPOOF.test(entry.label)) ? 1 : 0,
    ownNumberForgery: labels.has('Your own number is calling you') ? 1 : 0,
    neighbourSpoof: labels.has('Neighbour-spoofing pattern') ? 1 : 0,
    fccTotal: state.complaints?.total || 0,
    ftcTotal: state.ftc?.total || 0,
    ftcRobocalls: state.ftc?.robocalls || 0,
    widestStates: Math.max(state.complaints?.states || 0, state.ftc?.states || 0),
    bothFederal: (state.complaints?.total || 0) && (state.ftc?.total || 0) ? 1 : 0,
    impersonation: subjects.some((subject) => /pretend|impersonat/i.test(subject)) ? 1 : 0,
    listingsPending: state.status?.listings === 'pending' ? 1 : 0,
    identityFailed: state.status?.listings === 'failed' ? 1 : 0,
    complaintsFailed: state.status?.['FCC complaints'] === 'failed' && state.status?.['FTC reports'] === 'failed' ? 1 : 0
  };
}

export function featureArgs(features) {
  return FEATURE_ORDER.map((key) => features[key] | 0);
}

export function unpack(packed) {
  const kind = packed & 0xff;
  const confidence = (packed >> 8) & 0xff;
  return {
    kind,
    kindName: KIND_NAME[kind] || 'unknown',
    confidence,
    confidenceName: CONF_NAME[confidence] || 'low',
    reasons: (packed >> 16) & 0xffff
  };
}

const REASON_COPY = [
  [REASON.UNASSIGNED, 'Unassigned exchange', 'No carrier holds this exchange, so the caller ID is not a real assignment.'],
  [REASON.CONCLUSIVE_SPOOF, 'Conclusive spoofing pattern', 'The numbering plan itself rules this caller ID out as a genuine origin.'],
  [REASON.PREMIUM, 'Premium-rate number', 'Calling back bills the caller at a premium rate.'],
  [REASON.COMPLAINT_MILL, 'Heavy complaint volume', 'Federal complaint systems name this caller ID often enough to look like a dialling operation.'],
  [REASON.BOTH_FEDERAL, 'Named by both FCC and FTC', 'Two independently collected federal corpora list this number.'],
  [REASON.IMPERSONATION, 'Reported as impersonation', 'FTC subjects include calls pretending to be someone else.'],
  [REASON.HIGH_RISK, 'High risk score', 'The offline risk engine landed in the top band for reasons other than a neighbour-spoof of a real line.'],
  [REASON.IDENTITY_STRONG, 'Independent registries agree', 'Two or more public registries name the same organisation.'],
  [REASON.IDENTITY_POSSIBLE, 'One public registry listing', 'A single business registry contains this number.'],
  [REASON.SEC, 'SEC EDGAR filing', 'The number is printed in a public-company filing.'],
  [REASON.REGISTRY, 'Public registry listing', 'OpenStreetMap, Wikidata or another business registry lists this number.'],
  [REASON.CNAM_ORG, 'Caller name looks organisational', 'The CNAM string carries a legal-form or institution word.'],
  [REASON.TOLL_FREE, 'Toll-free number', 'Toll-free codes are typically business or call-centre assignments.'],
  [REASON.WIRELESS, 'Wireless / mobile block', 'The allocated block is wireless, which is how most personal lines are numbered.'],
  [REASON.GENERIC_CNAM, 'Generic caller name', 'The carrier returned a placeholder such as WIRELESS CALLER, which describes the line, not a business.'],
  [REASON.PERSONAL_CNAM, 'Caller name looks personal', 'The CNAM string is shaped like a personal name. That is not an identification of the subscriber.']
];

const KIND_COPY = {
  company: { label: 'Company', detail: 'Public records point at a published organisation.' },
  person: { label: 'Likely personal line', detail: 'This looks like a personal or mobile subscriber line, not a published organisation.' },
  scam: { label: 'Scam indicators', detail: 'The number itself looks like a scam line rather than a published person or company.' },
  unknown: { label: 'Unknown', detail: 'Not enough independent signal to assume a kind.' }
};

const CONF_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

let classifyFn = null;
let loadError = null;
let loadPromise = null;

export function loadAgent() {
  if (!loadPromise) {
    loadPromise = (async () => {
      const url = new URL('./vendor/agent.wasm', import.meta.url);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
      if (typeof instance.exports.classify !== 'function') throw new Error('agent.wasm has no classify export');
      classifyFn = instance.exports.classify;
    })().catch((error) => {
      loadError = error;
      classifyFn = null;
    });
  }
  return loadPromise;
}

export function agentStatus() {
  if (classifyFn) return 'ready';
  if (loadError) return 'failed';
  return 'pending';
}

export function bindClassify(fn) {
  classifyFn = fn;
  loadError = null;
  loadPromise = Promise.resolve();
}

export function decide(features, impl) {
  const fn = impl || classifyFn;
  if (!fn) return null;
  return unpack(fn(...featureArgs(features)));
}

export function assume(state, impl) {
  const status = impl ? 'ready' : agentStatus();
  if (status === 'pending') {
    return {
      status: 'pending', kind: 'unknown', confidence: 'low', reasons: [], caveats: [],
      name: null, headline: 'Checking', detail: 'Loading the local classifier…', pending: true
    };
  }
  if (status === 'failed') {
    return {
      status: 'failed', kind: 'unknown', confidence: 'low', reasons: [], caveats: [],
      name: null, headline: 'Unavailable',
      detail: 'The local classifier could not be loaded, so no kind assumption is offered.', pending: false
    };
  }
  const features = extractFeatures(state);
  const result = decide(features, impl);
  const kind = result.kindName;
  const copy = KIND_COPY[kind];
  const reasons = REASON_COPY
    .filter(([bit]) => result.reasons & bit)
    .map(([, label, detail]) => ({ label, detail }));
  const caveats = ['This is a working assumption from public metadata, not a determination.'];
  if (kind === 'person') caveats.push('This is not an identification of the subscriber. Most personal lines appear in no public dataset.');
  if (kind === 'scam') caveats.push('Complaints are filed against a spoofable caller ID, so they describe the displayed number.');
  if (features.listingsPending) caveats.push('Public registries are still being checked, so this may change.');
  if (state.status?.listings === 'failed') caveats.push('Could not check public business registries.');
  if (state.status?.['FCC complaints'] === 'failed' || state.status?.['FTC reports'] === 'failed') {
    caveats.push('One or more complaint sources could not be reached.');
  }
  return {
    status: 'ok',
    kind,
    confidence: result.confidenceName,
    confidenceLabel: CONF_LABEL[result.confidenceName],
    reasons,
    caveats,
    name: kind === 'company' ? (state.confidence?.name || null) : null,
    headline: copy.label,
    detail: copy.detail,
    pending: features.listingsPending === 1,
    features
  };
}