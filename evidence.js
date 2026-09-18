// Identity confidence. Pure, no network.
//
// Each identity source answers independently, and the interesting question is not what any one of
// them said but whether they agree. Four public registries naming the same organisation is a
// qualitatively different claim from one registry containing the number once.
//
// The output is a band, never a percentage. A number like "92% confident" would imply a calibrated
// probability that nothing here can support; the bands say exactly what they are counting.

const BANDS = {
  confirmed: { label: 'Confirmed', detail: 'Three or more independent public registries name the same organisation.' },
  strong: { label: 'Strong', detail: 'Two independent public registries name the same organisation.' },
  possible: { label: 'Possible', detail: 'One public registry contains this number. A single listing can be stale or mistaken.' },
  conflicting: { label: 'Conflicting', detail: 'Sources resolve this number to different organisations. It may have been reassigned, or it may belong to a shared switchboard.' },
  unknown: { label: 'Unknown', detail: 'No identity source matched this number.' }
};

// Legal-form suffixes and filler that differ between registries for the same organisation:
// EDGAR says "WAL MART STORES INC", OSM says "Walmart", Wikidata says "Walmart Inc.".
const NOISE = new Set([
  'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'plc', 'pllc', 'pc', 'sa', 'nv', 'ag', 'gmbh', 'holdings', 'holding', 'group', 'the', 'of', 'and',
  'trust', 'foundation', 'association', 'partnership'
]);

function tokens(name) {
  return new Set(
    String(name)
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')        // ticker symbols and CIK annotations
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((word) => word && !NOISE.has(word))
  );
}

// Two names refer to the same organisation when the smaller significant token set is mostly
// contained in the larger. Subset rather than equality, because registries append and omit words
// ("Walmart" vs "Walmart Supercenter", "Mercy Clinic" vs "Mercy Clinic Fort Smith").
function sameEntity(a, b) {
  const [x, y] = [tokens(a), tokens(b)];
  if (!x.size || !y.size) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];

  // Word-boundary disagreements are common between registries: EDGAR files "WAL MART STORES" while
  // everyone else writes "Walmart". Comparing the despaced forms catches what token overlap cannot.
  const [flatSmall, flatLarge] = [[...small].join(''), [...large].join('')];
  if (flatSmall.length >= 5 && flatLarge.startsWith(flatSmall)) return true;

  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / small.size >= 0.6;
}

// Groups listings that name the same organisation, counting DISTINCT SOURCES rather than listings.
// Five EDGAR filings for one company are one source agreeing, not five.
function cluster(entries) {
  const clusters = [];
  for (const entry of entries) {
    if (!entry.name) continue;
    const match = clusters.find((group) => group.names.some((name) => sameEntity(name, entry.name)));
    const target = match || (clusters.push({ names: [], sources: new Set(), entries: [] }), clusters.at(-1));
    target.names.push(entry.name);
    target.sources.add(entry.source);
    target.entries.push(entry);
  }
  return clusters
    .map((group) => ({
      // The shortest name is usually the canonical one; longer variants carry branch or filing detail.
      name: group.names.slice().sort((a, b) => a.length - b.length)[0],
      sources: [...group.sources],
      entries: group.entries
    }))
    // Most agreeing sources first; ties broken by how many listings back the name, so a company
    // with several filings outranks a one-off entry from the same registry.
    .sort((a, b) => b.sources.length - a.sources.length || b.entries.length - a.entries.length);
}

/**
 * @param listings  identity entries, each { source, name, ... }
 * @param cnam      caller-name result, counted as a source only when it is a real name
 * @param status    per-source outcome map, used to report what could not be checked
 */
export function identityConfidence({ listings = [], cnam = null, generic = false, status = {} } = {}) {
  const entries = [...listings];
  // A generic CNAM ("WIRELESS CALLER") describes the line, not the caller, so it is not evidence
  // of identity and must not count towards agreement.
  if (cnam?.name && !generic) entries.push({ source: 'CNAM', name: cnam.name });

  const clusters = cluster(entries);
  const top = clusters[0];
  const runnerUp = clusters[1];

  // Conflict means independent sources disagree, not that one source listed several names. A single
  // switchboard legitimately appears under many entities -- a corporate number resolves to the
  // company, its foundation and its officers' filings -- and reporting that as a conflict would
  // penalise exactly the large, well-documented organisations the registries describe best.
  const distinctSources = new Set(clusters.flatMap((group) => group.sources)).size;

  let band = 'unknown';
  if (top) {
    if (distinctSources < 2) {
      band = 'possible';
    } else if (top.sources.length >= 2 && (runnerUp?.sources.length || 0) >= 2) {
      band = 'conflicting';
    } else if (top.sources.length >= 3) {
      band = 'confirmed';
    } else if (top.sources.length === 2) {
      band = 'strong';
    } else {
      band = 'conflicting';
    }
  }

  const checked = Object.entries(status);
  return {
    band,
    label: BANDS[band].label,
    detail: BANDS[band].detail,
    name: band === 'conflicting' ? null : top?.name || null,
    agreeing: top ? top.sources : [],
    alternatives: band === 'conflicting' ? clusters.slice(0, 3).map((group) => ({ name: group.name, sources: group.sources })) : [],
    // Kept separate so "searched and found nothing" is never displayed as "could not check".
    noMatch: checked.filter(([, value]) => value === 'empty').map(([key]) => key),
    unavailable: checked.filter(([, value]) => value === 'failed').map(([key]) => key),
    pending: checked.filter(([, value]) => value === 'pending').map(([key]) => key)
  };
}
