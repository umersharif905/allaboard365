'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql } = require('../config/database');

const LOG_PREFIX = '[share-request-import]';

const BUNDLE_FILES = [
  { file: 'manifest.json', label: 'manifest' },
  { file: 'share_requests.csv', label: 'share requests' },
  { file: 'providers.csv', label: 'providers' },
  { file: 'share_request_provider.csv', label: 'share request providers' },
  { file: 'provider_bills.csv', label: 'provider bills' },
  { file: 'provider_bill_ledger.csv', label: 'bill ledger' },
  { file: 'notes.csv', label: 'notes' },
];

function displayRequestName(name, fallback = 'Unnamed request') {
  const trimmed = String(name || '').trim();
  if (!trimmed || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return fallback;
  }
  return trimmed;
}

function reportProgress(onProgress, payload) {
  if (typeof onProgress === 'function') onProgress(payload);
  const suffix = payload.current != null && payload.total != null
    ? ` (${payload.current}/${payload.total})`
    : '';
  console.log(`${LOG_PREFIX} [${payload.phase || 'progress'}] ${payload.message}${suffix}`);
}

/** Parse RFC-style CSV with quoted fields that may contain embedded newlines. */
function parseCsv(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  if (!src.trim()) return [];

  const records = [];
  let row = [];
  let cur = '';
  let inQ = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\r') {
      // handled with \n
    } else if (c === '\n') {
      row.push(cur);
      cur = '';
      if (row.some((cell) => cell.trim() !== '')) records.push(row);
      row = [];
    } else {
      cur += c;
    }
  }

  if (cur !== '' || row.length > 0) {
    row.push(cur);
    if (row.some((cell) => cell.trim() !== '')) records.push(row);
  }

  if (!records.length) return [];
  const headers = records[0].map((h) => h.trim());
  return records.slice(1).map((cells) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] ?? '').trim(); });
    return obj;
  });
}

function loadBundleFromDir(dir, onProgress) {
  const read = (name) => {
    const p = path.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  };

  const total = BUNDLE_FILES.length;
  const loaded = {};
  for (let i = 0; i < BUNDLE_FILES.length; i++) {
    const { file, label } = BUNDLE_FILES[i];
    reportProgress(onProgress, {
      phase: 'load',
      message: `Loading ${label} (${i + 1}/${total})…`,
      current: i + 1,
      total,
    });
    loaded[file] = read(file);
  }

  const manifest = JSON.parse(loaded['manifest.json'] || '{}');
  return {
    manifest,
    shareRequests: parseCsv(loaded['share_requests.csv']),
    providers: parseCsv(loaded['providers.csv']),
    shareRequestProviders: parseCsv(loaded['share_request_provider.csv']),
    providerBills: parseCsv(loaded['provider_bills.csv']),
    billLedger: parseCsv(loaded['provider_bill_ledger.csv']),
    notes: parseCsv(loaded['notes.csv']),
  };
}

