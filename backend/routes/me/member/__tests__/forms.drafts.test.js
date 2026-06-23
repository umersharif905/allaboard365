/**
 * Draft autosave routes — auth + wiring.
 * Run: npx jest routes/me/member/__tests__/forms.drafts
 */
const express = require('express');
const request = require('supertest');

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({ input: mockInput, query: mockQuery }));
jest.mock('../../../../config/database', () => ({
  getPool: jest.fn(async () => ({ request: mockRequest })),
  sql: { UniqueIdentifier: 'UniqueIdentifier', NVarChar: () => 'NVarChar' }
}));
jest.mock('../../../uploads', () => ({
  uploadToAzureBlob: jest.fn(async () => 'https://blob/x'),
  deleteAzureBlob: jest.fn()
}));
const mockBuildPrefill = jest.fn();
jest.mock('../../../../services/publicFormInvitationPrefillService', () => ({
  buildPrefillForMember: (...a) => mockBuildPrefill(...a),
  mapRelationToPrimary: jest.fn()
}));
jest.mock('../../../../services/priorProviderService', () => ({ getPriorProvidersForMember: jest.fn() }));
jest.mock('../../../../services/publicFormAdminService', () => ({ getPublishedDefinitionByTemplateId: jest.fn() }));
const mockCreateSubmission = jest.fn();
jest.mock('../../../../services/publicFormSubmissionService', () => ({
  createSubmissionFromPublicRequest: (...a) => mockCreateSubmission(...a)
}));
const publicFormAdminService = require('../../../../services/publicFormAdminService');

const mockDraftSvc = {
  upsertDraft: jest.fn(),
  getActiveDraft: jest.fn(),
  updateDraftPayload: jest.fn(),
  deleteDraft: jest.fn(),
  loadDraftForOwner: jest.fn(),
  insertDraftFile: jest.fn(),
  deleteDraftFile: jest.fn(),
  deleteDraftRowsOnly: jest.fn()
};
jest.mock('../../../../services/publicFormDraftService', () => mockDraftSvc);

const formsRouter = require('../forms');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

const SELF = '11111111-1111-1111-1111-111111111111';
const STRANGER = '99999999-9999-9999-9999-999999999999';
const TPL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DRAFT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TENANT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const HH = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function buildApp(role = 'Member') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { UserId: 'user-1', currentRole: role };
    next();
  });
  app.use('/api/me/member/forms', formsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  // findHouseholdMembersForUser → self only
  mockQuery.mockResolvedValue({ recordset: [{ MemberId: SELF, TenantId: TENANT, HouseholdId: HH }] });
});

it('POST /drafts upserts for a household member and returns the draftId', async () => {
  mockDraftSvc.upsertDraft.mockResolvedValue(DRAFT);
  const res = await request(buildApp())
    .post('/api/me/member/forms/drafts')
    .send({ formTemplateId: TPL, forMemberId: SELF, payload: { a: 1 } });
  expect(res.status).toBe(200);
  expect(res.body.data.draftId).toBe(DRAFT);
  expect(mockDraftSvc.upsertDraft).toHaveBeenCalledWith(
    expect.objectContaining({ ownerUserId: 'user-1', tenantId: TENANT, formTemplateId: TPL, forMemberId: SELF, householdId: HH })
  );
});

it('POST /drafts 403s for a member outside the household', async () => {
  const res = await request(buildApp())
    .post('/api/me/member/forms/drafts')
    .send({ formTemplateId: TPL, forMemberId: STRANGER, payload: {} });
  expect(res.status).toBe(403);
  expect(mockDraftSvc.upsertDraft).not.toHaveBeenCalled();
});

it('POST /drafts 400s on a bad formTemplateId', async () => {
  const res = await request(buildApp())
    .post('/api/me/member/forms/drafts')
    .send({ formTemplateId: 'nope', forMemberId: SELF });
  expect(res.status).toBe(400);
});

