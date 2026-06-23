const crypto = require('crypto');
const { getPool, sql } = require('../config/database');
const ShareRequestService = require('./shareRequestService');
const CaseService = require('./caseService');
const { resolveVendorIdForMember } = require('./publicFormMemberResolver');
const memberDirectDepositService = require('./memberDirectDepositService');

/**
 * Public-form fields that carry a `provider_search` value, mapped to the
 * `oe.ShareRequestProviders.ProviderRole` we want to use when linking that
 * provider to the freshly-created SR. Keyed by the form's field name; values
 * are the role string. Form fields not listed here are ignored by the
 * provider-link step (signature, file, etc. are obviously not providers).
 *
 * If a future form uses different field names, add them here; the role
 * vocabulary intentionally matches PROVIDER_ROLES on the SR Providers tab so
 * the UI dropdown shows the same labels.
 */
const PROVIDER_FIELD_TO_ROLE = Object.freeze({
    // PCP — shared across major-event branches.
    req_pcp_provider: 'Primary Provider',
    // Surgeon (upcoming + post-op branches).
    surg_surgeon: 'Surgeon',
    post_surgeon: 'Surgeon',
    // ER doctor.
    er_doctor: 'Emergency',
    // Maternity OB / midwife.
    mat_provider: 'OB/Midwife',
    // Preventative — single combined provider/facility slot.
    prev_provider: 'Provider',
    // Facilities — every branch's hospital / surgery center / birth center.
    surg_facility: 'Facility',
    post_facility: 'Facility',
    er_hospital: 'Facility',
    mat_facility: 'Facility'
});

/**
 * Adjacent text fields on the form that carry a TIN/EIN value paired with
 * the matching provider_search field. Used to write the TaxId onto the
 * resulting `oe.Providers` row (only when the row's TaxId is currently NULL —
 * back-office edits stay authoritative).
 */
const PROVIDER_TAX_ID_PAIRS = Object.freeze({
    surg_surgeon: 'surg_tax_id',
    post_surgeon: 'post_tax_id',
    er_hospital:  'er_tax_id',
    mat_provider: 'mat_tax_id'
});

/**
 * Fax now rides on the provider_search value itself: the public NPI search
 * forwards the NPPES `fax_number`, and ProviderSearchField stores the whole
 * result, so `providerValue.fax` is the source of truth for every provider
 * field. (Previously a manual `req_pcp_fax` text field paired to the PCP
 * search supplied it; that field has been removed.) Written onto the
 * `oe.Providers` row only when the row's Fax is currently NULL — back-office
 * edits stay authoritative, same rule as TaxId.
 */

/**
 * Walk the prescreen answers and find the first answered option that carries
 * an explicit `autoCreateOnSubmit` directive. Returns one of:
 *   'shareRequest' | 'case' | 'none' | null
 * `null` means no answered option pinned a route — caller falls back to the
 * template-level flags firing independently (legacy / single-purpose forms).
 *
 * Questions and options are walked in their array order; the first explicit
 * setting wins. The form's prescreen question and option ids are NOT
 * hardcoded — authors configure this per-option in the form builder.
 */
function detectAutoCreateRoute(def, preScreenAnswers) {
    if (!def || !Array.isArray(def.preScreening) || !preScreenAnswers || typeof preScreenAnswers !== 'object') {
        return null;
    }
    for (const q of def.preScreening) {
        if (!q || !Array.isArray(q.options)) continue;
        const raw = preScreenAnswers[q.id];
        if (!raw) continue;
        const selectedIds = Array.isArray(raw) ? raw : [raw];
        for (const sel of selectedIds) {
            const opt = q.options.find((o) => o && o.id === sel);
            if (!opt) continue;
            const ac = opt.autoCreateOnSubmit;
            if (ac === 'shareRequest' || ac === 'case' || ac === 'none') return ac;
        }
    }
    return null;
}

/**
 * Pull a per-option `srTypeHint` out of the prescreen answers, if any. The
 * first matching selected option wins. Returns null when no answered option
 * carries a hint.
 */
function extractSrTypeHintFromAnswers(def, preScreenAnswers) {
    if (!def || !Array.isArray(def.preScreening) || !preScreenAnswers || typeof preScreenAnswers !== 'object') {
        return null;
    }
    for (const q of def.preScreening) {
        if (!q || !Array.isArray(q.options)) continue;
        const raw = preScreenAnswers[q.id];
        if (!raw) continue;
        const selectedIds = Array.isArray(raw) ? raw : [raw];
        for (const sel of selectedIds) {
            const opt = q.options.find((o) => o && o.id === sel);
            if (opt && typeof opt.srTypeHint === 'string' && opt.srTypeHint.trim()) {
                return opt.srTypeHint.trim();
            }
        }
    }
    return null;
}

