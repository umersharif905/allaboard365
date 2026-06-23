/**
 * One-time backfill: recover sharing requests that were dropped because the
 * member-resolver is scoped to the form's single tenant.
 *
 * Context: public "New Sharing Request" (UnsharedAmount) submissions whose
 * member card ID resolves to exactly ONE member in the system — but in a
 * tenant other than the form's tenant — were marked Unmatched and therefore
 * never created an oe.ShareRequests row (publicFormSubmissionService.js:578
 * only links on status === 'Matched'). This script re-resolves those
 * submissions and creates the missing share requests by reusing the real
 * production code path (linkSubmissionToShareWorkflow), so request numbers,
 * vendor resolution, household lookup, and file attachment all match live
 * behavior.
 *
 * SAFETY:
 *   - DRY-RUN by default. Prints exactly what it WOULD create and writes
 *     nothing. Set APPLY=1 to perform writes.
 *   - Targets ONLY FormKind='UnsharedAmount' templates with
 *     CreatesShareRequestOnSubmit=1 and CreatesCaseOnSubmit=0 (so no Cases
 *     are spawned), Unmatched, not already linked (ShareRequestId IS NULL),
 *     and whose card resolves to EXACTLY ONE member globally (no ambiguity).
 *   - linkSubmissionToShareWorkflow never decrypts the stored payload; we
 *     pass a minimal payload built from the plaintext search columns. Full
 *     PHI remains viewable in-app via the linked submission.
 *
 * Run (dry-run):
 *   set -a; source ai_scripts/.env; set +a
 *   NODE_ENV=production DB_SERVER="$DB_SERVER" DB_NAME=allaboard-prod \
 *     DB_USER="$DB_USER" DB_PASSWORD="$DB_PASSWORD" \
 *     node scripts/backfill-unmatched-share-requests.js
 *
 * Run (apply):  ...same... APPLY=1 node scripts/backfill-unmatched-share-requests.js
 */

const APPLY = process.env.APPLY === '1';
const CUTOFF = process.env.CUTOFF || '2026-05-01';

const { getPool, sql } = require('../config/database');
const { linkSubmissionToShareWorkflow } = require('../services/publicFormShareLinkService');
const { getPublicFormsActorUserId } = require('../services/publicFormActor');

// Normalized-card comparison expression, identical to the resolver's SQL.
const NORM = (col) =>
    `LOWER(REPLACE(REPLACE(LTRIM(RTRIM(${col})), N'-', N''), N' ', N''))`;

const TARGETS_QUERY = `
    SELECT s.SubmissionId, s.FormTemplateId, s.TenantId AS FormTenantId, s.FormKind,
           CONVERT(varchar, s.CreatedDate, 120) AS Created,
           s.SubmittedMemberIdText,
           s.PayloadFirstName, s.PayloadLastName, s.PayloadEmail, s.PayloadPhone,
           t.DefaultVendorId,
           m.MemberId, m.HouseholdId, m.TenantId AS MemberTenantId,
           mt.Name AS MemberTenant,
           mu.FirstName AS MFirst, mu.LastName AS MLast
    FROM oe.PublicFormSubmissions s
    JOIN oe.PublicFormTemplates t ON s.FormTemplateId = t.FormTemplateId
    JOIN oe.Members m
        ON m.HouseholdMemberID IS NOT NULL
       AND ${NORM('m.HouseholdMemberID')} = ${NORM('s.SubmittedMemberIdText')}
    JOIN oe.Tenants mt ON m.TenantId = mt.TenantId
    LEFT JOIN oe.Users mu ON m.UserId = mu.UserId
    WHERE s.MemberMatchStatus = 'Unmatched'
      AND s.CreatedDate >= @cutoff
      AND s.ShareRequestId IS NULL
      AND s.FormKind = 'UnsharedAmount'
      AND t.CreatesShareRequestOnSubmit = 1
      AND ISNULL(t.CreatesCaseOnSubmit, 0) = 0
      AND s.SubmittedMemberIdText IS NOT NULL
      AND (
            SELECT COUNT(*) FROM oe.Members m2
            WHERE m2.HouseholdMemberID IS NOT NULL
              AND ${NORM('m2.HouseholdMemberID')} = ${NORM('s.SubmittedMemberIdText')}
          ) = 1
    ORDER BY s.CreatedDate
`;