it('GET /drafts/active returns the draft', async () => {
  mockDraftSvc.getActiveDraft.mockResolvedValue({ draftId: DRAFT, payload: { a: 1 }, files: [] });
  const res = await request(buildApp()).get(
    `/api/me/member/forms/drafts/active?formTemplateId=${TPL}&forMemberId=${SELF}`
  );
  expect(res.status).toBe(200);
  expect(res.body.data.draft.draftId).toBe(DRAFT);
});

it('PATCH /drafts/:id 404s when the owner does not own the draft', async () => {
  mockDraftSvc.updateDraftPayload.mockResolvedValue(false);
  const res = await request(buildApp()).patch(`/api/me/member/forms/drafts/${DRAFT}`).send({ payload: {} });
  expect(res.status).toBe(404);
});

it('DELETE /drafts/:id deletes when owned', async () => {
  mockDraftSvc.deleteDraft.mockResolvedValue({ deleted: true, blobPaths: [] });
  const res = await request(buildApp()).delete(`/api/me/member/forms/drafts/${DRAFT}`);
  expect(res.status).toBe(200);
  expect(mockDraftSvc.deleteDraft).toHaveBeenCalledWith({ draftId: DRAFT, ownerUserId: 'user-1' });
});

it('POST /drafts/:id/files stages a file and records it', async () => {
  mockDraftSvc.loadDraftForOwner.mockResolvedValue({ draftId: DRAFT, files: [] });
  mockDraftSvc.insertDraftFile.mockResolvedValue('file-1');
  const res = await request(buildApp())
    .post(`/api/me/member/forms/drafts/${DRAFT}/files`)
    .field('fieldName', 'surg_visit_notes')
    .attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'notes.pdf', contentType: 'application/pdf' });
  expect(res.status).toBe(200);
  expect(res.body.data.draftFileId).toBe('file-1');
  expect(mockDraftSvc.insertDraftFile).toHaveBeenCalledWith(
    expect.objectContaining({ draftId: DRAFT, fieldName: 'surg_visit_notes', originalFileName: 'notes.pdf' })
  );
});

it('DELETE /drafts/:id/files/:fileId removes a staged file', async () => {
  mockDraftSvc.deleteDraftFile.mockResolvedValue({ deleted: true, blobPath: 'public-form-uploads/drafts/x/y.pdf' });
  const res = await request(buildApp()).delete(`/api/me/member/forms/drafts/${DRAFT}/files/${DRAFT}`);
  expect(res.status).toBe(200);
});

it('POST /drafts/:id/submit promotes staged files and clears the draft', async () => {
  mockDraftSvc.loadDraftForOwner.mockResolvedValue({
    draftId: DRAFT, tenantId: TENANT, formTemplateId: TPL, forMemberId: SELF, householdId: HH,
    payload: { firstName: 'spoofed' },
    files: [{ FieldName: 'f', OriginalFileName: 'n.pdf', ContentType: 'application/pdf', FileSizeBytes: 10, BlobUrl: 'u', BlobPath: 'p' }]
  });
  publicFormAdminService.getPublishedDefinitionByTemplateId.mockResolvedValue({ FormTemplateId: TPL, TenantId: TENANT, DefinitionJson: '{"fields":[]}' });
  mockBuildPrefill.mockResolvedValue({ firstName: 'Real' });
  mockCreateSubmission.mockResolvedValue({ submissionId: 'sub-1' });

  const res = await request(buildApp()).post(`/api/me/member/forms/drafts/${DRAFT}/submit`).send({});
  expect(res.status).toBe(200);
  // Identity overwritten (anti-tamper) and staged files promoted.
  const [, , payload, files, , ctx] = mockCreateSubmission.mock.calls[0];
  expect(payload.firstName).toBe('Real');
  expect(files).toEqual([]);
  expect(ctx.preStagedFiles[0]).toMatchObject({ fieldName: 'f', originalName: 'n.pdf', blobPath: 'p' });
  // Submission is bound to the authorized member directly (A6 anti-tamper),
  // not re-resolved from typed/edited member-ID text.
  expect(ctx.boundMemberId).toBe(SELF);
  expect(mockDraftSvc.deleteDraftRowsOnly).toHaveBeenCalledWith(DRAFT);
});