/**
 * Map public form sharingRequestType values to a per-vendor RequestTypeId.
 *
 * Resolution order for the `hint` that drives type matching:
 *   1. Explicit srTypeHint carried by a selected prescreen option.
 *   2. payload.sharingRequestType === 'Maternity' (legacy UnsharedAmount path).
 *   3. Default by formKind: 'Wellness' for PreventiveCare, 'Procedure' otherwise.
 *
 * Returns null only if the vendor has no types defined at all — in which case
 * the resulting share request lands with a NULL type and shows "—".
 */
async function resolveRequestTypeIdForPayload(vendorId, formKind, payload, preScreenHint = null) {
    if (!vendorId) return { typeId: null, typeName: null };

    let hint = 'Procedure';
    if (formKind === 'PreventiveCare') {
        hint = 'Wellness';
    } else if (formKind === 'UnsharedAmount') {
        const t = (payload.sharingRequestType || '').toString();
        if (t === 'Maternity') hint = 'Maternity';
    }
    // A pre-screen-derived hint takes priority — that's the member's answer
    // routing this submission, not the form's static formKind default.
    if (preScreenHint) hint = preScreenHint;

    const pool = await getPool();
    const result = await pool.request()
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('hint', sql.NVarChar(100), hint)
        .query(`
            SELECT TOP 1 TypeId, Name
            FROM oe.VendorShareRequestTypes
            WHERE VendorId = @vendorId
            ORDER BY
                CASE WHEN Name = @hint THEN 0
                     WHEN Name = 'Procedure' THEN 1
                     ELSE 2 END,
                SortOrder ASC
        `);

    const row = result.recordset[0];
    return { typeId: row?.TypeId || null, typeName: row?.Name || null };
}

/**
 * Verify last name + DOB for additional-documents flow.
 */
async function verifyMemberVerifiers(memberId, payload) {
    const last = (payload.verifyLastName || '').toString().trim().toLowerCase();
    const dob = (payload.verifyDateOfBirth || '').toString().trim();
    if (!last || !dob) {
        return false;
    }
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('last', sql.NVarChar, last)
        .input('dob', sql.Date, new Date(dob))
        .query(`
            SELECT 1
            FROM oe.Members m
            INNER JOIN oe.Users u ON m.UserId = u.UserId
            WHERE m.MemberId = @memberId
            AND LOWER(LTRIM(RTRIM(u.LastName))) = @last
            AND CAST(m.DateOfBirth AS DATE) = CAST(@dob AS DATE)
        `);
    return r.recordset.length > 0;
}

/**
 * Find existing share request for additional documents.
 */
async function findShareRequestForAdditionalDocs(memberId, requestNumber) {
    const pool = await getPool();
    const r = await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .input('requestNumber', sql.NVarChar, String(requestNumber).trim())
        .query(`
            SELECT sr.ShareRequestId, sr.VendorId
            FROM oe.ShareRequests sr
            INNER JOIN oe.Members m ON m.MemberId = @memberId
            WHERE sr.HouseholdId = m.HouseholdId
            AND sr.RequestNumber = @requestNumber
        `);
    if (r.recordset.length !== 1) {
        return null;
    }
    return r.recordset[0];
}

/**
 * Attach uploaded files (metadata in PublicFormSubmissionFiles) to ShareRequest documents.
 */
async function attachSubmissionFilesToShareRequest(shareRequestId, submissionId, actorUserId) {
    const pool = await getPool();
    const files = await pool.request()
        .input('submissionId', sql.UniqueIdentifier, submissionId)
        .query(`
            SELECT FileId, OriginalFileName, ContentType, FileSizeBytes, BlobUrl, BlobPath
            FROM oe.PublicFormSubmissionFiles
            WHERE SubmissionId = @submissionId
        `);

    for (const f of files.recordset) {
        await ShareRequestService.createDocument(
            shareRequestId,
            {
                documentName: f.OriginalFileName,
                documentType: 'MemberUpload',
                fileName: f.OriginalFileName,
                fileSize: f.FileSizeBytes,
                mimeType: f.ContentType,
                blobUrl: f.BlobUrl,
                blobPath: f.BlobPath,
                description: 'Uploaded via public sharing form',
                uploadedBy: 'Member'
            },
            actorUserId
        );
    }
}

/**
 * Pull the structured editable SR fields out of a form payload. First
 * non-empty match wins across all known branches — branches the member
 * didn't take leave their fields empty, so the precedence order doesn't
 * matter for any single submission.
 *
 * Returns the field set that `createShareRequest({ ... })` accepts; pass it
 * straight in. All fields default to null when the form didn't ask the
 * member (e.g. a maternity-only field on a surgery submission).
 */
