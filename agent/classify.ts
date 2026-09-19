// Kind-assumption agent. Integer features in, packed i32 out. No strings, no network.
//
// Packed result: kind in bits 0-7, confidence in 8-15, reason mask in 16-31.

import {
  KIND_UNKNOWN, KIND_PERSON, KIND_COMPANY, KIND_SCAM,
  CONF_LOW, CONF_MEDIUM, CONF_HIGH,
  ID_POSSIBLE, ID_CONFLICTING, ID_STRONG, ID_CONFIRMED,
  CNAM_GENERIC, CNAM_PERSONAL, CNAM_ORG,
  LINE_WIRELESS, LINE_TOLLFREE, LINE_PREMIUM,
  ASSIGNED_NO,
  R_UNASSIGNED, R_CONCLUSIVE_SPOOF, R_PREMIUM, R_COMPLAINT_MILL, R_BOTH_FEDERAL,
  R_IMPERSONATION, R_HIGH_RISK, R_IDENTITY_STRONG, R_IDENTITY_POSSIBLE, R_SEC,
  R_REGISTRY, R_CNAM_ORG, R_TOLL_FREE, R_WIRELESS, R_GENERIC_CNAM, R_PERSONAL_CNAM
} from './features';

function pack(kind: i32, conf: i32, reasons: i32): i32 {
  return kind | (conf << 8) | (reasons << 16);
}

function collectReasons(
  identityBand: i32, listingCount: i32, hasOsm: i32, hasWikidata: i32, hasSec: i32,
  cnamKind: i32, lineType: i32, assigned: i32, riskScore: i32, conclusiveSpoof: i32,
  fccTotal: i32, ftcTotal: i32, bothFederal: i32, impersonation: i32
): i32 {
  let reasons: i32 = 0;
  if (assigned == ASSIGNED_NO) reasons |= R_UNASSIGNED;
  if (conclusiveSpoof) reasons |= R_CONCLUSIVE_SPOOF;
  if (lineType == LINE_PREMIUM) reasons |= R_PREMIUM;
  if (fccTotal >= 10 || ftcTotal >= 10) reasons |= R_COMPLAINT_MILL;
  if (bothFederal) reasons |= R_BOTH_FEDERAL;
  if (impersonation && (fccTotal > 0 || ftcTotal > 0)) reasons |= R_IMPERSONATION;
  if (riskScore >= 70 && !conclusiveSpoof && assigned != ASSIGNED_NO) reasons |= R_HIGH_RISK;
  if (identityBand == ID_STRONG || identityBand == ID_CONFIRMED) reasons |= R_IDENTITY_STRONG;
  if (identityBand == ID_POSSIBLE) reasons |= R_IDENTITY_POSSIBLE;
  if (hasSec) reasons |= R_SEC;
  if (hasOsm || hasWikidata || listingCount > 0) reasons |= R_REGISTRY;
  if (cnamKind == CNAM_ORG) reasons |= R_CNAM_ORG;
  if (lineType == LINE_TOLLFREE) reasons |= R_TOLL_FREE;
  if (lineType == LINE_WIRELESS) reasons |= R_WIRELESS;
  if (cnamKind == CNAM_GENERIC) reasons |= R_GENERIC_CNAM;
  if (cnamKind == CNAM_PERSONAL) reasons |= R_PERSONAL_CNAM;
  return reasons;
}

function mill(fccTotal: i32, ftcTotal: i32): bool {
  return fccTotal >= 10 || ftcTotal >= 10;
}

function documentedCompany(identityBand: i32): bool {
  return identityBand == ID_STRONG || identityBand == ID_CONFIRMED;
}

function hasOrgIdentity(identityBand: i32, listingCount: i32, hasOsm: i32, hasWikidata: i32, hasSec: i32): bool {
  if (listingCount > 0 || hasOsm || hasWikidata || hasSec) return true;
  return identityBand == ID_POSSIBLE || identityBand == ID_STRONG || identityBand == ID_CONFIRMED;
}

