// Scam scoring. Every signal here is derived from data already fetched elsewhere, so the engine
// itself never touches the network and always produces a verdict, even fully offline.

const BANDS = [
  { min: 70, band: 'critical', label: 'High risk' },
  { min: 40, band: 'elevated', label: 'Elevated risk' },
  { min: 15, band: 'caution', label: 'Some caution' },
  { min: -Infinity, band: 'clear', label: 'No risk signals found' }
];

function signal(level, weight, label, detail) {
  return { level, weight, label, detail };
}

// The classic neighbour spoof: a scammer forges a caller ID sharing your own exchange so the number
// looks like a neighbour or a local school. Requires the user to have saved their own number.
function spoofSignals(digits, own) {
  if (!own || own.length !== 10 || digits.length !== 10) return [];
  if (digits === own) {
    return [signal('danger', 75, 'Your own number is calling you', 'Caller ID shows your own number. No carrier will originate a call from your number to you, so this is forged.')];
  }
  if (digits.slice(0, 6) === own.slice(0, 6)) {
    return [signal('danger', 40, 'Neighbour-spoofing pattern', `Shares your full exchange (${digits.slice(0, 3)}-${digits.slice(3, 6)}). Matching the first six digits of the person being called is the most common caller-ID spoofing tactic.`)];
  }
  if (digits.slice(0, 3) === own.slice(0, 3)) {
    return [signal('info', 5, 'Same area code as you', 'Shares your area code. Normal for genuine local calls, and also the weakest form of spoofing.')];
  }
  return [];
}

// Structural checks against the published North American numbering plan.
function nanpSignals(phone, digits, nanp) {
  // Keyed on the calling code, not the resolved country: libphonenumber cannot name a country for
  // a number whose area code does not exist, which is exactly the case these checks must catch.
  if (!nanp || phone.countryCallingCode !== '1' || digits.length !== 10) return [];
  const npa = digits.slice(0, 3);
  const nxx = digits.slice(3, 6);
  const out = [];
  if (nanp.reserved[npa]) {
    out.push(signal('warn', 30, 'Reserved numbering range', `${npa} is reserved for ${nanp.reserved[npa].toLowerCase()}, not ordinary subscriber lines.`));
  } else if (nanp.tollFree.includes(npa)) {
    out.push(signal('info', 5, 'Toll-free number', 'Toll-free codes are legitimate, but they are cheap to rent in bulk and are heavily used by call centres, including fraudulent ones.'));
  } else if (!nanp.npa[npa]) {
    out.push(signal('danger', 70, 'Area code is not in service', `${npa} is not an assigned geographic area code. A call cannot legitimately originate from it, so the caller ID is forged.`));
  }
  if (npa === nxx) {
    out.push(signal('warn', 20, 'Exchange repeats the area code', `${npa}-${nxx} is a pattern that fabricated caller IDs fall into far more often than real assignments.`));
  }
  if (nxx.startsWith('555')) {
    out.push(signal('warn', 25, 'Fictional 555 exchange', 'The 555 exchange is reserved for directory assistance and fictional use in media.'));
  }
  if (/^(\d)\1{9}$/.test(digits) || digits === '0123456789') {
    out.push(signal('danger', 70, 'Placeholder digit pattern', 'The number is a repeated or sequential digit run, which is a placeholder rather than a real assignment.'));
  }
  return out;
}

// Prefix records come from LERG-derived exchange data. A missing record is strong evidence the
// caller ID was invented, because an unassigned exchange has no carrier able to originate a call.
function prefixSignals(prefix) {
  if (!prefix) return [];
  if (prefix.assigned === false) {
    return [signal('danger', 70, 'Exchange is unassigned', `No carrier holds ${prefix.npa}-${prefix.nxx}. Since no operator can originate calls from an unassigned exchange, this caller ID is spoofed.`)];
  }
  const out = [];
  if (prefix.companyType === 'W') {
    out.push(signal('info', 0, 'Wireless block', `${prefix.company} holds this thousands-block as a wireless assignment.`));
  }
  if (prefix.companyType === 'C') {
    out.push(signal('info', 5, 'Competitive carrier block', `${prefix.company} is a competitive carrier. Numbering from resellers and VoIP providers is easier to acquire in bulk than incumbent numbering.`));
  }
  return out;
}

