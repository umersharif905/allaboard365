const mockRequest = {
  input: jest.fn().mockReturnThis(),
  query: jest.fn(),
};
const mockPool = { request: jest.fn(() => mockRequest) };
jest.mock('../../config/database', () => {
  // NVarChar must be callable to support sql.NVarChar(sql.MAX) in the service,
  // while still behaving as a value sentinel. No earlier test asserts on its value.
  const NVarChar = Object.assign(function () { return 'NVarChar'; }, { MAX: 'MAX' });
  return {
    getPool: jest.fn(async () => mockPool),
    sql: { UniqueIdentifier: 'UID', NVarChar, Int: 'Int', MAX: 'MAX' },
  };
});
jest.mock('../sendGridEmailService', () => ({ sendEmail: jest.fn(async () => ({ success: true, messageId: 'mid-1' })) }));
jest.mock('../caseDocumentBlob', () => ({ downloadBlobBuffer: jest.fn(async () => Buffer.from('PDFDATA')) }));

const svc = require('../caseForwardingService');
const sendGrid = require('../sendGridEmailService');

beforeEach(() => {
  mockRequest.input.mockClear();
  mockRequest.query.mockReset();
  sendGrid.sendEmail.mockClear();
});

describe('resolveTargetsForCases', () => {
  test('maps caseId to its target row', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [
        { CaseId: 'c1', TargetId: 't1', Label: 'ARM', PlanVendorId: 'v-arm' },
      ],
    });
    const map = await svc.resolveTargetsForCases('vendor1', ['c1', 'c2']);
    expect(map.c1).toEqual({ targetId: 't1', label: 'ARM', planVendorId: 'v-arm' });
    expect(map.c2).toBeUndefined();
  });

  test('returns empty map for empty caseIds without querying', async () => {
    const map = await svc.resolveTargetsForCases('vendor1', []);
    expect(map).toEqual({});
    expect(mockRequest.query).not.toHaveBeenCalled();
  });
});

describe('listTargets', () => {
  test('returns targets for vendor', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ TargetId: 't1', Label: 'ARM', ForwardingEmails: 'a@arm.com,b@arm.com' }],
    });
    const rows = await svc.listTargets('vendor1');
    expect(rows).toHaveLength(1);
    expect(mockRequest.input).toHaveBeenCalledWith('vendorId', 'UID', 'vendor1');
  });
});

describe('createTarget', () => {
  test('inserts and returns new target', async () => {
    mockRequest.query.mockResolvedValueOnce({
      recordset: [{ TargetId: 'new', Label: 'Tall Tree' }],
    });
    const row = await svc.createTarget('vendor1', {
      planVendorId: 'v-tt', label: 'Tall Tree',
      forwardingEmails: 'x@tt.com', templateId: null, userId: 'u1',
    });
    expect(row.Label).toBe('Tall Tree');
  });
});

describe('renderTemplate', () => {
  test('substitutes scalar tokens and repeats bills block', () => {
    const tpl = 'Member {[member.FullName]} | {[#bills]}{[bill.Description]}=${[bill.BilledAmount]};{[/bills]}';
    const ctx = {
      member: { FullName: 'Jane Doe' },
      case: {}, plan: {},
      bills: [
        { Description: 'Visit', BilledAmount: '100.00' },
        { Description: 'Lab', BilledAmount: '50.00' },
      ],
    };
    expect(svc.renderTemplate(tpl, ctx)).toBe('Member Jane Doe | Visit=$100.00;Lab=$50.00;');
  });

  test('blank bills block when no bills', () => {
    const tpl = 'X{[#bills]}row{[/bills]}Y';
    expect(svc.renderTemplate(tpl, { member: {}, case: {}, plan: {}, bills: [] })).toBe('XY');
  });
});

