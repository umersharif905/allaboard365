// Verifies RecipientType routing in CampaignTriggerService.processSteps:
//   - 'Member' campaigns deliver to the enrolling member
//   - 'Agent' campaigns deliver to the member's assigned agent
//   - 'Agent' campaigns with no assigned agent send nothing
jest.mock('../messageQueue.service', () => ({
  queueEmail: jest.fn().mockResolvedValue('msg-1'),
  queueMessage: jest.fn().mockResolvedValue('msg-2'),
}));
jest.mock('../shared/variableSubstitution', () => ({
  substituteVariables: (str) => str,
}));
// Marketing-compliance gating (merged in from staging) is exercised on the
// member path; default to "not opted out" so these tests assert routing only.
jest.mock('../memberCommunicationPreferences.service', () => ({
  isEmailMarketingOptedOut: jest.fn().mockResolvedValue(false),
  isSmsMarketingBlocked: jest.fn().mockResolvedValue(false),
}));

const MessageQueueService = require('../messageQueue.service');
const CampaignTriggerService = require('../campaignTrigger.service');

// mssql type shims so .input(name, type, value) doesn't blow up
jest.mock('mssql', () => ({
  UniqueIdentifier: 'UniqueIdentifier',
  NVarChar: () => 'NVarChar',
  Int: 'Int',
  Bit: 'Bit',
}));

// Build a pool whose context SELECT returns the given row; all other queries no-op.
function makePool(contextRow) {
  return {
    request: () => ({
      _inputs: {},
      input(name, _type, value) { this._inputs[name] = value; return this; },
      query(sqlText) {
        if (sqlText.includes('FROM oe.Members m')) {
          return Promise.resolve({ recordset: contextRow ? [contextRow] : [] });
        }
        return Promise.resolve({ recordset: [], rowsAffected: [1] });
      },
    }),
  };
}

const baseRow = {
  MemberId: 'mem-1', UserId: 'member-user-1',
  FirstName: 'Mary', LastName: 'Member', Email: 'mary@member.test', Phone: '5551110000',
  MemberTerminationDate: null,
  TenantId: 't1', TenantName: 'Tenant', TenantEmail: null, TenantPhone: null, GroupName: null,
  AgentUserId: 'agent-user-1',
  AgentFirstName: 'Andy', AgentLastName: 'Agent', AgentEmail: 'andy@agent.test', AgentPhone: '5552220000',
  Subject: 'New enrollment', Body: 'A client enrolled', EmailReplyTo: null,
  SmsBody: null, SmsSubject: null,
};

const emailStep = [{ StepId: 's1', StepOrder: 1, DelayDays: 0, EmailTemplateId: 'et1', SmsTemplateId: null, IsActive: 1 }];

beforeEach(() => jest.clearAllMocks());

describe('CampaignTriggerService.processSteps — RecipientType routing', () => {
  it("'Agent' delivers the email to the agent's address and UserId", async () => {
    const pool = makePool(baseRow);
    const queued = await CampaignTriggerService.processSteps(pool, 'enr-1', 'camp-1', 'mem-1', 't1', emailStep, 'Agent');

    expect(queued).toBe(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'andy@agent.test', recipientId: 'agent-user-1' })
    );
  });

  it("'Member' (default) delivers the email to the member", async () => {
    const pool = makePool(baseRow);
    const queued = await CampaignTriggerService.processSteps(pool, 'enr-1', 'camp-1', 'mem-1', 't1', emailStep);

    expect(queued).toBe(1);
    expect(MessageQueueService.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'mary@member.test', recipientId: 'member-user-1' })
    );
  });

  it("'Agent' with no assigned agent sends nothing", async () => {
    const noAgent = { ...baseRow, AgentUserId: null, AgentEmail: null, AgentPhone: null };
    const pool = makePool(noAgent);
    const queued = await CampaignTriggerService.processSteps(pool, 'enr-1', 'camp-1', 'mem-1', 't1', emailStep, 'Agent');

    expect(queued).toBe(0);
    expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
  });
});
