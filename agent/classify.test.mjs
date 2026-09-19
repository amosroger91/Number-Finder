import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  assume, bindClassify, decide, extractFeatures, looksPersonal, unpack,
  ASSIGNED, CNAM, CONF, KIND, LINE
} from '../agent.js';

function zeros(overrides = {}) {
  return {
    identityBand: 0,
    listingCount: 0,
    hasOsm: 0,
    hasWikidata: 0,
    hasSec: 0,
    cnamKind: CNAM.none,
    lineType: LINE.unknown,
    assigned: ASSIGNED.unknown,
    riskScore: 0,
    conclusiveSpoof: 0,
    ownNumberForgery: 0,
    neighbourSpoof: 0,
    fccTotal: 0,
    ftcTotal: 0,
    ftcRobocalls: 0,
    widestStates: 0,
    bothFederal: 0,
    impersonation: 0,
    listingsPending: 0,
    identityFailed: 0,
    complaintsFailed: 0,
    ...overrides
  };
}

const wasmPath = fileURLToPath(new URL('../vendor/agent.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath));
const classify = instance.exports.classify;
bindClassify(classify);

function label(features) {
  const result = decide(features, classify);
  return { kind: result.kindName, confidence: result.confidenceName };
}

const cases = [
  {
    name: 'three registries name one org, no complaints',
    features: zeros({ identityBand: 4, listingCount: 3, hasOsm: 1, hasWikidata: 1, hasSec: 1 }),
    kind: 'company', confidence: 'high'
  },
  {
    name: 'single OSM shop listing, no CNAM',
    features: zeros({ identityBand: 1, listingCount: 1, hasOsm: 1 }),
    kind: 'company', confidence: 'medium'
  },
  {
    name: 'SEC listing plus 50 FCC complaints, no spoof stays company',
    features: zeros({ identityBand: 3, listingCount: 1, hasSec: 1, fccTotal: 50, widestStates: 8, riskScore: 56 }),
    kind: 'company', confidence: 'high'
  },
  {
    name: 'unassigned exchange is scam',
    features: zeros({ assigned: ASSIGNED.no, conclusiveSpoof: 1, riskScore: 70 }),
    kind: 'scam', confidence: 'high'
  },
  {
    name: 'placeholder digit pattern is scam',
    features: zeros({ conclusiveSpoof: 1, riskScore: 70 }),
    kind: 'scam', confidence: 'high'
  },
  {
    name: '120 FCC complaints from 31 states, no identity',
    features: zeros({ fccTotal: 120, widestStates: 31, riskScore: 70 }),
    kind: 'scam', confidence: 'high'
  },
  {
    name: 'FTC impersonation subject plus volume, no identity',
    features: zeros({ ftcTotal: 4, impersonation: 1 }),
    kind: 'scam', confidence: 'high'
  },
  {
    name: 'premium-rate type is scam',
    features: zeros({ lineType: LINE.premium, riskScore: 45 }),
    kind: 'scam', confidence: 'medium'
  },
  {
    name: 'wireless block, generic CNAM, listings settled empty',
    features: zeros({ lineType: LINE.wireless, cnamKind: CNAM.generic }),
    kind: 'person', confidence: 'high'
  },
  {
    name: 'personal-shaped CNAM, no listings, landline',
    features: zeros({ lineType: LINE.landline, cnamKind: CNAM.personal }),
    kind: 'person', confidence: 'low'
  },
  {
    name: 'own number calling you, otherwise empty, is not scam',
    features: zeros({ ownNumberForgery: 1, riskScore: 75 }),
    kind: 'unknown', confidence: 'low'
  },
  {
    name: 'neighbour-spoof only is not scam',
    features: zeros({ neighbourSpoof: 1, riskScore: 40 }),
    kind: 'unknown', confidence: 'low'
  },
  {
    name: 'conflicting OSM vs SEC names',
    features: zeros({ identityBand: 2, listingCount: 2, hasOsm: 1, hasSec: 1 }),
    kind: 'unknown', confidence: 'low'
  },
  {
    name: 'identity sources failed, valid wireless, no CNAM',
    features: zeros({ lineType: LINE.wireless, identityFailed: 1 }),
    kind: 'unknown', confidence: 'low'
  },
  {
    name: 'listings still pending, wireless, no CNAM',
    features: zeros({ lineType: LINE.wireless, listingsPending: 1 }),
    kind: 'person', confidence: 'low'
  },
  {
    name: 'toll-free, org-shaped CNAM, no listings',
    features: zeros({ lineType: LINE.tollfree, cnamKind: CNAM.org }),
    kind: 'company', confidence: 'low'
  },
  {
    name: 'VoIP, nothing else',
    features: zeros({ lineType: LINE.voip }),
    kind: 'unknown', confidence: 'low'
  },
  {
    name: 'confirmed company plus unassigned exchange is still scam',
    features: zeros({ identityBand: 4, listingCount: 3, hasOsm: 1, hasSec: 1, assigned: ASSIGNED.no, conclusiveSpoof: 1 }),
    kind: 'scam', confidence: 'high'
  },
  {
    name: 'own number plus wireless is person, not scam',
    features: zeros({ ownNumberForgery: 1, riskScore: 75, lineType: LINE.wireless, cnamKind: CNAM.generic }),
    kind: 'person', confidence: 'high'
  }
];

for (const entry of cases) {
  test(entry.name, () => {
    const got = label(entry.features);
    assert.equal(got.kind, entry.kind);
    assert.equal(got.confidence, entry.confidence);
  });
}

test('unpack round-trips kind and confidence', () => {
  const packed = classify(...Object.values(zeros({ identityBand: 4, listingCount: 3, hasOsm: 1 })));
  const result = unpack(packed);
  assert.equal(result.kind, KIND.company);
  assert.equal(result.confidence, CONF.high);
});

test('looksPersonal accepts ALL CAPS two-word names and rejects org words', () => {
  assert.equal(looksPersonal('JOHN SMITH'), true);
  assert.equal(looksPersonal('Jane Doe'), true);
  assert.equal(looksPersonal('ACME INC'), false);
  assert.equal(looksPersonal('WIRELESS CALLER'), false);
  assert.equal(looksPersonal('BOB'), false);
});

test('extractFeatures maps registry sources and generic CNAM', () => {
  const features = extractFeatures({
    identity: [
      { source: 'OpenStreetMap', name: 'Walmart' },
      { source: 'SEC EDGAR', name: 'WAL MART STORES INC' }
    ],
    cnam: { name: 'WIRELESS CALLER' },
    confidence: { band: 'strong', name: 'Walmart' },
    prefix: { assigned: true, lineType: 'wireless' },
    verdict: { score: 0, signals: [] },
    complaints: { total: 0, states: 0 },
    ftc: { total: 0, subjects: [] },
    status: { listings: 'ok' },
    phone: { getType: () => 'MOBILE' }
  });
  assert.equal(features.hasOsm, 1);
  assert.equal(features.hasSec, 1);
  assert.equal(features.cnamKind, CNAM.generic);
  assert.equal(features.lineType, LINE.wireless);
  assert.equal(features.identityBand, 3);
});

test('assume returns company copy for a confirmed org', () => {
  const result = assume({
    identity: [
      { source: 'OpenStreetMap', name: 'Walmart' },
      { source: 'Wikidata', name: 'Walmart' },
      { source: 'SEC EDGAR', name: 'WAL MART STORES INC' }
    ],
    confidence: { band: 'confirmed', name: 'Walmart' },
    verdict: { score: 0, signals: [] },
    status: {},
    phone: { getType: () => 'FIXED_LINE' }
  }, classify);
  assert.equal(result.kind, 'company');
  assert.equal(result.headline, 'Company');
  assert.equal(result.name, 'Walmart');
  assert.ok(result.reasons.length > 0);
});