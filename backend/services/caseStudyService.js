// services/caseStudyService.js
// Business logic for vendor "Patient/Client Success Story" case studies (oe.CaseStudies).
// Scoped by VendorId. Auto-populates a draft from a completed share request; every field is
// editable in the modal. The 4 snapshot cells and 4 "how it happened" steps are stored as JSON.

const { getPool, sql } = require('../config/database');
const caseStudyAIService = require('./caseStudyAIService');

// Editable columns: API key (camelCase) -> { col, type }. JSON list fields handled separately.
const FIELD_SPECS = [
    { key: 'shareRequestId', col: 'ShareRequestId', type: () => sql.UniqueIdentifier },
    { key: 'brand', col: 'Brand', type: () => sql.NVarChar(50) },
    { key: 'category', col: 'Category', type: () => sql.NVarChar(100) },
    { key: 'headline', col: 'Headline', type: () => sql.NVarChar(500) },
    { key: 'heroLeftLabel', col: 'HeroLeftLabel', type: () => sql.NVarChar(100) },
    { key: 'heroLeftValue', col: 'HeroLeftValue', type: () => sql.Decimal(18, 2) },
    { key: 'heroRightLabel', col: 'HeroRightLabel', type: () => sql.NVarChar(100) },
    { key: 'heroRightValue', col: 'HeroRightValue', type: () => sql.Decimal(18, 2) },
    { key: 'percentValue', col: 'PercentValue', type: () => sql.Int },
    { key: 'percentLabel', col: 'PercentLabel', type: () => sql.NVarChar(50) },
    { key: 'percentSavedShared', col: 'PercentSavedShared', type: () => sql.Decimal(5, 2) },
    { key: 'briefDescription', col: 'BriefDescription', type: () => sql.NVarChar(sql.MAX) },
    { key: 'outcomeParagraph', col: 'OutcomeParagraph', type: () => sql.NVarChar(sql.MAX) },
    { key: 'procedureType', col: 'ProcedureType', type: () => sql.NVarChar(255) },
    { key: 'cptCodes', col: 'CptCodes', type: () => sql.NVarChar(255) },
    { key: 'totalBilledAmount', col: 'TotalBilledAmount', type: () => sql.Decimal(18, 2) },
    { key: 'totalPaidToProvider', col: 'TotalPaidToProvider', type: () => sql.Decimal(18, 2) },
    { key: 'amountSharedByPlan', col: 'AmountSharedByPlan', type: () => sql.Decimal(18, 2) },
    { key: 'patientPaidAmount', col: 'PatientPaidAmount', type: () => sql.Decimal(18, 2) },
    { key: 'unsharedAmount', col: 'UnsharedAmount', type: () => sql.Decimal(18, 2) },
    { key: 'patientQuote', col: 'PatientQuote', type: () => sql.NVarChar(sql.MAX) },
    { key: 'quoteAttribution', col: 'QuoteAttribution', type: () => sql.NVarChar(200) },
    { key: 'storyDate', col: 'StoryDate', type: () => sql.Date },
    { key: 'status', col: 'Status', type: () => sql.NVarChar(20) },
];

const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

