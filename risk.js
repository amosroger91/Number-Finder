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

// Volume on a log scale plus geographic spread: both separate a local nuisance from an industrial
// dialling operation, where one number reaches consumers in dozens of states.
function complaintWeight(total, states, base) {
  const spread = states >= 10 ? 15 : states >= 4 ? 8 : 0;
  return Math.min(78, base + Math.round(Math.log10(total) * 22) + spread);
}

// The two federal complaint systems are scored together on purpose.
//
// They are NOT summed. A consumer who is called may report it to either or both agencies, so the
// totals overlap by an unknown amount and adding them would inflate a single call into two. The
// heavier of the two is scored and the other is reported alongside it.
//
// Appearing in both is treated as its own signal. Two independently collected federal corpora
// naming the same number is stronger evidence than either count on its own, and it is evidence
// that survives the caveat that complaints are filed against a spoofable caller ID.
function complaintSignals(fcc, ftc) {
  const out = [];
  const fccTotal = fcc?.total || 0;
  const ftcTotal = ftc?.total || 0;
  if (!fccTotal && !ftcTotal) return out;

  const fccWeight = fccTotal ? complaintWeight(fccTotal, fcc.states, 12) : 0;
  const ftcWeight = ftcTotal ? complaintWeight(ftcTotal, ftc.states, 14) : 0;
  const scored = Math.max(fccWeight, ftcWeight);

  if (fccTotal) {
    out.push(signal(fccTotal >= 10 ? 'danger' : 'warn', fccWeight >= ftcWeight ? scored : 0,
      `${fccTotal} FCC complaint${fccTotal === 1 ? '' : 's'}`,
      `Filed with the FCC${fcc.states > 1 ? ` from ${fcc.states} states` : ''}${fcc.topType ? `, most often reported as "${fcc.topType.toLowerCase()}"` : ''}. The FCC corpus reaches back years.`));
  }
  if (ftcTotal) {
    const robo = ftc.robocalls || 0;
    out.push(signal(ftcTotal >= 10 ? 'danger' : 'warn', ftcWeight > fccWeight ? scored : 0,
      `${ftcTotal} FTC Do Not Call report${ftcTotal === 1 ? '' : 's'}`,
      `Reported to the FTC${ftc.states > 1 ? ` from ${ftc.states} states` : ''}${robo ? `, ${robo} of them as recorded or robocalls` : ''}${ftc.last ? `, most recently ${ftc.last}` : ''}. These cover only the last few weeks, so this is an actively dialling number.`));
    if (ftc.subjects?.length) {
      out.push(signal('warn', 0, 'Reported subjects', ftc.subjects.join(' · ')));
    }
  }
  if (fccTotal && ftcTotal) {
    out.push(signal('danger', 18, 'Reported to both federal complaint systems',
      'The FCC and the FTC collect complaints independently. A number appearing in both has been reported by separate people through separate channels, which is considerably harder to dismiss than volume in one dataset.'));
  }
  const widest = Math.max(fcc?.states || 0, ftc?.states || 0);
  if (widest >= 10) {
    out.push(signal('danger', 0, 'Nationwide complaint spread', `Reports come from ${widest} states, which is the signature of automated mass dialling rather than a local caller.`));
  }
  if (fcc?.advertisers?.length) {
    out.push(signal('warn', 0, 'Reported as calling on behalf of', fcc.advertisers.join(', ')));
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

export function assess({ phone, digits, nanp, ownNumber, prefix, complaints, ftc, identity }) {
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
    ...complaintSignals(complaints, ftc),
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
