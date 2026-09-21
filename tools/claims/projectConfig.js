// The one line of project config 04 §4 step 3 says the export needs and
// which did not exist before nl-scx.7: this project's CURRENT commercial
// status, read at export time rather than baked into a claim at extraction
// (04 §3.2). Today's answer, per the 2026-08-28 LBJ/NPIN reply recorded in
// docs/data-acquisition/permission-requests.md ("personal/non-commercial:
// yes; commercial: no"), is 'non-commercial'. Flip this the day the project's
// business model changes — nothing else needs to change for NPIN-sourced
// claims to correctly drop out of the next export.
export const COMMERCIAL_STATUS = 'non-commercial';