function extractBundleDir(uploadPath, onProgress) {
  if (uploadPath.endsWith('.zip')) {
    reportProgress(onProgress, {
      phase: 'extract',
      message: 'Extracting ZIP archive…',
    });

    let entryCount = 0;
    try {
      const listing = execSync(`unzip -l "${uploadPath}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      entryCount = listing.split('\n').filter((line) => /^\s+\d+\s+\d{4}-\d{2}-\d{2}/.test(line)).length;
      if (entryCount > 0) {
        reportProgress(onProgress, {
          phase: 'extract',
          message: `Extracting ${entryCount} files from ZIP…`,
          current: 0,
          total: entryCount,
        });
      }
    } catch {
      // unzip -l unavailable — continue with generic message
    }

    const dest = uploadPath.replace(/\.zip$/i, '_unzipped');
    fs.mkdirSync(dest, { recursive: true });
    execSync(`unzip -o "${uploadPath}" -d "${dest}"`, { stdio: 'pipe' });

    const extracted = fs.readdirSync(dest, { recursive: true })
      .filter((name) => typeof name === 'string' && !String(name).startsWith('.'));
    reportProgress(onProgress, {
      phase: 'extract',
      message: `ZIP extracted (${extracted.length || entryCount || 'done'} files)`,
      current: extracted.length || entryCount || 1,
      total: extracted.length || entryCount || 1,
    });
    return dest;
  }
  return uploadPath;
}

const STATUS_MAP = {
  new: 'New',
  open: 'New',
  pending: 'In Review',
  intake: 'In Review',
  'in review': 'In Review',
  review: 'In Review',
  processing: 'Processing',
  complete: 'Completed',
  completed: 'Completed',
  closed: 'Completed',
  other: 'Processing',
  cancelled: 'Withdrawn',
  canceled: 'Withdrawn',
  denied: 'Denied',
  withdrawn: 'Withdrawn',
};
const DETERMINATION_MAP = {
  pending: 'Pending',
  approved: 'Eligible',
  eligible: 'Eligible',
  denied: 'Not Eligible',
  'not eligible': 'Not Eligible',
  partial: 'Pending',
  undetermined: 'Undetermined',
};

function mapStatus(s) {
  const key = String(s || '').trim().toLowerCase();
  if (!key) return null;
  return STATUS_MAP[key] || 'In Review';
}

function mapDetermination(d) {
  const raw = String(d || '').trim();
  if (!raw) return 'Pending';
  const key = raw.toLowerCase();
  if (DETERMINATION_MAP[key]) return DETERMINATION_MAP[key];
  if (raw.length > 40) return 'Undetermined';
  return 'Undetermined';
}

function sharewellLocalDateTimeToUtc(year, monthIndex, day, hour12, minute, second, ampm) {
  let hour = Number(hour12) % 12;
  if (/pm/i.test(String(ampm || ''))) hour += 12;
  return new Date(Date.UTC(Number(year), Number(monthIndex), Number(day), hour, Number(minute), Number(second)));
}

/** Extract timestamps embedded in Sharewell note blobs (MM-DD-YYYY HH:MM:SS AM/PM). */
function parseSharewellNoteDates(text) {
  if (text == null || String(text).trim() === '') return [];
  const out = [];
  const s = String(text);
  const re = /\b(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\b/gi;
  let match = re.exec(s);
  while (match) {
    out.push(sharewellLocalDateTimeToUtc(
      match[3],
      Number(match[1]) - 1,
      match[2],
      match[4],
      match[5],
      match[6],
      match[7]
    ));
    match = re.exec(s);
  }
  const shortRe = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  let shortMatch = shortRe.exec(s);
  while (shortMatch) {
    const d = new Date(Date.UTC(+shortMatch[3], +shortMatch[1] - 1, +shortMatch[2]));
    if (!Number.isNaN(d.getTime())) out.push(d);
    shortMatch = shortRe.exec(s);
  }
  return out;
}

function addParsedDate(target, value) {
  const d = parseImportDateTimeUtc(value);
  if (d && !Number.isNaN(d.getTime())) target.push(d);
}

function collectLegacyShareRequestDates(sr, bundle, legacyId) {
  const dates = [];
  addParsedDate(dates, sr.create_date);
  addParsedDate(dates, sr.first_dos);
  addParsedDate(dates, sr.scheduled_dos);

  for (const field of [sr.next_steps, sr.notes, sr.eligibility_notes]) {
    dates.push(...parseSharewellNoteDates(field));
  }

  const nameMatch = String(sr.request_name || '').match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (nameMatch) {
    const d = new Date(Date.UTC(+nameMatch[3], +nameMatch[1] - 1, +nameMatch[2]));
    if (!Number.isNaN(d.getTime())) dates.push(d);
  }

  for (const note of bundle.notes || []) {
    if (String(note.share_request_id_key || '') !== String(legacyId)) continue;
    addParsedDate(dates, note.created_date);
    dates.push(...parseSharewellNoteDates(note.note_text));
  }

  for (const bill of bundle.providerBills || []) {
    if (String(bill.request_id_key || '') !== String(legacyId)) continue;
    addParsedDate(dates, bill.create_date);
    addParsedDate(dates, bill.date_of_service);
  }

  return dates
    .filter((d) => d && !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
}

function resolveShareRequestSubmittedDate(sr, bundle, legacyId) {
  const dates = collectLegacyShareRequestDates(sr, bundle, legacyId);
  return dates[0] || null;
}

function resolveShareRequestCompletedDate(sr, bundle, legacyId, status) {
  if (status !== 'Completed') return null;
  const dates = collectLegacyShareRequestDates(sr, bundle, legacyId);
  if (dates.length) return dates[dates.length - 1];
  return resolveShareRequestSubmittedDate(sr, bundle, legacyId);
}

function inferShareRequestStatus(sr, bundle, legacyId, determination) {
  const blob = [sr.notes, sr.next_steps, sr.eligibility_notes].filter(Boolean).join(' ').toLowerCase();
  if (/request complete|sharing request is complete|nothing else to complete|no further action|no required action|appeal denied|denial email sent|not eligible for sharing, member was/i.test(blob)) {
    return 'Completed';
  }
  if (determination === 'Not Eligible' && blob.length > 20) return 'Completed';
  if (determination === 'Eligible') return 'Processing';
  if (determination === 'Pending') return 'In Review';
  if (/^new request:/i.test(String(sr.request_name || '').trim())) return 'New';
  if ((bundle.providerBills || []).some((b) => String(b.request_id_key || '') === String(legacyId))) {
    return 'Processing';
  }
  if ((bundle.notes || []).some((n) => String(n.share_request_id_key || '') === String(legacyId)) || blob.length > 20) {
    return 'In Review';
  }
  return 'In Review';
}

function resolveShareRequestImportHeader(sr, requestTypeId, bundle, legacyId) {
  const determination = mapDetermination(sr.determination);
  const status = mapStatus(sr.status) || inferShareRequestStatus(sr, bundle, legacyId, determination);
  const submittedDate = resolveShareRequestSubmittedDate(sr, bundle, legacyId);
  const completedDate = resolveShareRequestCompletedDate(sr, bundle, legacyId, status);
  return {
    requestTypeId,
    subType: sr.subtype || null,
    status,
    determination,
    dateOfService: parseImportDateUtc(sr.first_dos || sr.scheduled_dos || null),
    requestName: (sr.request_name || '').slice(0, 200),
    nextSteps: sr.next_steps || null,
    generalNotes: sr.notes || null,
    eligibilityNotes: sr.eligibility_notes || null,
    submittedDate,
    completedDate,
  };
}

const MONTH_ABBR = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Parse Sharewell / ISO date strings as UTC calendar dates (no local TZ shift). */
function parseImportDateUtc(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const sharewell = s.match(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/);
  if (sharewell) {
    const mon = MONTH_ABBR[sharewell[1].toLowerCase()];
    if (mon == null) return null;
    const d = new Date(Date.UTC(+sharewell[3], mon, +sharewell[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const parsed = new Date(s);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

/** DateTime fields keep full instant; date-only strings become UTC midnight. */
function parseImportDateTimeUtc(value) {
  if (value == null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return parseImportDateUtc(s);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function providerNameFromRow(row) {
  const company = String(row.company_name || '').trim();
  if (company) return company.slice(0, 200);
  const person = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return (person || 'Unknown Provider').slice(0, 200);
}

async function findExistingProviderId(pool, vendorId, { npi, providerName, city, state }) {
  if (npi) {
    const npiResult = await pool.request()
      .input('vendorId', sql.UniqueIdentifier, vendorId)
      .input('npi', sql.NVarChar, npi)
      .query(`
        SELECT TOP 1 ProviderId
        FROM oe.Providers
        WHERE VendorId = @vendorId AND NPI = @npi
      `);
    if (npiResult.recordset[0]?.ProviderId) return npiResult.recordset[0].ProviderId;
  }

  const nameResult = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('providerName', sql.NVarChar, providerName)
    .input('city', sql.NVarChar, (city || '').trim())
    .input('state', sql.NVarChar, (state || '').trim())
    .query(`
      SELECT TOP 1 ProviderId
      FROM oe.Providers
      WHERE VendorId = @vendorId
        AND LOWER(ProviderName) = LOWER(@providerName)
        AND LOWER(ISNULL(City, '')) = LOWER(@city)
        AND LOWER(ISNULL(State, '')) = LOWER(@state)
    `);
  return nameResult.recordset[0]?.ProviderId || null;
}

async function resolveOrCreateProvider(pool, vendorId, row, stats, createdBy) {
  const legacyId = String(row.id || '').trim();
  if (!legacyId) return null;

  const providerName = providerNameFromRow(row);
  const npi = String(row.npi || '').trim() || null;
  const city = String(row.city || '').trim() || null;
  const state = String(row.state || '').trim() || null;

  const existingId = await findExistingProviderId(pool, vendorId, { npi, providerName, city, state });
  if (existingId) {
    stats.providersReused += 1;
    return existingId;
  }

  const providerId = uuidv4();
  await pool.request()
    .input('providerId', sql.UniqueIdentifier, providerId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('providerName', sql.NVarChar, providerName)
    .input('providerType', sql.NVarChar, (row.type || '').trim() || null)
    .input('npi', sql.NVarChar, npi)
    .input('phone', sql.NVarChar, (row.phone1 || row.phone2 || '').trim() || null)
    .input('email', sql.NVarChar, (row.email || '').trim() || null)
    .input('address1', sql.NVarChar, (row.address1 || '').trim() || null)
    .input('address2', sql.NVarChar, (row.address2 || '').trim() || null)
    .input('city', sql.NVarChar, city)
    .input('state', sql.NVarChar, state)
    .input('zipCode', sql.NVarChar, (row.zip || '').trim() || null)
    .input('notes', sql.NVarChar, (row.notes || '').trim() || null)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .query(`
      INSERT INTO oe.Providers (
        ProviderId, VendorId, ProviderName, ProviderType, NPI,
        Phone, Email, Address1, Address2, City, State, ZipCode, Notes,
        IsActive, CreatedDate, CreatedBy
      ) VALUES (
        @providerId, @vendorId, @providerName, @providerType, @npi,
        @phone, @email, @address1, @address2, @city, @state, @zipCode, @notes,
        1, GETUTCDATE(), @createdBy
      )
    `);
  stats.providersCreated += 1;
  return providerId;
}

async function buildLegacyProviderImportMap(vendorId, providerRows, createdBy) {
  const pool = await getPool();
  const legacyToOe = new Map();
  const stats = { providersCreated: 0, providersReused: 0 };

  for (const row of providerRows || []) {
    const legacyId = String(row.id || '').trim();
    if (!legacyId || legacyToOe.has(legacyId)) continue;
    const oeId = await resolveOrCreateProvider(pool, vendorId, row, stats, createdBy);
    if (oeId) legacyToOe.set(legacyId, oeId);
  }

  return { legacyToOe, stats };
}

async function resolveRequestTypeId(vendorId, typeName, subType, typeMap = {}, createdBy = null) {
  const key = `${typeName || 'General'}::${subType || ''}`;
  if (typeMap[key]) return typeMap[key];
  const pool = await getPool();
  const name = (typeName || 'General').slice(0, 100);
  const existing = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('name', sql.NVarChar, name)
    .query(`
      SELECT TOP 1 TypeId FROM oe.VendorShareRequestTypes
      WHERE VendorId = @vendorId AND Name = @name
    `);
  if (existing.recordset[0]?.TypeId) {
    typeMap[key] = existing.recordset[0].TypeId;
    return existing.recordset[0].TypeId;
  }

  const typeId = uuidv4();
  const req = pool.request()
    .input('typeId', sql.UniqueIdentifier, typeId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('name', sql.NVarChar, name);
  if (createdBy) req.input('createdBy', sql.UniqueIdentifier, createdBy);
  await req.query(`
    DECLARE @nextSort INT = ISNULL(
      (SELECT MAX(SortOrder) + 10 FROM oe.VendorShareRequestTypes WHERE VendorId = @vendorId),
      10
    );
    INSERT INTO oe.VendorShareRequestTypes (TypeId, VendorId, Name, SortOrder${createdBy ? ', CreatedBy' : ''})
    VALUES (@typeId, @vendorId, @name, @nextSort${createdBy ? ', @createdBy' : ''})
  `);
  typeMap[key] = typeId;
  return typeId;
}

function shareRequestSourceKeys(sr) {
  return [
    sr.member_id_key,
    sr.selected_member_id_Key,
    sr.member_key_import_id,
    sr.member_guid_member_id_text,
    sr.member_id,
  ].filter((k) => k && String(k).trim());
}

function indexCountsByKey(rows, keyField) {
  const map = new Map();
  for (const row of rows) {
    const k = row[keyField];
    if (!k) continue;
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

/** One-time load: all MemberSourceKeys, legacy map, and HMIDs referenced in the export. */
async function loadMatchCaches(vendorId, shareRequests) {
  const pool = await getPool();

  const skResult = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT SourceSystem, SourceKey, MemberId
      FROM oe.MemberSourceKeys
      WHERE VendorId = @vendorId
    `);
  const sourceKeyIndex = new Map();
  for (const row of skResult.recordset || []) {
    sourceKeyIndex.set(
      `${row.SourceSystem}::${String(row.SourceKey).trim()}`,
      row.MemberId
    );
  }

  const legacyResult = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .query(`
      SELECT LegacyShareRequestId, ShareRequestId
      FROM oe.ShareRequestLegacyMap
      WHERE VendorId = @vendorId
    `);
  const legacyImported = new Set();
  const legacyToShareRequestId = new Map();
  for (const row of legacyResult.recordset || []) {
    const legacyId = String(row.LegacyShareRequestId);
    legacyImported.add(legacyId);
    if (row.ShareRequestId) legacyToShareRequestId.set(legacyId, row.ShareRequestId);
  }

  const hmids = new Set();
  for (const sr of shareRequests) {
    const h = sr.member_id || sr.member_guid_member_id_text;
    if (h) hmids.add(String(h).trim().slice(0, 50));
  }

  const hmidIndex = new Map();
  const hmidList = [...hmids].filter(Boolean);
  for (let offset = 0; offset < hmidList.length; offset += 500) {
    const chunk = hmidList.slice(offset, offset + 500);
    const req = pool.request();
    const placeholders = chunk.map((h, i) => {
      req.input(`h${i}`, sql.NVarChar(50), h);
      return `@h${i}`;
    });
    const hResult = await req.query(`
      SELECT MemberId, HouseholdMemberID
      FROM oe.Members
      WHERE HouseholdMemberID IN (${placeholders.join(', ')})
    `);
    for (const row of hResult.recordset || []) {
      hmidIndex.set(String(row.HouseholdMemberID).trim(), row.MemberId);
    }
  }

  return { sourceKeyIndex, legacyImported, legacyToShareRequestId, hmidIndex, sourceKeyCount: sourceKeyIndex.size };
}

function matchMemberFromCaches(sr, caches) {
  for (const raw of shareRequestSourceKeys(sr)) {
    const memberId = caches.sourceKeyIndex.get(`sharewell::${String(raw).trim()}`);
    if (memberId) return memberId;
  }
  const hmid = sr.member_id || sr.member_guid_member_id_text;
  if (hmid) {
    return caches.hmidIndex.get(String(hmid).trim()) || null;
  }
  return null;
}

async function lookupMemberDisplayNames(memberIds) {
  const unique = [...new Set((memberIds || []).filter(Boolean))];
  const map = new Map();
  if (!unique.length) return map;

  const pool = await getPool();
  const chunkSize = 200;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const req = pool.request();
    const placeholders = chunk.map((id, i) => {
      req.input(`mid${i}`, sql.UniqueIdentifier, id);
      return `@mid${i}`;
    });
    const result = await req.query(`
      SELECT m.MemberId, m.HouseholdMemberID, u.FirstName, u.LastName
      FROM oe.Members m
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      WHERE m.MemberId IN (${placeholders.join(', ')})
    `);
    for (const row of result.recordset || []) {
      const name = [row.FirstName, row.LastName].filter(Boolean).join(' ').trim();
      map.set(String(row.MemberId).toLowerCase(), name || row.HouseholdMemberID || 'Unknown member');
    }
  }
  return map;
}

async function previewShareRequestImport({ vendorId, bundleDir, queueUnlinked = false, onProgress, bundle: existingBundle }) {
  const bundle = existingBundle || loadBundleFromDir(bundleDir, onProgress);
  const rows = [];
  const total = bundle.shareRequests.length;

  reportProgress(onProgress, {
    phase: 'match',
    message: 'Loading member link index…',
  });

  const caches = await loadMatchCaches(vendorId, bundle.shareRequests);
  const billsByRequest = indexCountsByKey(bundle.providerBills, 'request_id_key');
  const notesByRequest = indexCountsByKey(bundle.notes, 'share_request_id_key');

  reportProgress(onProgress, {
    phase: 'match',
    message: `Scanning ${total} share requests (${caches.sourceKeyCount} member keys loaded)…`,
    current: 0,
    total: total || 1,
  });

  let linked = 0;
  for (let i = 0; i < bundle.shareRequests.length; i++) {
    const sr = bundle.shareRequests[i];
    const legacyId = sr.id || sr.request_id;
    const legacyKey = String(legacyId);
    const isDuplicate = caches.legacyImported.has(legacyKey);
    const memberId = matchMemberFromCaches(sr, caches);
    let action = 'skip';
    if (isDuplicate && memberId) action = 'resync';
    else if (isDuplicate) action = 'skip_duplicate';
    else if (memberId) {
      action = 'import';
      linked += 1;
    } else if (queueUnlinked) action = 'queue';
    else action = 'skip_unlinked';

    rows.push({
      legacyId,
      requestName: sr.request_name,
      status: sr.status,
      memberId,
      shareRequestId: isDuplicate ? (caches.legacyToShareRequestId.get(legacyKey) || null) : null,
      action,
      billCount: billsByRequest.get(legacyId) || 0,
      noteCount: notesByRequest.get(legacyId) || 0,
    });

    if (i === 0 || i === total - 1 || (i + 1) % 500 === 0) {
      reportProgress(onProgress, {
        phase: 'match',
        message: `Scanned ${i + 1}/${total} — ${linked} linked so far`,
        current: i + 1,
        total,
      });
    }
  }

  const memberNames = await lookupMemberDisplayNames(
    rows.filter((r) => r.action === 'import' || r.action === 'resync').map((r) => r.memberId)
  );
  for (const row of rows) {
    if (row.memberId) {
      row.memberName = memberNames.get(String(row.memberId).toLowerCase()) || null;
    }
  }

  reportProgress(onProgress, {
    phase: 'match',
    message: `Preview complete — ${rows.filter((r) => r.action === 'import').length} new, ${rows.filter((r) => r.action === 'resync').length} to resync`,
    current: total,
    total: total || 1,
  });

  return {
    statistics: {
      total: rows.length,
      import: rows.filter((r) => r.action === 'import').length,
      resync: rows.filter((r) => r.action === 'resync').length,
      queue: rows.filter((r) => r.action === 'queue').length,
      skipUnlinked: rows.filter((r) => r.action === 'skip_unlinked').length,
      skipDuplicate: rows.filter((r) => r.action === 'skip_duplicate').length,
    },
    rows,
    manifest: bundle.manifest,
  };
}

async function resolveShareRequestMember(pool, memberId) {
  const memberRes = await pool.request()
    .input('memberId', sql.UniqueIdentifier, memberId)
    .query(`SELECT MemberId, HouseholdId FROM oe.Members WHERE MemberId = @memberId`);
  const member = memberRes.recordset[0];
  if (!member) throw new Error('Member not found');
  return member;
}

function buildShareRequestHeaderValues(sr, requestTypeId, bundle, legacyId) {
  return resolveShareRequestImportHeader(sr, requestTypeId, bundle, legacyId);
}

async function insertShareRequestStatusHistory(pool, shareRequestId, header, createdBy, reason) {
  await pool.request()
    .input('id', sql.UniqueIdentifier, uuidv4())
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .input('status', sql.NVarChar(50), header.status)
    .input('determination', sql.NVarChar(50), header.determination)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .input('reason', sql.NVarChar(200), reason)
    .query(`
      INSERT INTO oe.ShareRequestStatusHistory (
        StatusHistoryId, ShareRequestId, PreviousStatus, NewStatus,
        PreviousDetermination, NewDetermination, Reason, CreatedDate, CreatedBy
      ) VALUES (
        @id, @shareRequestId, NULL, @status, NULL, @determination, @reason, GETUTCDATE(), @createdBy
      )
    `);
}

async function clearShareRequestImportChildren(pool, shareRequestId) {
  await pool.request()
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .query(`
      DELETE FROM oe.ShareRequestTransactions WHERE ShareRequestId = @shareRequestId;
      DELETE FROM oe.ShareRequestBills WHERE ShareRequestId = @shareRequestId;
      DELETE FROM oe.ShareRequestProviders WHERE ShareRequestId = @shareRequestId;
      DELETE FROM oe.ShareRequestNotes WHERE ShareRequestId = @shareRequestId;
    `);
}

async function applyShareRequestImportChildren(pool, {
  shareRequestId, legacyId, bundle, providerLegacyMap, createdBy,
}) {
  const srNotes = bundle.notes.filter((n) => n.share_request_id_key === legacyId);
  for (const note of srNotes) {
    await pool.request()
      .input('noteId', sql.UniqueIdentifier, uuidv4())
      .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
      .input('note', sql.NVarChar(sql.MAX), note.note_text || '')
      .input('noteType', sql.NVarChar(50), note.note_type || 'General')
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.ShareRequestNotes (NoteId, ShareRequestId, NoteType, Note, IsInternal, CreatedDate, CreatedBy)
        VALUES (@noteId, @shareRequestId, @noteType, @note, 1, GETUTCDATE(), @createdBy)
      `);
  }

  const srProviderLinks = (bundle.shareRequestProviders || [])
    .filter((link) => String(link.share_request_id || '').trim() === String(legacyId));
  let providerLinksCreated = 0;
  for (const link of srProviderLinks) {
    const oeProviderId = providerLegacyMap.get(String(link.provider_id_key || '').trim());
    if (!oeProviderId) continue;
    await pool.request()
      .input('shareRequestProviderId', sql.UniqueIdentifier, uuidv4())
      .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
      .input('providerId', sql.UniqueIdentifier, oeProviderId)
      .input('providerRole', sql.NVarChar(100), (link.rank_this || '').trim() || null)
      .input('notes', sql.NVarChar(sql.MAX), (link.notes || '').trim() || null)
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.ShareRequestProviders (
          ShareRequestProviderId, ShareRequestId, ProviderId, ProviderRole, Notes, CreatedDate, CreatedBy
        ) VALUES (
          @shareRequestProviderId, @shareRequestId, @providerId, @providerRole, @notes, GETUTCDATE(), @createdBy
        )
      `);
    providerLinksCreated += 1;
  }

  const srBills = bundle.providerBills.filter((b) => b.request_id_key === legacyId);
  let billNum = 1;
  for (const bill of srBills) {
    const billId = uuidv4();
    const amount = parseFloat(bill.amount) || 0;
    const billServiceDate = parseImportDateUtc(bill.date_of_service);
    await pool.request()
      .input('billId', sql.UniqueIdentifier, billId)
      .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
      .input('billNumber', sql.NVarChar(50), bill.bill_id || `BILL-${billNum}`)
      .input('billType', sql.NVarChar(50), bill.bill_type || 'Medical')
      .input('billDate', sql.Date, billServiceDate)
      .input('dateOfService', sql.Date, billServiceDate)
      .input('description', sql.NVarChar(500), bill.bill_name || null)
      .input('billedAmount', sql.Decimal(18, 2), amount)
      .input('createdBy', sql.UniqueIdentifier, createdBy || null)
      .query(`
        INSERT INTO oe.ShareRequestBills (
          BillId, ShareRequestId, BillNumber, BillType, BillDate, DateOfService,
          Description, BilledAmount, AllowedAmount, DiscountAmount, UAAmount,
          ShareAmount, PaidAmount, Balance, IsActive, CreatedDate, CreatedBy
        ) VALUES (
          @billId, @shareRequestId, @billNumber, @billType, @billDate, @dateOfService,
          @description, @billedAmount, @billedAmount, 0, 0, 0, 0, @billedAmount, 1, GETUTCDATE(), @createdBy
        )
      `);

    const ledgerRows = bundle.billLedger.filter((t) => t.bill_id_key === bill.id);
    for (const tx of ledgerRows) {
      await pool.request()
        .input('transactionId', sql.UniqueIdentifier, uuidv4())
        .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
        .input('billId', sql.UniqueIdentifier, billId)
        .input('transactionType', sql.NVarChar(50), tx.transaction_type || 'Payment')
        .input('amount', sql.Decimal(18, 2), parseFloat(tx.payment_amount) || 0)
        .input('transactionDate', sql.Date, parseImportDateUtc(tx.transaction_date))
        .input('referenceNumber', sql.NVarChar(100), tx.transaction_number || null)
        .input('notes', sql.NVarChar(sql.MAX), tx.transaction_notes || null)
        .input('createdBy', sql.UniqueIdentifier, createdBy || null)
        .query(`
          INSERT INTO oe.ShareRequestTransactions (
            TransactionId, ShareRequestId, BillId, TransactionType, Amount,
            TransactionDate, ReferenceNumber, Notes, TransactionStatus, CreatedDate, CreatedBy
          ) VALUES (
            @transactionId, @shareRequestId, @billId, @transactionType, @amount,
            @transactionDate, @referenceNumber, @notes, 'Completed', GETUTCDATE(), @createdBy
          )
        `);
    }
    billNum += 1;
  }

  const totals = srBills.reduce((acc, b) => {
    const a = parseFloat(b.amount) || 0;
    acc.billed += a;
    acc.balance += a;
    return acc;
  }, { billed: 0, balance: 0 });

  await pool.request()
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .input('billed', sql.Decimal(18, 2), totals.billed)
    .input('balance', sql.Decimal(18, 2), totals.balance)
    .query(`
      UPDATE oe.ShareRequests
      SET TotalBilledAmount = @billed, Balance = @balance, ModifiedDate = GETUTCDATE()
      WHERE ShareRequestId = @shareRequestId
    `);

  return { providerLinksCreated };
}