function extractEditableSrFields(payload) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const firstStr = (...keys) => {
        for (const k of keys) {
            const v = p[k];
            if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
        }
        return null;
    };
    const yesNoBool = (...keys) => {
        for (const k of keys) {
            const v = p[k];
            if (v === null || v === undefined) continue;
            const s = String(v).trim().toLowerCase();
            if (s === 'yes' || s === 'true' || s === '1') return true;
            if (s === 'no' || s === 'false' || s === '0') return false;
        }
        return null;
    };
    // The relation-to-primary-member select on Claude's Form (Copy) uses a
    // generated name. Look it up by checking for any select field name that
    // matches the legacy field-id prefix or starts with `relation_`. We
    // scan all keys rather than hardcode, since the field name will likely
    // change across future form variants.
    let relationToPrimary = null;
    for (const k of Object.keys(p)) {
        if (/^field_/.test(k) || /relation/i.test(k)) {
            const v = p[k];
            if (typeof v === 'string' && v.trim() && /^(self|spouse|child|dependent|other|partner)/i.test(v.trim())) {
                relationToPrimary = v.trim();
                break;
            }
        }
    }
    // Detect an anatomy-selector value by shape: scan for the first object
    // with a non-empty procedureName string and a cptCodes array.
    let anatomyProcedureName = null;
    for (const v of Object.values(p)) {
        if (
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            typeof v.procedureName === 'string' &&
            Array.isArray(v.cptCodes)
        ) {
            anatomyProcedureName = v.procedureName.trim() || null;
            break;
        }
    }

    return {
        procedureName: firstStr('surg_procedure', 'post_procedure') || anatomyProcedureName,
        eventNarrative: firstStr(
            'surg_description', 'post_description', 'mat_description',
            'other_description', 'er_reason'
        ),
        symptomsBeganDate: firstStr('req_symptoms_began'),
        isNewCondition: firstStr('req_is_new_condition'),
        otherInsurance: firstStr('req_other_insurance'),
        wouldSwitchDoctor: yesNoBool('surg_switch_doctor'),
        erCharityCareApplied: firstStr('er_fa_applied'),
        maternityDeliveryStatus: firstStr('mat_delivery_status'),
        surgeonInNetwork: yesNoBool('surg_in_network'),
        patientRelationToPrimary: relationToPrimary
    };
}

/**
 * Find-or-create an `oe.Providers` row matching the member's provider_search
 * value. Three-tier dedup, first match wins:
 *
 *   1. Match by NPI within the vendor (exact).
 *   2. Match by case-insensitive name + city + state within the vendor.
 *   3. Match by case-insensitive name on any provider already linked to a
 *      prior ShareRequest of this patient's household.
 *
 * Returns the `oe.Providers.ProviderId` to use. When step 4 fires (a brand
 * new row is created) the form's adjacent `*_tax_id` text — if present and
 * the new row is being seeded fresh — is written into `TaxId`. We never
 * overwrite a non-null TaxId on an existing row from form text.
 */
