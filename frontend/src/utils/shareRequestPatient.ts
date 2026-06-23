// Heuristic: is a share request's RequestName an actual person's name (the patient
// the request is for) vs. a free-text title that older/manual requests put there
// (e.g. "ER Visit", "Knee Procedure", "broken leg", "new request")?
//
// Used to surface who a request is for at a glance, falling back to the primary
// holder when RequestName isn't a name. Imperfect by design — going forward the
// form writes the patient's real name into RequestName, which this detects.

const NON_NAME_WORDS = new Set([
  // visit / encounter
  'visit', 'surgery', 'procedure', 'consult', 'consultation', 'appointment', 'exam',
  'checkup', 'followup', 'screening', 'scan', 'mri', 'ct', 'xray', 'ultrasound', 'biopsy',
  'labs', 'lab', 'test', 'therapy', 'wellness', 'preventative', 'preventive', 'annual',
  'physical', 'maternity', 'delivery', 'pregnancy', 'dental', 'vision', 'er', 'urgent',
  'care', 'clinic', 'hospital', 'telehealth',
  // condition / injury
  'infection', 'injury', 'injured', 'pain', 'fracture', 'broken', 'sprain', 'removal',
  'repair', 'replacement', 'transplant', 'stone', 'stones', 'clot', 'afib', 'dvt', 'flu',
  'covid', 'rash',
  // body parts
  'leg', 'arm', 'knee', 'thumb', 'finger', 'toe', 'foot', 'hand', 'hip', 'back', 'neck',
  'shoulder', 'chest', 'head', 'eye', 'ear', 'tooth', 'teeth', 'ankle', 'wrist', 'elbow',
  'rib', 'spine', 'hernia', 'kidney', 'liver', 'heart', 'lung', 'brain', 'skin', 'blood',
  // status / notes
  'new', 'request', 'duplicate', 'wrong', 'unknown', 'na', 'pending', 'other', 'misc',
]);

/** Coerce anything (number, null, etc.) to a trimmed string — the API can hand
 *  back non-string values for these free-text columns. */
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();

/** True when `raw` reads like a two-word person name (no digits, no description words). */
export function isLikelyPersonName(raw?: unknown): boolean {
  const s = str(raw);
  if (!s) return false;
  const tokens = s.split(/\s+/);
  if (tokens.length !== 2) return false;
  for (const t of tokens) {
    if (!/^[A-Za-z][A-Za-z'’.-]*$/.test(t)) return false;
    if (NON_NAME_WORDS.has(t.toLowerCase())) return false;
  }
  return true;
}

/**
 * Who a request is "for", best-effort, in priority order:
 *   1. patientName — the authoritative patient captured on the linked form
 *      submission (clean first+last); always a real person when present.
 *   2. requestName — when it looks like a person name (legacy/manual requests
 *      often put a free-text title here instead).
 *   3. the primary holder (member) name.
 * Last resort (no member on file) is the raw requestName so rows still show something.
 */
export function requestForName(opts: {
  patientName?: unknown;
  requestName?: unknown;
  memberFirstName?: unknown;
  memberLastName?: unknown;
}): string {
  const patient = str(opts.patientName);
  if (patient) return patient;
  const requestName = str(opts.requestName);
  const primary = `${str(opts.memberFirstName)} ${str(opts.memberLastName)}`.trim();
  if (isLikelyPersonName(requestName)) return requestName;
  return primary || requestName;
}