function parseJsonArray(raw) {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

// DB row -> normalized camelCase object for the API/frontend
function mapRow(r) {
    if (!r) return null;
    return {
        caseStudyId: r.CaseStudyId,
        vendorId: r.VendorId,
        shareRequestId: r.ShareRequestId,
        brand: r.Brand,
        category: r.Category,
        headline: r.Headline,
        heroLeftLabel: r.HeroLeftLabel,
        heroLeftValue: r.HeroLeftValue,
        heroRightLabel: r.HeroRightLabel,
        heroRightValue: r.HeroRightValue,
        percentValue: r.PercentValue,
        percentLabel: r.PercentLabel,
        percentSavedShared: r.PercentSavedShared,
        briefDescription: r.BriefDescription,
        outcomeParagraph: r.OutcomeParagraph,
        procedureType: r.ProcedureType,
        cptCodes: r.CptCodes,
        totalBilledAmount: r.TotalBilledAmount,
        totalPaidToProvider: r.TotalPaidToProvider,
        amountSharedByPlan: r.AmountSharedByPlan,
        patientPaidAmount: r.PatientPaidAmount,
        unsharedAmount: r.UnsharedAmount,
        patientQuote: r.PatientQuote,
        quoteAttribution: r.QuoteAttribution,
        snapshotCells: parseJsonArray(r.SnapshotCellsJson),
        howItHappened: parseJsonArray(r.HowItHappenedJson),
        storyDate: r.StoryDate,
        status: r.Status,
        isPublished: r.IsPublished,
        publishedDate: r.PublishedDate,
        createdBy: r.CreatedBy,
        createdDate: r.CreatedDate,
        modifiedBy: r.ModifiedBy,
        modifiedDate: r.ModifiedDate,
    };
}

const SELECT_COLS = `
    CaseStudyId, VendorId, ShareRequestId, Brand, Category, Headline,
    HeroLeftLabel, HeroLeftValue, HeroRightLabel, HeroRightValue,
    PercentValue, PercentLabel, PercentSavedShared,
    BriefDescription, OutcomeParagraph, ProcedureType, CptCodes,
    TotalBilledAmount, TotalPaidToProvider, AmountSharedByPlan, PatientPaidAmount, UnsharedAmount,
    PatientQuote, QuoteAttribution, SnapshotCellsJson, HowItHappenedJson,
    StoryDate, Status, IsPublished, PublishedDate,
    CreatedBy, CreatedDate, ModifiedBy, ModifiedDate`;

const CaseStudyService = {
    /**
     * Build a draft case study auto-populated from a completed share request.
     * Returns null if the SR is not found for this vendor.
     */
    async getPrefill(shareRequestId, vendorId) {
        const pool = await getPool();
        const srReq = pool.request();
        srReq.input('id', sql.UniqueIdentifier, shareRequestId);
        srReq.input('vendorId', sql.UniqueIdentifier, vendorId);
        const srRes = await srReq.query(`
            SELECT TOP 1 ShareRequestId, RequestName, ProcedureName, Description,
                   EventNarrative, DateOfService, DateOfServiceEnd, CompletedDate,
                   TotalBilledAmount, TotalDiscounts, TotalUAAmount, IncidentUAAmount,
                   TotalShareAmount, TotalPaidAmount, TotalMemberPayments, MaternityDeliveryStatus
            FROM oe.ShareRequests
            WHERE ShareRequestId = @id AND VendorId = @vendorId
        `);
        if (srRes.recordset.length === 0) return null;
        const sr = srRes.recordset[0];

        const procReq = pool.request();
        procReq.input('id', sql.UniqueIdentifier, shareRequestId);
        const procRes = await procReq.query(`
            SELECT CPTCode, Description FROM oe.ShareRequestProcedures
            WHERE ShareRequestId = @id ORDER BY SortOrder
        `);
        const procedures = procRes.recordset;
        const cptCodes = procedures.map((p) => p.CPTCode).filter(Boolean).join(', ');

        // Diagnoses moved off oe.ShareRequests (2026-06-10 coding revamp) into
        // oe.ShareRequestDiagnoses; use the primary one for the narrative fallback.
        const diagReq = pool.request();
        diagReq.input('id', sql.UniqueIdentifier, shareRequestId);
        const diagRes = await diagReq.query(`
            SELECT ICD10Code, Description FROM oe.ShareRequestDiagnoses
            WHERE ShareRequestId = @id
            ORDER BY IsPrimary DESC, SortOrder ASC
        `);
        const primaryDiagnosis = diagRes.recordset[0] || null;
        const diagnosisDescription = primaryDiagnosis
            ? (primaryDiagnosis.Description || primaryDiagnosis.ICD10Code)
            : null;

        const billed = sr.TotalBilledAmount != null ? Number(sr.TotalBilledAmount) : null;
        // Total Paid = what the bill was negotiated down to (paid to the provider).
        const totalPaid = sr.TotalPaidAmount != null ? Number(sr.TotalPaidAmount) : null;
        const ua = sr.TotalUAAmount != null ? Number(sr.TotalUAAmount)
            : (sr.IncidentUAAmount != null ? Number(sr.IncidentUAAmount) : null);

        // Patient paid: typically the Unshared Amount, but capped at the total bill
        // (a member never pays more than the bill). Falls back to recorded member payments.
        let patientPaid = null;
        if (ua != null) {
            patientPaid = billed != null ? Math.min(billed, ua) : ua;
        } else if (sr.TotalMemberPayments != null) {
            patientPaid = Number(sr.TotalMemberPayments);
        }

        // Percent saved = (bill − what the patient paid) / bill.
        let percentSaved = null;
        if (billed != null && billed > 0 && patientPaid != null) {
            percentSaved = round2(((billed - patientPaid) / billed) * 100);
        }
        const percentValue = percentSaved != null ? Math.round(percentSaved) : null;
        // Story date auto-populates to today (the date the case study is created).
        const storyDate = new Date().toISOString().slice(0, 10);

        // Deterministic fallbacks (used if the AI generation fails or is unavailable).
        let headline = '';
        let procedureType = sr.ProcedureName || (procedures[0] && procedures[0].Description) || '';
        let description = sr.EventNarrative || sr.Description || diagnosisDescription || '';

        // AI fill (Haiku) — autofills the editorial copy. Failures degrade gracefully.
        try {
            const ai = await caseStudyAIService.generate({
                procedureName: sr.ProcedureName,
                cptCodes,
                diagnosis: diagnosisDescription,
                totalBilled: billed,
                totalPaidToProvider: totalPaid,
                patientPaid,
                unsharedAmount: ua,
                percent: percentValue,
                percentLabel: 'SAVED',
                eventNarrative: sr.EventNarrative,
            });
            if (ai) {
                if (ai.headline) headline = ai.headline;
                if (ai.procedureType) procedureType = ai.procedureType;
                if (ai.description) description = ai.description;
            }
        } catch (e) {
            console.warn('⚠️ Case study AI generation failed, using deterministic defaults:', e.message);
        }

        return {
            shareRequestId: sr.ShareRequestId,
            headline,
            procedureType,
            cptCodes,
            storyDate,
            totalBilledAmount: billed != null ? round2(billed) : null,
            totalPaidToProvider: totalPaid != null ? round2(totalPaid) : null,
            unsharedAmount: ua != null ? round2(ua) : null,
            patientPaidAmount: patientPaid != null ? round2(patientPaid) : null,
            percentValue,
            percentLabel: 'SAVED',
            percentSavedShared: percentSaved,
            briefDescription: description,
            patientQuote: '',
            quoteAttribution: '— Anonymous Member',
            status: 'Draft',
        };
    },

    async getById(caseStudyId, vendorId) {
        const pool = await getPool();
        const req = pool.request();
        req.input('id', sql.UniqueIdentifier, caseStudyId);
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        const res = await req.query(`
            SELECT ${SELECT_COLS} FROM oe.CaseStudies
            WHERE CaseStudyId = @id AND VendorId = @vendorId
        `);
        return mapRow(res.recordset[0]);
    },

    async list(vendorId, { status, brand } = {}) {
        const pool = await getPool();
        const req = pool.request();
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        let where = 'WHERE VendorId = @vendorId';
        if (status) {
            req.input('status', sql.NVarChar(20), status);
            where += ' AND Status = @status';
        }
        if (brand) {
            req.input('brand', sql.NVarChar(50), brand);
            where += ' AND Brand = @brand';
        }
        const res = await req.query(`
            SELECT ${SELECT_COLS} FROM oe.CaseStudies
            ${where} ORDER BY ModifiedDate DESC
        `);
        return res.recordset.map(mapRow);
    },

    /**
     * Public, vendor-agnostic list of PUBLISHED case studies for a website brand.
     * No VendorId scoping — published case studies are public marketing content.
     */
    async listPublished({ brand } = {}) {
        const pool = await getPool();
        const req = pool.request();
        let where = 'WHERE IsPublished = 1';
        if (brand) {
            // A case study with Brand 'All' is shared marketing content and shows on
            // every brand's site (ShareWELL, MightyWELL, …); otherwise match the brand.
            req.input('brand', sql.NVarChar(50), brand);
            where += " AND (Brand = @brand OR Brand = 'All')";
        }
        const res = await req.query(`
            SELECT ${SELECT_COLS} FROM oe.CaseStudies
            ${where} ORDER BY PublishedDate DESC, StoryDate DESC
        `);
        return res.recordset.map(mapRow);
    },

    async create(vendorId, userId, data) {
        const pool = await getPool();
        const req = pool.request();
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        req.input('createdBy', sql.UniqueIdentifier, userId || null);
        req.input('snapshotCellsJson', sql.NVarChar(sql.MAX), JSON.stringify(data.snapshotCells || []));
        req.input('howItHappenedJson', sql.NVarChar(sql.MAX), JSON.stringify(data.howItHappened || []));

        const cols = ['VendorId', 'CreatedBy', 'SnapshotCellsJson', 'HowItHappenedJson'];
        const vals = ['@vendorId', '@createdBy', '@snapshotCellsJson', '@howItHappenedJson'];
        for (const f of FIELD_SPECS) {
            if (f.key === 'status') continue; // No draft state — status is always forced to Published below.
            if (data[f.key] === undefined) continue;
            req.input(f.key, f.type(), data[f.key] === '' ? null : data[f.key]);
            cols.push(f.col);
            vals.push(`@${f.key}`);
        }
        // Default Brand to the shared 'All' bucket so a new case study shows on every
        // brand site (ShareWELL + MightyWELL) unless a specific brand was provided.
        if (data.brand === undefined || data.brand === null || data.brand === '') {
            cols.push('Brand');
            vals.push("'All'");
        }
        // No draft state: every case study is published on create, whether it comes
        // from the Case Studies tab or from Share Request details.
        cols.push('Status', 'IsPublished', 'PublishedDate');
        vals.push("'Published'", '1', 'GETUTCDATE()');
        const res = await req.query(`
            INSERT INTO oe.CaseStudies (${cols.join(', ')})
            OUTPUT INSERTED.CaseStudyId
            VALUES (${vals.join(', ')})
        `);
        const newId = res.recordset[0].CaseStudyId;
        return this.getById(newId, vendorId);
    },

    async update(caseStudyId, vendorId, userId, data) {
        const pool = await getPool();
        const req = pool.request();
        req.input('id', sql.UniqueIdentifier, caseStudyId);
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        req.input('modifiedBy', sql.UniqueIdentifier, userId || null);

        const sets = ['ModifiedBy = @modifiedBy', 'ModifiedDate = GETUTCDATE()'];
        for (const f of FIELD_SPECS) {
            if (f.key === 'status') continue; // No draft state — status is always forced to Published below.
            if (data[f.key] === undefined) continue;
            req.input(f.key, f.type(), data[f.key] === '' ? null : data[f.key]);
            sets.push(`${f.col} = @${f.key}`);
        }
        if (data.snapshotCells !== undefined) {
            req.input('snapshotCellsJson', sql.NVarChar(sql.MAX), JSON.stringify(data.snapshotCells || []));
            sets.push('SnapshotCellsJson = @snapshotCellsJson');
        }
        if (data.howItHappened !== undefined) {
            req.input('howItHappenedJson', sql.NVarChar(sql.MAX), JSON.stringify(data.howItHappened || []));
            sets.push('HowItHappenedJson = @howItHappenedJson');
        }
        // No draft state: every case study stays published on edit, regardless of
        // any incoming status/isPublished value.
        sets.push("Status = 'Published'", 'IsPublished = 1', 'PublishedDate = COALESCE(PublishedDate, GETUTCDATE())');

        const res = await req.query(`
            UPDATE oe.CaseStudies SET ${sets.join(', ')}
            WHERE CaseStudyId = @id AND VendorId = @vendorId
        `);
        if (res.rowsAffected[0] === 0) return null;
        return this.getById(caseStudyId, vendorId);
    },

    /**
     * Hard-delete a case study (vendor-scoped). Once removed it disappears from the
     * public website endpoint on the next fetch. Returns true if a row was deleted.
     */
    async remove(caseStudyId, vendorId) {
        const pool = await getPool();
        const req = pool.request();
        req.input('id', sql.UniqueIdentifier, caseStudyId);
        req.input('vendorId', sql.UniqueIdentifier, vendorId);
        const res = await req.query(
            'DELETE FROM oe.CaseStudies WHERE CaseStudyId = @id AND VendorId = @vendorId'
        );
        return res.rowsAffected[0] > 0;
    },
};

module.exports = CaseStudyService;