async function findOrCreateProviderForFormValue(pool, {
    vendorId,
    householdId,
    providerValue,
    taxIdFromForm,
    actorUserId
}) {
    if (!providerValue || typeof providerValue !== 'object') return null;
    const npi = providerValue.npi && String(providerValue.npi).trim()
        ? String(providerValue.npi).trim() : null;
    const providerName = providerValue.name && String(providerValue.name).trim()
        ? String(providerValue.name).trim() : null;
    if (!providerName) return null;

    // Tier 1 — by NPI within the vendor.
    if (npi) {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('npi', sql.NVarChar(20), npi)
            .query(`SELECT TOP 1 ProviderId FROM oe.Providers
                    WHERE VendorId = @vendorId AND NPI = @npi`);
        if (r.recordset[0]) return r.recordset[0].ProviderId;
    }

    // Tier 2 — by name+city+state within the vendor (case-insensitive).
    const city = providerValue.city && String(providerValue.city).trim()
        ? String(providerValue.city).trim() : null;
    const state = providerValue.state && String(providerValue.state).trim()
        ? String(providerValue.state).trim() : null;
    {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('name', sql.NVarChar(500), providerName)
            .input('city', sql.NVarChar(200), city)
            .input('state', sql.NVarChar(20), state)
            .query(`SELECT TOP 1 ProviderId FROM oe.Providers
                    WHERE VendorId = @vendorId
                      AND LOWER(LTRIM(RTRIM(ProviderName))) = LOWER(LTRIM(RTRIM(@name)))
                      AND (
                            (City IS NULL AND @city IS NULL)
                         OR LOWER(LTRIM(RTRIM(City))) = LOWER(LTRIM(RTRIM(@city)))
                      )
                      AND (
                            (State IS NULL AND @state IS NULL)
                         OR LOWER(LTRIM(RTRIM(State))) = LOWER(LTRIM(RTRIM(@state)))
                      )`);
        if (r.recordset[0]) return r.recordset[0].ProviderId;
    }

    // Tier 3 — patient-scoped: any provider this household has used before,
    // matched on name (vendor-scoped, since SRs are vendor-scoped).
    if (householdId) {
        const r = await pool.request()
            .input('vendorId', sql.UniqueIdentifier, vendorId)
            .input('householdId', sql.UniqueIdentifier, householdId)
            .input('name', sql.NVarChar(500), providerName)
            .query(`SELECT TOP 1 p.ProviderId
                    FROM oe.Providers p
                    INNER JOIN oe.ShareRequestProviders srp ON srp.ProviderId = p.ProviderId
                    INNER JOIN oe.ShareRequests sr ON sr.ShareRequestId = srp.ShareRequestId
                    WHERE p.VendorId = @vendorId
                      AND sr.HouseholdId = @householdId
                      AND LOWER(LTRIM(RTRIM(p.ProviderName))) = LOWER(LTRIM(RTRIM(@name)))`);
        if (r.recordset[0]) return r.recordset[0].ProviderId;
    }

    // Tier 4 — create a new Provider row from the form value.
    const providerId = crypto.randomUUID();
    await pool.request()
        .input('providerId', sql.UniqueIdentifier, providerId)
        .input('vendorId', sql.UniqueIdentifier, vendorId)
        .input('providerName', sql.NVarChar(500), providerName)
        .input('providerType', sql.NVarChar(50), providerValue.providerType || null)
        .input('npi', sql.NVarChar(20), npi)
        .input('taxId', sql.NVarChar(50), taxIdFromForm || null)
        .input('phone', sql.NVarChar(50), providerValue.phone || null)
        .input('fax', sql.NVarChar(50), providerValue.fax || null)
        .input('address1', sql.NVarChar(500), providerValue.address1 || null)
        .input('address2', sql.NVarChar(500), providerValue.address2 || null)
        .input('city', sql.NVarChar(200), city)
        .input('state', sql.NVarChar(20), state)
        .input('zipCode', sql.NVarChar(20), providerValue.zip || null)
        .input('createdBy', sql.UniqueIdentifier, actorUserId || null)
        .query(`
            INSERT INTO oe.Providers (
                ProviderId, VendorId, ProviderName, ProviderType, NPI, TaxId,
                Phone, Fax, Address1, Address2, City, State, ZipCode, Country, IsActive,
                CreatedDate, CreatedBy
            ) VALUES (
                @providerId, @vendorId, @providerName, @providerType, @npi, @taxId,
                @phone, @fax, @address1, @address2, @city, @state, @zipCode, 'USA', 1,
                GETDATE(), @createdBy
            )
        `);
    return providerId;
}

/**
 * Walk a form payload, link every recognised provider_search value to the
 * freshly-created ShareRequest. Skips already-linked (sr, provider, role)
 * triplets so a re-process / re-submit doesn't double the rows. Best-effort;
 * a per-field failure is logged and the others continue.
 */
async function linkProvidersFromPayload({
    shareRequestId,
    vendorId,
    householdId,
    payload,
    actorUserId
}) {
    if (!payload || typeof payload !== 'object') return;
    const pool = await getPool();
    for (const [fieldName, role] of Object.entries(PROVIDER_FIELD_TO_ROLE)) {
        const value = payload[fieldName];
        if (!value || typeof value !== 'object' || !value.name) continue;
        try {
            const taxKey = PROVIDER_TAX_ID_PAIRS[fieldName];
            const taxIdFromForm = taxKey && payload[taxKey]
                ? String(payload[taxKey]).trim() : null;
            const providerId = await findOrCreateProviderForFormValue(pool, {
                vendorId,
                householdId,
                providerValue: value,
                taxIdFromForm,
                actorUserId
            });
            if (!providerId) continue;

            // Idempotent insert — skip if this (SR, Provider, Role) already
            // exists. Different roles on the same SR for the same provider
            // are allowed.
            const existing = await pool.request()
                .input('srId', sql.UniqueIdentifier, shareRequestId)
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('role', sql.NVarChar(100), role)
                .query(`SELECT TOP 1 ShareRequestProviderId FROM oe.ShareRequestProviders
                        WHERE ShareRequestId = @srId AND ProviderId = @providerId AND ProviderRole = @role`);
            if (existing.recordset[0]) continue;

            await pool.request()
                .input('linkId', sql.UniqueIdentifier, crypto.randomUUID())
                .input('srId', sql.UniqueIdentifier, shareRequestId)
                .input('providerId', sql.UniqueIdentifier, providerId)
                .input('role', sql.NVarChar(100), role)
                .input('createdBy', sql.UniqueIdentifier, actorUserId || null)
                .query(`
                    INSERT INTO oe.ShareRequestProviders (
                        ShareRequestProviderId, ShareRequestId, ProviderId, ProviderRole,
                        CreatedDate, CreatedBy
                    ) VALUES (@linkId, @srId, @providerId, @role, GETDATE(), @createdBy)
                `);

            // If the existing Provider row has a NULL TaxId and the form
            // carries a value, fill it in (form text never overrides an
            // existing TaxId — back office wins).
            if (taxKey && payload[taxKey]) {
                await pool.request()
                    .input('providerId', sql.UniqueIdentifier, providerId)
                    .input('taxId', sql.NVarChar(50), String(payload[taxKey]).trim())
                    .query(`UPDATE oe.Providers SET TaxId = @taxId
                            WHERE ProviderId = @providerId AND TaxId IS NULL`);
            }

            // Same rule for Fax — only fill when the row's Fax is NULL. The
            // value now comes from the registry-backed provider_search value.
            const faxFromValue = value.fax ? String(value.fax).trim() : null;
            if (faxFromValue) {
                await pool.request()
                    .input('providerId', sql.UniqueIdentifier, providerId)
                    .input('fax', sql.NVarChar(50), faxFromValue)
                    .query(`UPDATE oe.Providers SET Fax = @fax
                            WHERE ProviderId = @providerId AND Fax IS NULL`);
            }
        } catch (linkErr) {
            console.warn(
                `linkProvidersFromPayload: ${fieldName} link failed`,
                linkErr.message
            );
        }
    }
}