export function classify(
  identityBand: i32,
  listingCount: i32,
  hasOsm: i32,
  hasWikidata: i32,
  hasSec: i32,
  cnamKind: i32,
  lineType: i32,
  assigned: i32,
  riskScore: i32,
  conclusiveSpoof: i32,
  ownNumberForgery: i32,
  neighbourSpoof: i32,
  fccTotal: i32,
  ftcTotal: i32,
  ftcRobocalls: i32,
  widestStates: i32,
  bothFederal: i32,
  impersonation: i32,
  listingsPending: i32,
  identityFailed: i32,
  complaintsFailed: i32
): i32 {
  const reasons = collectReasons(
    identityBand, listingCount, hasOsm, hasWikidata, hasSec,
    cnamKind, lineType, assigned, riskScore, conclusiveSpoof,
    fccTotal, ftcTotal, bothFederal, impersonation
  );
  const isMill = mill(fccTotal, ftcTotal);
  const structuralScam = assigned == ASSIGNED_NO || conclusiveSpoof != 0;

  // Proven forgery of the number itself always wins, including against a registry hit:
  // placeholder numbers appear in real filings.
  if (structuralScam) {
    return pack(KIND_SCAM, CONF_HIGH, reasons);
  }

  // A published organisation with complaints is still a company. Neighbour-spoof and
  // own-number are about this call, not this line.
  const protectCompany = documentedCompany(identityBand);

  if (!protectCompany) {
    if (lineType == LINE_PREMIUM) {
      return pack(KIND_SCAM, CONF_MEDIUM, reasons);
    }
    if (isMill) {
      const high = widestStates >= 10 || bothFederal != 0 || impersonation != 0;
      return pack(KIND_SCAM, high ? CONF_HIGH : CONF_MEDIUM, reasons);
    }
    if (impersonation != 0 && (fccTotal > 0 || ftcTotal > 0)) {
      return pack(KIND_SCAM, CONF_HIGH, reasons);
    }
    // High risk score is scam only when it is not just "your own number is calling you".
    if (riskScore >= 70 && ownNumberForgery == 0) {
      return pack(KIND_SCAM, CONF_HIGH, reasons);
    }
  }

  // Conflicting independent org names: do not pick a company.
  if (identityBand == ID_CONFLICTING) {
    return pack(KIND_UNKNOWN, CONF_LOW, reasons);
  }

  const orgCnam = cnamKind == CNAM_ORG;
  const tollFreeNamed = lineType == LINE_TOLLFREE && (orgCnam || cnamKind == CNAM_PERSONAL);
  const companyHit = hasOrgIdentity(identityBand, listingCount, hasOsm, hasWikidata, hasSec) || orgCnam || tollFreeNamed;

  if (companyHit) {
    let conf: i32 = CONF_MEDIUM;
    if (identityBand == ID_CONFIRMED || identityBand == ID_STRONG) conf = CONF_HIGH;
    else if (hasSec != 0 && (hasOsm != 0 || hasWikidata != 0)) conf = CONF_HIGH;
    else if (identityBand == ID_POSSIBLE || listingCount > 0 || hasSec != 0) conf = CONF_MEDIUM;
    else conf = CONF_LOW;
    return pack(KIND_COMPANY, conf, reasons);
  }

  const personalSignal = lineType == LINE_WIRELESS || cnamKind == CNAM_GENERIC || cnamKind == CNAM_PERSONAL;
  if (personalSignal) {
    // If registries could not be checked, a wireless block alone is not enough to assume
    // a personal line — it may simply be an unlisted company.
    if (identityFailed != 0 && cnamKind != CNAM_GENERIC && cnamKind != CNAM_PERSONAL) {
      return pack(KIND_UNKNOWN, CONF_LOW, reasons);
    }
    let conf: i32 = CONF_MEDIUM;
    if (listingsPending != 0) conf = CONF_LOW;
    else if (lineType == LINE_WIRELESS && (cnamKind == CNAM_GENERIC || cnamKind == CNAM_PERSONAL)) conf = CONF_HIGH;
    else if (cnamKind == CNAM_PERSONAL && lineType != LINE_WIRELESS) conf = CONF_LOW;
    return pack(KIND_PERSON, conf, reasons);
  }

  // ABI-only features: recorded by the host, not used to pick the label.
  const abi = neighbourSpoof + ftcRobocalls + complaintsFailed;
  if (abi < 0) return pack(KIND_UNKNOWN, CONF_LOW, reasons);
  return pack(KIND_UNKNOWN, CONF_LOW, reasons);
}