describe('send', () => {
  test('sends to selected recipients, attaches docs, records history', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CaseId: 'c1', TargetId: 't1', Label: 'ARM', PlanVendorId: 'v-arm' }] }) // resolveTargetForCase guard
      .mockResolvedValueOnce({ recordset: [{ MemberTenantId: 'tenant1' }] })          // case/member tenant
      .mockResolvedValueOnce({ recordset: [{ DocumentId: 'd1', FileName: 'bill.pdf', MimeType: 'application/pdf', BlobUrl: 'https://x/bill.pdf' }] }) // docs
      .mockResolvedValueOnce({ recordset: [] })                                        // MessageHistory insert
      .mockResolvedValueOnce({ recordset: [] });                                       // CaseNote insert

    const result = await svc.send('vendor1', 'c1', {
      to: ['a@arm.com'], subject: 'Subj', body: 'Body', documentIds: ['d1'], userId: 'u1',
    });

    expect(sendGrid.sendEmail).toHaveBeenCalledTimes(1);
    const opts = sendGrid.sendEmail.mock.calls[0][0];
    expect(opts.to).toEqual(['a@arm.com']);
    expect(opts.attachments[0].filename).toBe('bill.pdf');
    expect(result.success).toBe(true);
  });

  test('rejects when no recipients', async () => {
    await expect(svc.send('vendor1', 'c1', { to: [], subject: 's', body: 'b', documentIds: [], userId: 'u1' }))
      .rejects.toThrow(/recipient/i);
  });

  test('rejects (409) when the case has no forwarding target — blocks foreign/non-forwardable cases', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [] }); // resolveTargetForCase → no target
    await expect(
      svc.send('vendor1', 'foreign-case', { to: ['a@arm.com'], subject: 's', body: 'b', documentIds: ['d1'], userId: 'u1' })
    ).rejects.toThrow(/forwarding target/i);
    expect(sendGrid.sendEmail).not.toHaveBeenCalled();
  });
});

describe('createStarterTemplate', () => {
  test('inserts a vendor-scoped template and returns its id', async () => {
    mockRequest.query.mockResolvedValueOnce({ recordset: [{ TemplateId: 'tpl-1', TemplateName: 'ARM — Reimbursement Forward' }] });
    const row = await svc.createStarterTemplate('vendor1', 'arm', 'u1');
    expect(row.TemplateId).toBe('tpl-1');
  });
  test('rejects unknown variant', async () => {
    await expect(svc.createStarterTemplate('vendor1', 'nope', 'u1')).rejects.toThrow(/variant/i);
  });
});

describe('plainTextToHtml', () => {
  test('wraps blank-line paragraphs in <p> and converts newlines to <br>', () => {
    const out = svc.plainTextToHtml('Hello,\n\nLine1\nLine2');
    expect(out).toContain('<p style="margin:0 0 12px;">Hello,</p>');
    expect(out).toContain('Line1<br>Line2');
  });
  test('escapes HTML special characters', () => {
    expect(svc.plainTextToHtml('a & <b>')).toContain('a &amp; &lt;b&gt;');
  });
});

// Regression: caseForwardingService and caseService require each other. This
// test file requires caseForwardingService FIRST (top of file) and uses the
// REAL caseService, so buildPreview -> caseService.getCaseById ->
// caseForwardingService.resolveTargetsForCases exercises the circular path. A
// top-level require in caseService would capture the partial (empty) forwarding
// module here and throw "resolveTargetsForCases is not a function".
describe('buildPreview (circular-dependency load order)', () => {
  test('renders a preview through the real caseService.getCaseById path', async () => {
    mockRequest.query
      .mockResolvedValueOnce({ recordset: [{ CaseId: 'c1', TargetId: 't1', Label: 'ARM', PlanVendorId: 'v-arm' }] }) // resolveTargetForCase
      .mockResolvedValueOnce({ recordset: [{ TargetId: 't1', Label: 'ARM', ForwardingEmails: 'a@arm.com, b@arm.com', TemplateId: 'tpl-1' }] }) // target row
      .mockResolvedValueOnce({ recordset: [{ CaseId: 'c1', CaseNumber: 'CASE-1', MemberFirstName: 'Sarah', MemberLastName: 'B' }] }) // getCaseById main query
      .mockResolvedValueOnce({ recordset: [{ CaseId: 'c1', TargetId: 't1', Label: 'ARM', PlanVendorId: 'v-arm' }] }) // getCaseById -> resolveTargetsForCases
      .mockResolvedValueOnce({ recordset: [] }) // bills
      .mockResolvedValueOnce({ recordset: [] }) // documents
      .mockResolvedValueOnce({ recordset: [] }) // priorSends
      .mockResolvedValueOnce({ recordset: [{ Subject: 'S', Body: 'Hi {[member.FullName]}, case {[case.Number]}' }] }); // template read

    const r = await svc.buildPreview('vendor1', 'c1');

    expect(r.target).toEqual({ targetId: 't1', label: 'ARM' });
    expect(r.recipients).toEqual(['a@arm.com', 'b@arm.com']);
    // Proves getCaseById ran (no circular crash) AND the template rendered.
    expect(r.body).toBe('Hi Sarah B, case CASE-1');
  });
});