/**
 * Walk a form payload, find anatomy-selector value(s) by shape, and insert
 * one oe.ShareRequestProcedures row per CPT code found. Best-effort — never
 * blocks SR creation. Mirror pattern of linkProvidersFromPayload.
 */
async function linkProceduresFromPayload(pool, { shareRequestId, payload, createdBy }) {
    if (!payload || typeof payload !== 'object') return;
    let sortOrder = 0;
    for (const v of Object.values(payload)) {
        if (
            v === null ||
            typeof v !== 'object' ||
            Array.isArray(v) ||
            typeof v.procedureName !== 'string' ||
            !Array.isArray(v.cptCodes)
        ) continue;

        const procedureName = v.procedureName.trim();
        const rawCode = v.cptCodes[0];
        if (!rawCode) {
            // No CPT codes — procedureName still lands on ShareRequests.ProcedureName
            // via extractEditableSrFields; nothing to insert here.
            sortOrder += 1;
            continue;
        }
        // Strip range suffix (e.g. '29870-29887' -> '29870').
        const cptCode = String(rawCode).split('-')[0].trim();
        if (!cptCode) { sortOrder += 1; continue; }

        try {
            const procedureId = crypto.randomUUID();
            await pool.request()
                .input('procedureId', sql.UniqueIdentifier, procedureId)
                .input('shareRequestId', sql.UniqueIdentifier, shareRequestId)
                .input('cptCode', sql.NVarChar(20), cptCode)
                .input('description', sql.NVarChar(500), procedureName || null)
                .input('sortOrder', sql.Int, sortOrder)
                .input('createdBy', sql.UniqueIdentifier, createdBy || null)
                .query(`
                    INSERT INTO oe.ShareRequestProcedures (
                        ProcedureId, ShareRequestId, CPTCode, Description,
                        SortOrder, CreatedDate, CreatedBy
                    ) VALUES (
                        @procedureId, @shareRequestId, @cptCode, @description,
                        @sortOrder, GETDATE(), @createdBy
                    )
                `);
        } catch (procErr) {
            console.warn(
                'linkProceduresFromPayload: procedure insert failed',
                procErr.message
            );
        }
        sortOrder += 1;
    }
}

/**
 * Create a Case from a public-form submission. Mirrors the SR-create path:
 * fetches the household, resolves a subcategory from a known form field name,
 * and attaches uploaded files to the resulting case (best-effort).
 */
async function createCaseFromSubmission({
    submissionId,
    vendorId,
    memberId,
    payload,
    actorUserId,
    needsMemberMatch = false
}) {
    // Subcategory: the form's Copay-vs-Preventative radio. We look for a few
    // common field-name variants so a form can rename the field without
    // breaking routing — both `prev_reimbursement_type` (the combined form's
    // name) and `reimbursementType` are accepted.
    const rawSub = (payload?.prev_reimbursement_type
        || payload?.reimbursementType
        || ''
    ).toString().trim().toLowerCase();
    const caseSubcategory = rawSub === 'oon_copay' || rawSub === 'preventative' ? rawSub : 'preventative';

    const titleBase = `${payload?.firstName || payload?.ay_first_name || ''} ${payload?.lastName || payload?.ay_last_name || ''}`.trim();
    const title = titleBase
        ? `Reimbursement — ${titleBase}`
        : 'Reimbursement — public form submission';

    const description = [
        payload?.prev_reason,
        payload?.requestDescription,
        payload?.additionalNotes
    ].filter(Boolean).join('\n\n') || null;

    const result = await CaseService.createCase(vendorId, {
        memberId,
        title,
        description,
        status: 'New',
        caseType: 'reimbursement',
        caseSubcategory,
        subcategoryDetail: null,
        userId: actorUserId,
        userName: 'Public form submission',
        createdVia: 'form',
        needsMemberMatch
    });

    const caseId = result?.caseId || result?.CaseId || null;
    if (caseId) {
        // Stamp the submission with LinkedCaseId so the UI can deep-link.
        const pool = await getPool();
        await pool.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('caseId', sql.UniqueIdentifier, caseId)
            .query(`
                UPDATE oe.PublicFormSubmissions
                SET LinkedCaseId = @caseId,
                    LinkedDate = SYSUTCDATETIME(),
                    LinkError = NULL
                WHERE SubmissionId = @submissionId
            `);
    }
    return { caseId };
}

