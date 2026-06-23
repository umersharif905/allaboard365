// One-shot: re-run linkSubmissionToShareWorkflow against a single submission.
// Usage: node reprocess-submission.cjs <submissionId>
//
// Pulls the submission row, decrypts the payload, loads the published form
// definition, and calls the share-link service exactly the way the public
// submit endpoint would. Use after fixing a bug that caused a submission to
// land with a LinkError but no ShareRequestId/LinkedCaseId.
const sql = require('mssql');
require('dotenv').config({ path: '/app/backend/.env' });

const { decryptPayloadObject } = require('/app/backend/services/publicFormCrypto');
const { linkSubmissionToShareWorkflow } = require('/app/backend/services/publicFormShareLinkService');
const { getPublicFormsActorUserId } = require('/app/backend/services/publicFormActor');

const submissionId = process.argv[2];
if (!submissionId) {
  console.error('Usage: node reprocess-submission.cjs <submissionId>');
  process.exit(1);
}

(async () => {
  const pool = await sql.connect({
    server: process.env.DB_SERVER, database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    options: { encrypt: true, trustServerCertificate: false }, requestTimeout: 60000
  });

  const sub = (await pool.request()
    .input('id', sql.UniqueIdentifier, submissionId)
    .query(`
      SELECT s.SubmissionId, s.TenantId, s.FormTemplateId, s.MemberId, s.MemberMatchStatus,
             s.PayloadEncrypted, s.PayloadIv, s.PayloadAuthTag,
             t.FormKind, t.DefaultVendorId, t.PublishedVersion,
             (SELECT TOP 1 DefinitionJson FROM oe.PublicFormTemplateVersions v
              WHERE v.FormTemplateId = t.FormTemplateId AND v.VersionNumber = t.PublishedVersion) AS DefinitionJson
      FROM oe.PublicFormSubmissions s
      JOIN oe.PublicFormTemplates t ON t.FormTemplateId = s.FormTemplateId
      WHERE s.SubmissionId = @id
    `)
  ).recordset[0];
  if (!sub) { console.error('Submission not found:', submissionId); process.exit(2); }
  if (sub.MemberMatchStatus !== 'Matched' || !sub.MemberId) {
    console.error('Submission not Matched; cannot auto-create. Status:', sub.MemberMatchStatus);
    process.exit(3);
  }

  const payload = decryptPayloadObject(
    sub.PayloadEncrypted, sub.PayloadIv, sub.PayloadAuthTag
  );
  const def = JSON.parse(sub.DefinitionJson);
  const actorUserId = await getPublicFormsActorUserId();

  console.log('Reprocessing', submissionId);
  console.log('  formKind:', sub.FormKind);
  console.log('  memberId:', sub.MemberId);
  console.log('  vendorIdOverride:', sub.DefaultVendorId);
  console.log('  payload keys:', Object.keys(payload).slice(0, 30));

  const result = await linkSubmissionToShareWorkflow({
    submissionId: sub.SubmissionId,
    tenantId: sub.TenantId,
    formTemplateId: sub.FormTemplateId,
    formKind: sub.FormKind,
    memberId: sub.MemberId,
    vendorIdOverride: sub.DefaultVendorId,
    payload,
    actorUserId,
    def
  });
  console.log('Result:', result);

  const after = (await pool.request()
    .input('id', sql.UniqueIdentifier, submissionId)
    .query('SELECT SubmissionId, ShareRequestId, LinkedCaseId, LinkError FROM oe.PublicFormSubmissions WHERE SubmissionId = @id')
  ).recordset[0];
  console.log('Post-state:', after);

  await pool.close();
})().catch(e => { console.error(e); process.exit(1); });