async function importOneShareRequest({
  vendorId, sr, bundle, memberId, createdBy, typeMap = {}, providerLegacyMap = new Map(),
}) {
  const pool = await getPool();
  const legacyId = sr.id || sr.request_id;
  const shareRequestId = uuidv4();

  const member = await resolveShareRequestMember(pool, memberId);

  const reqNumResult = await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .output('requestNumber', sql.NVarChar(50))
    .execute('oe.usp_GenerateShareRequestNumber');
  const requestNumber = reqNumResult.output.requestNumber;
  const requestTypeId = await resolveRequestTypeId(vendorId, sr.type, sr.subtype, typeMap, createdBy);
  const header = buildShareRequestHeaderValues(sr, requestTypeId, bundle, legacyId);
  const createdStamp = header.submittedDate || new Date();

  await pool.request()
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('requestNumber', sql.NVarChar(50), requestNumber)
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('householdId', sql.UniqueIdentifier, member.HouseholdId || memberId)
    .input('requestTypeId', sql.UniqueIdentifier, header.requestTypeId)
    .input('subType', sql.NVarChar(500), header.subType)
    .input('status', sql.NVarChar(50), header.status)
    .input('determination', sql.NVarChar(50), header.determination)
    .input('dateOfService', sql.Date, header.dateOfService)
    .input('requestName', sql.NVarChar(200), header.requestName)
    .input('nextSteps', sql.NVarChar(sql.MAX), header.nextSteps)
    .input('generalNotes', sql.NVarChar(sql.MAX), header.generalNotes)
    .input('eligibilityNotes', sql.NVarChar(sql.MAX), header.eligibilityNotes)
    .input('submittedDate', sql.DateTime2, createdStamp)
    .input('completedDate', sql.DateTime2, header.completedDate)
    .input('createdBy', sql.UniqueIdentifier, createdBy || null)
    .input('createdVia', sql.NVarChar(20), 'Import')
    .query(`
      INSERT INTO oe.ShareRequests (
        ShareRequestId, VendorId, RequestNumber, MemberId, HouseholdId,
        RequestTypeId, SubType, Status, Determination, DateOfService,
        RequestName, NextSteps, GeneralNotes, EligibilityNotes,
        SubmittedDate, CreatedDate, CompletedDate, CreatedBy, CreatedVia,
        TotalBilledAmount, TotalDiscounts, TotalUAAmount, TotalShareAmount,
        TotalPaidAmount, TotalMemberPayments, Balance, MissingDocuments, RequestType
      ) VALUES (
        @shareRequestId, @vendorId, @requestNumber, @memberId, @householdId,
        @requestTypeId, @subType, @status, @determination, @dateOfService,
        @requestName, @nextSteps, @generalNotes, @eligibilityNotes,
        @submittedDate, @submittedDate, @completedDate, @createdBy, @createdVia,
        0, 0, 0, 0, 0, 0, 0, 0, 'Medical'
      )
    `);

  await pool.request()
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('legacyId', sql.NVarChar(100), String(legacyId).slice(0, 100))
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .query(`
      INSERT INTO oe.ShareRequestLegacyMap (VendorId, LegacyShareRequestId, ShareRequestId)
      VALUES (@vendorId, @legacyId, @shareRequestId)
    `);

  await insertShareRequestStatusHistory(pool, shareRequestId, header, createdBy, 'Sharewell import');

  const { providerLinksCreated } = await applyShareRequestImportChildren(pool, {
    shareRequestId,
    legacyId,
    bundle,
    providerLegacyMap,
    createdBy,
  });

  return { shareRequestId, requestNumber, legacyId, providerLinksCreated };
}