/**
 * Attempt ShareRequest create or document attach; updates oe.PublicFormSubmissions.
 */
async function linkSubmissionToShareWorkflow({
    submissionId,
    tenantId,
    formTemplateId,
    formKind,
    memberId,
    vendorIdOverride,
    payload,
    actorUserId,
    def = null,
    // True when the resolver couldn't match a member: create a member-less "shell"
    // SR/Case flagged NeedsMemberMatch instead of skipping the back-office workflow.
    needsMemberMatch = false
}) {
    const pool = await getPool();
    // No member to read enrollments from on the unmatched path — the shell's vendor
    // comes solely from the form's Default Vendor (vendorIdOverride).
    let vendorId = vendorIdOverride || (memberId ? await resolveVendorIdForMember(memberId) : null);

    // Per-option router. When the form has an answered prescreen option that
    // sets `autoCreateOnSubmit`, that pins which path can fire (the other is
    // suppressed). When no answered option pins one, both template flags are
    // honored independently — the pre-A/B legacy behavior for single-purpose
    // forms.
    const preScreenAnswers = (payload && typeof payload === 'object') ? payload.__preScreenAnswers : null;
    const optionRoute = detectAutoCreateRoute(def, preScreenAnswers);
    const preScreenSrTypeHint = extractSrTypeHintFromAnswers(def, preScreenAnswers);

    let createsSr = false;
    let createsCase = false;
    if (formKind !== 'AdditionalDocuments' && formTemplateId) {
        const flagRow = (await pool.request()
            .input('id', sql.UniqueIdentifier, formTemplateId)
            .input('tenantId', sql.UniqueIdentifier, tenantId)
            .query(`SELECT CreatesShareRequestOnSubmit, CreatesCaseOnSubmit FROM oe.PublicFormTemplates WHERE FormTemplateId = @id AND TenantId = @tenantId`)).recordset[0];
        createsSr = Boolean(flagRow?.CreatesShareRequestOnSubmit);
        createsCase = Boolean(flagRow?.CreatesCaseOnSubmit);
        // The answered option's directive overrides which path fires. The
        // template-level flag still acts as a master enable — an option that
        // pins `'shareRequest'` only creates one if the template allows SRs.
        if (optionRoute === 'shareRequest') createsCase = false;
        else if (optionRoute === 'case') createsSr = false;
        else if (optionRoute === 'none') { createsSr = false; createsCase = false; }
        if (!createsSr && !createsCase) {
            return { success: true, skipped: true, reason: 'auto_create_off' };
        }
    }

    const setLinkError = async (message) => {
        await pool.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('err', sql.NVarChar, message)
            .query(`
                UPDATE oe.PublicFormSubmissions
                SET LinkError = @err, LinkedDate = SYSUTCDATETIME()
                WHERE SubmissionId = @submissionId
            `);
    };

    if (!vendorId) {
        await setLinkError('No active vendor product found for member; set Default Vendor on the form template or resolve enrollments.');
        return { success: false, reason: 'no_vendor' };
    }

    try {
        // Additional-documents submissions attach to an EXISTING share request found
        // via the member — impossible without a matched member. Leave for manual review.
        if (needsMemberMatch && formKind === 'AdditionalDocuments') {
            await setLinkError('Unmatched additional-documents submission — needs a matched member to attach to; left for manual review.');
            return { success: false, reason: 'unmatched_additional_docs' };
        }
        if (formKind === 'AdditionalDocuments') {
            const ok = await verifyMemberVerifiers(memberId, payload);
            if (!ok) {
                await setLinkError('Verification failed: last name or date of birth does not match member record.');
                return { success: false, reason: 'verify_failed' };
            }
            const sr = await findShareRequestForAdditionalDocs(memberId, payload.existingRequestNumber);
            if (!sr) {
                await setLinkError('Share request number not found for this member household.');
                return { success: false, reason: 'request_not_found' };
            }
            if (String(sr.VendorId).toLowerCase() !== String(vendorId).toLowerCase()) {
                // Still attach to the matched SR's vendor (authoritative)
                vendorId = sr.VendorId;
            }
            await attachSubmissionFilesToShareRequest(sr.ShareRequestId, submissionId, actorUserId);
            await pool.request()
                .input('submissionId', sql.UniqueIdentifier, submissionId)
                .input('srId', sql.UniqueIdentifier, sr.ShareRequestId)
                .query(`
                    UPDATE oe.PublicFormSubmissions
                    SET ShareRequestId = @srId,
                        LinkedDate = SYSUTCDATETIME(),
                        LinkError = NULL
                    WHERE SubmissionId = @submissionId
                `);
            const note = (payload.notes || '').toString().trim();
            if (note) {
                await ShareRequestService.addNote(
                    sr.ShareRequestId,
                    'SystemActivity',
                    `Public form additional documents: ${note}`,
                    true,
                    actorUserId
                );
            }
            return { success: true, shareRequestId: sr.ShareRequestId };
        }

        // Preventative branch: auto-create a Case, no ShareRequest.
        if (createsCase && !createsSr) {
            try {
                const { caseId } = await createCaseFromSubmission({
                    submissionId,
                    vendorId,
                    memberId,
                    payload,
                    actorUserId,
                    needsMemberMatch
                });
                return { success: true, caseId };
            } catch (caseErr) {
                console.error('linkSubmissionToShareWorkflow case create error:', caseErr);
                await setLinkError(caseErr.message || 'Case create failed');
                return { success: false, reason: 'case_exception', error: caseErr.message };
            }
        }
        // Both flags on and no A/B answer (legacy/back-compat row): create
        // both. Keeps existing single-purpose forms behaving exactly as before
        // when only one flag is set; only matters if an author flips both on.

        const householdResult = await pool.request()
            .input('memberId', sql.UniqueIdentifier, memberId)
            .query('SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId');
        const householdId = householdResult.recordset[0]?.HouseholdId || null;

        const { typeId: requestTypeId } =
            await resolveRequestTypeIdForPayload(vendorId, formKind, payload, preScreenSrTypeHint);
        const requestName = `${payload.firstName || ''} ${payload.lastName || ''}`.trim() || 'Public form submission';
        const requestDescription = [
            payload.detailedDescription,
            payload.requestDescription,
            payload.additionalNotes
        ].filter(Boolean).join('\n\n') || null;

        // Member-stated UA — the tier the member picked on the public form.
        // Persisted to oe.ShareRequests.MemberStatedUA so the back-office team
        // can compare it to the member's current plan UA without having to
        // crack open the encrypted submission. Accepts the explicit form-field
        // name `req_ua_tier`, the legacy `uaTier`, or any field whose name
        // ends with `_ua_tier` so future forms don't have to use the same key.
        let memberStatedUA = null;
        const tryKeys = ['req_ua_tier', 'uaTier'];
        for (const k of tryKeys) {
            if (payload[k] != null && String(payload[k]).trim()) {
                memberStatedUA = String(payload[k]).trim();
                break;
            }
        }
        if (!memberStatedUA) {
            for (const k of Object.keys(payload || {})) {
                if (/_ua_tier$/i.test(k) && payload[k] != null && String(payload[k]).trim()) {
                    memberStatedUA = String(payload[k]).trim();
                    break;
                }
            }
        }

        const editableFields = extractEditableSrFields(payload);
        const created = await ShareRequestService.createShareRequest(
            vendorId,
            {
                memberId,
                householdId,
                needsMemberMatch,
                requestName,
                requestDescription,
                requestTypeId,
                ...editableFields,
                status: 'New',
                determination: 'Pending',
                dateOfService: payload.dateOfService ? new Date(payload.dateOfService) : null,
                dateOfServiceEnd: null,
                generalNotes: [
                    payload.providerInformation && `Providers: ${payload.providerInformation}`,
                    payload.uaTier && `UA tier selected: ${payload.uaTier}`,
                    payload.otherInsurance && `Other insurance: ${payload.otherInsurance}`,
                    payload.isNewCondition && `New condition: ${payload.isNewCondition}`,
                    payload.symptomsStartDate && `Symptoms/care start: ${payload.symptomsStartDate}`
                ].filter(Boolean).join('\n') || null,
                memberStatedUA,
                createdVia: 'form'
            },
            actorUserId
        );

        await attachSubmissionFilesToShareRequest(created.shareRequestId, submissionId, actorUserId);

        // Best-effort: auto-link every provider_search value on the payload
        // to the new SR via oe.ShareRequestProviders. Three-tier dedup +
        // idempotent — re-processing a submission won't double rows.
        try {
            await linkProvidersFromPayload({
                shareRequestId: created.shareRequestId,
                vendorId,
                householdId,
                payload,
                actorUserId
            });
        } catch (provErr) {
            console.warn(
                'publicFormShareLinkService: provider auto-link failed',
                provErr.message
            );
        }

        // Best-effort: auto-link anatomy-selector CPT code(s) to the new SR
        // via oe.ShareRequestProcedures. Failures never block the flow.
        try {
            await linkProceduresFromPayload(pool, {
                shareRequestId: created.shareRequestId,
                payload,
                createdBy: actorUserId
            });
        } catch (procErr) {
            console.warn(
                'publicFormShareLinkService: procedure auto-link failed',
                procErr.message
            );
        }

        // Best-effort: pull ACH direct-deposit fields off the payload and
        // persist as a member-scoped record. Rolls up to household primary.
        // Failures here must not fail the submission flow itself.
        try {
            await memberDirectDepositService.upsertFromPayload({
                memberId,
                tenantId,
                payload,
                sourceSubmissionId: submissionId,
                actorUserId
            });
        } catch (ddErr) {
            console.warn(
                'publicFormShareLinkService: direct-deposit upsert failed',
                ddErr.message
            );
        }

        await pool.request()
            .input('submissionId', sql.UniqueIdentifier, submissionId)
            .input('srId', sql.UniqueIdentifier, created.shareRequestId)
            .query(`
                UPDATE oe.PublicFormSubmissions
                SET ShareRequestId = @srId,
                    LinkedDate = SYSUTCDATETIME(),
                    LinkError = NULL
                WHERE SubmissionId = @submissionId
            `);

        // Back-compat: both flags on and no A/B answer pinned a route → also
        // spawn a Case in parallel. The A/B-decided cases are handled earlier.
        let extraCaseId = null;
        if (createsCase) {
            try {
                const r = await createCaseFromSubmission({
                    submissionId,
                    vendorId,
                    memberId,
                    payload,
                    actorUserId
                });
                extraCaseId = r?.caseId || null;
            } catch (caseErr) {
                console.warn('linkSubmissionToShareWorkflow parallel case create failed:', caseErr.message);
            }
        }

        return {
            success: true,
            shareRequestId: created.shareRequestId,
            requestNumber: created.requestNumber,
            ...(extraCaseId ? { caseId: extraCaseId } : {})
        };
    } catch (e) {
        console.error('linkSubmissionToShareWorkflow error:', e);
        await setLinkError(e.message || 'Link failed');
        return { success: false, reason: 'exception', error: e.message };
    }
}