async function main() {
    console.log(`\n=== Backfill unmatched share requests ===`);
    console.log(`Mode: ${APPLY ? '🔴 APPLY (writing to DB)' : '🟢 DRY-RUN (no writes)'}`);
    console.log(`Cutoff: CreatedDate >= ${CUTOFF}`);
    console.log(`Target DB: ${process.env.DB_SERVER} / ${process.env.DB_NAME}\n`);

    const pool = await getPool();
    const rows = (await pool.request()
        .input('cutoff', sql.DateTime2, new Date(CUTOFF))
        .query(TARGETS_QUERY)).recordset;

    console.log(`Found ${rows.length} recoverable submission(s):\n`);
    for (const r of rows) {
        console.log(
            `  ${r.Created}  card=${r.SubmittedMemberIdText}  ` +
            `submitted="${(r.PayloadFirstName || '') + ' ' + (r.PayloadLastName || '')}".trim()  ` +
            `→ member="${(r.MFirst || '') + ' ' + (r.MLast || '')}" [${r.MemberTenant}]`
        );
    }
    console.log('');

    if (!APPLY) {
        console.log('DRY-RUN complete. No rows written. Re-run with APPLY=1 to create these share requests.\n');
        await pool.close();
        return;
    }

    const actorUserId = await getPublicFormsActorUserId();
    const results = { created: [], failed: [] };

    for (const r of rows) {
        const payload = {
            memberId: r.MemberId,
            firstName: r.PayloadFirstName || r.MFirst || '',
            lastName: r.PayloadLastName || r.MLast || '',
            email: r.PayloadEmail || null,
            phone: r.PayloadPhone || null
        };
        try {
            const res = await linkSubmissionToShareWorkflow({
                submissionId: r.SubmissionId,
                tenantId: r.FormTenantId,           // template flags are read under the FORM's tenant
                formTemplateId: r.FormTemplateId,
                formKind: r.FormKind,
                memberId: r.MemberId,
                vendorIdOverride: r.DefaultVendorId, // mirror live: SR.VendorId = form's default vendor
                payload,
                actorUserId,
                def: null
            });

            if (res && res.success && res.shareRequestId) {
                // Reflect the resolution on the submission row too.
                await pool.request()
                    .input('submissionId', sql.UniqueIdentifier, r.SubmissionId)
                    .input('memberId', sql.UniqueIdentifier, r.MemberId)
                    .query(`
                        UPDATE oe.PublicFormSubmissions
                        SET MemberId = @memberId, MemberMatchStatus = 'Matched'
                        WHERE SubmissionId = @submissionId
                    `);
                results.created.push({ submissionId: r.SubmissionId, requestNumber: res.requestNumber, shareRequestId: res.shareRequestId });
                console.log(`✅ ${r.SubmittedMemberIdText} ${r.MFirst} ${r.MLast} → SR ${res.requestNumber}`);
            } else {
                results.failed.push({ submissionId: r.SubmissionId, reason: (res && res.reason) || 'no_share_request_id' });
                console.warn(`⚠️  ${r.SubmittedMemberIdText} ${r.MFirst} ${r.MLast} → not created: ${(res && res.reason) || 'unknown'}`);
            }
        } catch (e) {
            results.failed.push({ submissionId: r.SubmissionId, reason: e.message });
            console.error(`❌ ${r.SubmittedMemberIdText} ${r.MFirst} ${r.MLast} → error: ${e.message}`);
        }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Created: ${results.created.length}`);
    console.log(`Failed:  ${results.failed.length}`);
    if (results.failed.length) console.log(JSON.stringify(results.failed, null, 2));
    await pool.close();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