async function resyncOneShareRequest({
  vendorId,
  shareRequestId,
  sr,
  bundle,
  memberId,
  createdBy,
  typeMap = {},
  providerLegacyMap = new Map(),
}) {
  const pool = await getPool();
  const legacyId = sr.id || sr.request_id;

  const existing = await pool.request()
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .input('vendorId', sql.UniqueIdentifier, vendorId)
    .input('legacyId', sql.NVarChar(100), String(legacyId).slice(0, 100))
    .query(`
      SELECT TOP 1 sr.ShareRequestId, sr.RequestNumber
      FROM oe.ShareRequests sr
      INNER JOIN oe.ShareRequestLegacyMap lm
        ON lm.ShareRequestId = sr.ShareRequestId
       AND lm.VendorId = @vendorId
       AND lm.LegacyShareRequestId = @legacyId
      WHERE sr.ShareRequestId = @shareRequestId AND sr.VendorId = @vendorId
    `);
  const row = existing.recordset[0];
  if (!row) throw new Error('Existing share request not found for resync');

  const member = await resolveShareRequestMember(pool, memberId);
  const requestTypeId = await resolveRequestTypeId(vendorId, sr.type, sr.subtype, typeMap, createdBy);
  const header = buildShareRequestHeaderValues(sr, requestTypeId, bundle, legacyId);
  const createdStamp = header.submittedDate || new Date();

  await pool.request()
    .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
    .input('memberId', sql.UniqueIdentifier, memberId)
    .input('householdId', sql.UniqueIdentifier, member.HouseholdId || memberId)
    .input('requestTypeId', sql.UniqueIdentifier, header.requestTypeId)
    .input('subType', sql.NVarChar(500), header.subType)
    .input('status', sql.NVarChar(50), header.status)
    .input('determination', sql.NVarChar(50), header.determination)
    .input('dateOfService', sql.Date, header.dateOfService)
    .input('requestName', sql.NVarChar(200), header.requestName)
    .input('nextSteps', sql.NVarChar(sql.MAX), header.nextSteps)
    .input('generalNotes', sql.NVarChar(sql.MAX), header.generalNotes)
    .input('eligibilityNotes', sql.NVarChar(sql.MAX), header.eligibilityNotes)
    .input('submittedDate', sql.DateTime2, createdStamp)
    .input('completedDate', sql.DateTime2, header.completedDate)
    .query(`
      UPDATE oe.ShareRequests
      SET MemberId = @memberId,
          HouseholdId = @householdId,
          RequestTypeId = @requestTypeId,
          SubType = @subType,
          Status = @status,
          Determination = @determination,
          DateOfService = @dateOfService,
          RequestName = @requestName,
          NextSteps = @nextSteps,
          GeneralNotes = @generalNotes,
          EligibilityNotes = @eligibilityNotes,
          SubmittedDate = @submittedDate,
          CreatedDate = @submittedDate,
          CompletedDate = @completedDate,
          ModifiedDate = GETUTCDATE()
      WHERE ShareRequestId = @shareRequestId
    `);

  await clearShareRequestImportChildren(pool, shareRequestId);
  const { providerLinksCreated } = await applyShareRequestImportChildren(pool, {
    shareRequestId,
    legacyId,
    bundle,
    providerLegacyMap,
    createdBy,
  });
  await insertShareRequestStatusHistory(pool, shareRequestId, header, createdBy, 'Sharewell import resync');

  return {
    shareRequestId,
    requestNumber: row.RequestNumber,
    legacyId,
    providerLinksCreated,
  };
}