/**
 * When a staffer matches a member to a submission that already produced a
 * member-less "shell" SR/Case (NeedsMemberMatch=1), backfill that existing row in
 * place — set the real member/household and clear the flag — instead of creating a
 * duplicate. Returns { backfilled, shareRequestId?, caseId? }.
 */
async function backfillUnmatchedShellMember({ submissionId, memberId }) {
    const pool = await getPool();
    const sub = (await pool.request()
        .input('submissionId', sql.UniqueIdentifier, submissionId)
        .query('SELECT ShareRequestId, LinkedCaseId FROM oe.PublicFormSubmissions WHERE SubmissionId = @submissionId')).recordset[0];
    if (!sub) return { backfilled: false };

    const householdId = (await pool.request()
        .input('memberId', sql.UniqueIdentifier, memberId)
        .query('SELECT HouseholdId FROM oe.Members WHERE MemberId = @memberId')).recordset[0]?.HouseholdId || null;

    if (sub.ShareRequestId) {
        const upd = await pool.request()
            .input('srId', sql.UniqueIdentifier, sub.ShareRequestId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('householdId', sql.UniqueIdentifier, householdId)
            .query(`UPDATE oe.ShareRequests SET MemberId=@memberId, HouseholdId=@householdId, NeedsMemberMatch=0
                    WHERE ShareRequestId=@srId AND NeedsMemberMatch=1`);
        if (upd.rowsAffected[0] > 0) return { backfilled: true, shareRequestId: sub.ShareRequestId };
    }
    if (sub.LinkedCaseId) {
        const upd = await pool.request()
            .input('caseId', sql.UniqueIdentifier, sub.LinkedCaseId)
            .input('memberId', sql.UniqueIdentifier, memberId)
            .input('householdId', sql.UniqueIdentifier, householdId)
            .query(`UPDATE oe.Cases SET MemberId=@memberId, HouseholdId=@householdId, NeedsMemberMatch=0
                    WHERE CaseId=@caseId AND NeedsMemberMatch=1`);
        if (upd.rowsAffected[0] > 0) return { backfilled: true, caseId: sub.LinkedCaseId };
    }
    return { backfilled: false };
}

module.exports = {
    linkSubmissionToShareWorkflow,
    backfillUnmatchedShellMember,
    resolveRequestTypeIdForPayload,
    verifyMemberVerifiers,
    findShareRequestForAdditionalDocs,
    attachSubmissionFilesToShareRequest,
    linkProceduresFromPayload
};