// FCC consumer complaints: unverified, but volume and geographic spread separate a local nuisance
// from an industrial robocall operation.
function complaintSignals(complaints) {
  if (!complaints || complaints.total === 0) return [];
  const { total, states, topType, advertisers } = complaints;
  const spread = states >= 10 ? 15 : states >= 4 ? 8 : 0;
  const weight = Math.min(78, 12 + Math.round(Math.log10(total) * 22) + spread);
  const out = [signal(total >= 10 ? 'danger' : 'warn', weight,
    `${total} FCC complaint${total === 1 ? '' : 's'}`,
    `Filed with the FCC by consumers${states > 1 ? ` across ${states} states` : ''}${topType ? `, most often reported as "${topType.toLowerCase()}"` : ''}.`)];
  if (states >= 10) {
    out.push(signal('danger', 0, 'Nationwide complaint spread', `Complaints come from ${states} states, which is the signature of automated mass dialling rather than a local caller.`));
  }
  if (advertisers?.length) {
    out.push(signal('warn', 0, 'Reported as calling on behalf of', advertisers.join(', ')));
  }
  return out;
}

// A confirmed listing in a public registry is the one thing that argues a number is genuine.
function identitySignals(identity) {
  if (!identity?.length) return [];
  const names = [...new Set(identity.map((entry) => entry.name).filter(Boolean))].slice(0, 3);
  if (!names.length) return [];
  return [signal('good', -25, 'Listed in a public registry', `Published as a contact number for ${names.join(', ')}. A number appearing in open business records is far less likely to be a throwaway used for fraud.`)];
}

export function assess({ phone, digits, nanp, ownNumber, prefix, complaints, identity }) {
  const signals = [];
  if (phone && !phone.isPossible()) {
    signals.push(signal('danger', 40, 'Not a possible number', 'The digit count does not fit any published numbering plan for this country.'));
  } else if (phone && !phone.isValid()) {
    signals.push(signal('warn', 20, 'Does not match a valid pattern', 'The length is plausible but the number does not match an allocated range.'));
  }
  if (phone?.getType() === 'PREMIUM_RATE') {
    signals.push(signal('danger', 45, 'Premium-rate number', 'Calling back bills the caller at a premium rate. Return-call billing fraud depends on people dialling these numbers.'));
  }
  if (phone?.getType() === 'VOIP') {
    signals.push(signal('info', 8, 'VoIP number', 'VoIP numbers are legitimate and widespread, and are also the cheapest numbering for a fraudulent operation to obtain and discard.'));
  }
  signals.push(
    ...spoofSignals(digits, ownNumber),
    ...nanpSignals(phone, digits, nanp),
    ...prefixSignals(prefix),
    ...complaintSignals(complaints),
    ...identitySignals(identity)
  );

  // A registry listing argues a number is genuine, but it cannot outweigh proof that the caller ID
  // is forged: placeholder numbers like 123-456-7890 appear in real filings, and a spoofer can
  // display any listed number they like. Trust credit is withheld once spoofing is established.
  const proven = signals.some((entry) => entry.level === 'danger' && entry.weight >= 70);
  const score = Math.max(0, Math.min(100, signals.reduce((total, entry) => total + (proven && entry.weight < 0 ? 0 : entry.weight), 0)));
  const { band, label } = BANDS.find((entry) => score >= entry.min);
  const order = { danger: 0, warn: 1, good: 2, info: 3 };
  return { score, band, label, signals: signals.sort((a, b) => order[a.level] - order[b.level] || b.weight - a.weight) };
}