function filterCommitPreviewRows(previewRows, resyncExisting = true) {
  return (previewRows || []).filter((row) => {
    if (!row.memberId) return false;
    if (row.action === 'import') return true;
    if (row.action === 'resync' && resyncExisting) return true;
    return false;
  });
}

async function commitShareRequestImport({
  vendorId,
  bundleDir,
  createdBy,
  queueUnlinked = false,
  resyncExisting = true,
  typeMap = {},
  onProgress,
  previewRows,
}) {
  reportProgress(onProgress, { phase: 'commit', message: 'Loading export bundle…' });
  const bundle = loadBundleFromDir(bundleDir);

  const srByLegacy = new Map(
    bundle.shareRequests.map((sr) => [String(sr.id || sr.request_id), sr])
  );

  let rowsToImport;
  if (Array.isArray(previewRows) && previewRows.length) {
    rowsToImport = filterCommitPreviewRows(previewRows, resyncExisting);
    reportProgress(onProgress, {
      phase: 'commit',
      message: `Processing ${rowsToImport.length} linked request(s) from preview…`,
      current: 0,
      total: rowsToImport.length || 1,
    });
  } else {
    reportProgress(onProgress, { phase: 'commit', message: 'Building import plan…' });
    const preview = await previewShareRequestImport({
      vendorId, bundleDir, queueUnlinked, onProgress, bundle,
    });
    rowsToImport = filterCommitPreviewRows(preview.rows, resyncExisting);
  }

  const results = {
    imported: 0,
    resynced: 0,
    queued: 0,
    skipped: 0,
    errors: [],
    shareRequestIds: [],
    providersCreated: 0,
    providersReused: 0,
    providerLinksCreated: 0,
  };
  const total = rowsToImport.length;

  reportProgress(onProgress, {
    phase: 'commit',
    message: `Resolving ${bundle.providers.length} provider(s)…`,
  });
  const { legacyToOe: providerLegacyMap, stats: providerStats } = await buildLegacyProviderImportMap(
    vendorId,
    bundle.providers,
    createdBy
  );
  results.providersCreated = providerStats.providersCreated;
  results.providersReused = providerStats.providersReused;

  for (let i = 0; i < rowsToImport.length; i++) {
    const row = rowsToImport[i];
    const sr = srByLegacy.get(String(row.legacyId));
    if (!sr) {
      results.errors.push({ legacyId: row.legacyId, message: 'Share request not found in bundle' });
      continue;
    }

    try {
      const isResync = row.action === 'resync';
      if (isResync && !row.shareRequestId) {
        results.errors.push({
          legacyId: row.legacyId,
          message: 'Legacy map missing ShareRequestId for resync',
        });
        continue;
      }
      reportProgress(onProgress, {
        phase: 'commit',
        message: `${isResync ? 'Resyncing' : 'Importing'} ${displayRequestName(row.requestName)} (${i + 1}/${total})…`,
        current: i + 1,
        total,
      });
      const out = isResync
        ? await resyncOneShareRequest({
          vendorId,
          shareRequestId: row.shareRequestId,
          sr,
          bundle,
          memberId: row.memberId,
          createdBy,
          typeMap,
          providerLegacyMap,
        })
        : await importOneShareRequest({
          vendorId, sr, bundle, memberId: row.memberId, createdBy, typeMap, providerLegacyMap,
        });
      if (isResync) results.resynced += 1;
      else results.imported += 1;
      results.providerLinksCreated += out.providerLinksCreated || 0;
      results.shareRequestIds.push(out.shareRequestId);
    } catch (err) {
      results.errors.push({ legacyId: row.legacyId, message: err.message });
      console.error(`${LOG_PREFIX} import error legacyId=${row.legacyId}:`, err.message);
    }
  }

  if (queueUnlinked && !previewRows?.length) {
    const preview = await previewShareRequestImport({ vendorId, bundleDir, queueUnlinked, bundle });
    for (const row of preview.rows.filter((r) => r.action === 'queue')) {
      const sr = srByLegacy.get(String(row.legacyId));
      if (!sr) continue;
      try {
        const pool = await getPool();
        await pool.request()
          .input('pendingId', sql.UniqueIdentifier, uuidv4())
          .input('vendorId', sql.UniqueIdentifier, vendorId)
          .input('legacyId', sql.NVarChar(100), String(row.legacyId).slice(0, 100))
          .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(sr))
          .input('keys', sql.NVarChar(sql.MAX), JSON.stringify({
            member_id_key: sr.member_id_key,
            member_id: sr.member_id,
          }))
          .query(`
            INSERT INTO oe.ShareRequestImportPending (VendorId, LegacyShareRequestId, PayloadJson, MemberLinkKeysJson)
            VALUES (@vendorId, @legacyId, @payload, @keys)
          `);
        results.queued += 1;
      } catch (err) {
        results.errors.push({ legacyId: row.legacyId, message: err.message });
      }
    }
  }

  reportProgress(onProgress, {
    phase: 'commit',
    message: `Import finished — ${results.imported} imported, ${results.resynced} resynced, ${results.errors.length} errors`,
    current: total,
    total: total || 1,
  });

  return results;
}

module.exports = {
  extractBundleDir,
  loadBundleFromDir,
  previewShareRequestImport,
  commitShareRequestImport,
  matchMemberFromCaches,
  parseImportDateUtc,
  parseImportDateTimeUtc,
  mapStatus,
  mapDetermination,
  filterCommitPreviewRows,
  parseSharewellNoteDates,
  resolveShareRequestImportHeader,
};
