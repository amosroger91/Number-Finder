// Integer encodings shared by the AssemblyScript classifier.
// Keep the numeric values in lockstep with agent.js.

export const KIND_UNKNOWN: i32 = 0;
export const KIND_PERSON: i32 = 1;
export const KIND_COMPANY: i32 = 2;
export const KIND_SCAM: i32 = 3;

export const CONF_LOW: i32 = 0;
export const CONF_MEDIUM: i32 = 1;
export const CONF_HIGH: i32 = 2;

export const ID_UNKNOWN: i32 = 0;
export const ID_POSSIBLE: i32 = 1;
export const ID_CONFLICTING: i32 = 2;
export const ID_STRONG: i32 = 3;
export const ID_CONFIRMED: i32 = 4;

export const CNAM_NONE: i32 = 0;
export const CNAM_GENERIC: i32 = 1;
export const CNAM_PERSONAL: i32 = 2;
export const CNAM_ORG: i32 = 3;

export const LINE_UNKNOWN: i32 = 0;
export const LINE_WIRELESS: i32 = 1;
export const LINE_LANDLINE: i32 = 2;
export const LINE_VOIP: i32 = 3;
export const LINE_TOLLFREE: i32 = 4;
export const LINE_PREMIUM: i32 = 5;

export const ASSIGNED_UNKNOWN: i32 = 0;
export const ASSIGNED_YES: i32 = 1;
export const ASSIGNED_NO: i32 = 2;

export const R_UNASSIGNED: i32 = 1 << 0;
export const R_CONCLUSIVE_SPOOF: i32 = 1 << 1;
export const R_PREMIUM: i32 = 1 << 2;
export const R_COMPLAINT_MILL: i32 = 1 << 3;
export const R_BOTH_FEDERAL: i32 = 1 << 4;
export const R_IMPERSONATION: i32 = 1 << 5;
export const R_HIGH_RISK: i32 = 1 << 6;
export const R_IDENTITY_STRONG: i32 = 1 << 7;
export const R_IDENTITY_POSSIBLE: i32 = 1 << 8;
export const R_SEC: i32 = 1 << 9;
export const R_REGISTRY: i32 = 1 << 10;
export const R_CNAM_ORG: i32 = 1 << 11;
export const R_TOLL_FREE: i32 = 1 << 12;
export const R_WIRELESS: i32 = 1 << 13;
export const R_GENERIC_CNAM: i32 = 1 << 14;
export const R_PERSONAL_CNAM: i32 = 1 << 15;