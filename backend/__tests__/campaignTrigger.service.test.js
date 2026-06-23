// backend/__tests__/campaignTrigger.service.test.js
const CampaignTriggerService = require('../services/campaignTrigger.service');

// Mock mssql pool.
// NOTE on branch order: the member-context query JOINs oe.Users AND references
// oe.Enrollments/TerminationDate (via the effective-termination-date subquery), so the
// `JOIN oe.Users` branch MUST be checked before the standalone TerminationDate branch,
// otherwise member context wrongly resolves to the termination-check recordset.
const createMockPool = (queryResults = {}) => {
  const queries = [];
  const mockRequest = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation((queryStr) => {
      queries.push(queryStr);
      if (queryStr.includes('FROM oe.Campaigns')) {
        return { recordset: queryResults.campaigns || [] };
      }
      if (queryStr.includes('FROM oe.CampaignEnrollments')) {
        return { recordset: queryResults.existingEnrollments || [] };
      }
      if (queryStr.includes('FROM oe.CampaignSteps')) {
        return { recordset: queryResults.steps || [] };
      }
      if (queryStr.includes('oe.Members') && queryStr.includes('JOIN oe.Users')) {
        return { recordset: queryResults.memberContext || [] };
      }
      if (queryStr.includes('oe.Enrollments') && queryStr.includes('TerminationDate') && !queryStr.includes('oe.Members')) {
        return { recordset: queryResults.termination || [] };
      }
      if (queryStr.includes('INSERT INTO oe.CampaignEnrollments')) {
        return { rowsAffected: [1] };
      }
      if (queryStr.includes('INSERT INTO oe.CampaignMessageLog')) {
        return { rowsAffected: [1] };
      }
      if (queryStr.includes('UPDATE oe.CampaignEnrollments')) {
        return { rowsAffected: [1] };
      }
      return { recordset: [] };
    })
  };
  return {
    request: jest.fn(() => mockRequest),
    _mockRequest: mockRequest,
    _queries: queries
  };
};

// Mock MessageQueueService
jest.mock('../services/messageQueue.service', () => ({
  queueEmail: jest.fn().mockResolvedValue('mock-message-id'),
  queueMessage: jest.fn().mockResolvedValue('mock-message-id')
}));

// Mock marketing-preference checks so the email/SMS branches run without hitting the DB.
jest.mock('../services/memberCommunicationPreferences.service', () => ({
  isEmailMarketingOptedOut: jest.fn().mockResolvedValue(false),
  isSmsMarketingBlocked: jest.fn().mockResolvedValue(false)
}));

const MessageQueueService = require('../services/messageQueue.service');

const fullMemberContext = (overrides = {}) => ({
  MemberId: 'member-1', UserId: 'user-1',
  FirstName: 'John', LastName: 'Doe', Email: 'john@test.com', Phone: '555-1234',
  MemberTerminationDate: null,
  TenantId: 'tenant-1', TenantName: 'TestTenant',
  TenantPrimaryAddress: '1 Main St', TenantPrimaryCity: 'Town',
  TenantPrimaryState: 'TX', TenantPrimaryZip: '75001',
  GroupName: 'TestGroup',
  AgentFirstName: 'Agent', AgentLastName: 'Smith',
  AgentEmail: 'agent@test.com', AgentPhone: '555-5678',
  Subject: 'Welcome', Body: 'Hello {[member.FirstName]}', EmailReplyTo: null,
  EmailTemplateCategory: 'System',
  SmsBody: 'Welcome {[member.FirstName]}', SmsSubject: null,
  SmsTemplateCategory: 'System',
  ...overrides
});

describe('CampaignTriggerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('fireTrigger', () => {
    it('should skip if no active campaigns found for trigger type', async () => {
      const pool = createMockPool({ campaigns: [] });
      const result = await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', {
        memberId: 'member-1',
        tenantId: 'tenant-1'
      });
      expect(result).toEqual({ campaignsTriggered: 0, messagesQueued: 0 });
    });

    it('should skip if member is already enrolled in the campaign', async () => {
      const pool = createMockPool({
        campaigns: [{ CampaignId: 'camp-1', TenantId: 'tenant-1' }],
        existingEnrollments: [{ CampaignEnrollmentId: 'existing-1' }]
      });
      const result = await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', {
        memberId: 'member-1',
        tenantId: 'tenant-1'
      });
      expect(result).toEqual({ campaignsTriggered: 0, messagesQueued: 0 });
    });

    it('should cancel enrollment if member is terminated (non-termination triggers)', async () => {
      const pool = createMockPool({
        campaigns: [{ CampaignId: 'camp-1', TenantId: 'tenant-1' }],
        existingEnrollments: [],
        steps: [{ StepId: 'step-1', DelayDays: 0, EmailTemplateId: 'tpl-1', SmsTemplateId: null, IsActive: true }],
        termination: [{ TerminationDate: '2026-01-01' }]
      });
      const result = await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', {
        memberId: 'member-1',
        tenantId: 'tenant-1'
      });
      expect(result.messagesQueued).toBe(0);
      expect(MessageQueueService.queueEmail).not.toHaveBeenCalled();
    });

    it('should create enrollment and queue Day 0 messages', async () => {
      const pool = createMockPool({
        campaigns: [{ CampaignId: 'camp-1', TenantId: 'tenant-1' }],
        existingEnrollments: [],
        steps: [
          { StepId: 'step-1', StepOrder: 1, DelayDays: 0, EmailTemplateId: 'tpl-email', SmsTemplateId: 'tpl-sms', IsActive: true }
        ],
        termination: [],
        memberContext: [fullMemberContext()]
      });

      const result = await CampaignTriggerService.fireTrigger(pool, 'EnrollmentCompletion', {
        memberId: 'member-1',
        tenantId: 'tenant-1'
      });

      expect(result.campaignsTriggered).toBe(1);
      expect(result.messagesQueued).toBe(2); // email + SMS
    });
  });

  describe('fireTrigger — PlanTermination', () => {
    it('should STILL send the email to a terminated member (termination guard bypassed)', async () => {
      const pool = createMockPool({
        campaigns: [{ CampaignId: 'camp-term', TenantId: 'tenant-1' }],
        existingEnrollments: [],
        steps: [
          { StepId: 'step-1', StepOrder: 1, DelayDays: 0, EmailTemplateId: 'tpl-term', SmsTemplateId: null, IsActive: true }
        ],
        // Member is terminated — would normally cancel the campaign for other triggers.
        termination: [{ TerminationDate: '2026-06-09' }],
        memberContext: [fullMemberContext({
          Subject: 'Coverage ended',
          Body: 'Hi {[member.FirstName]}, your plan {[plan.Name]} has been terminated.'
        })]
      });

      const result = await CampaignTriggerService.fireTrigger(pool, 'PlanTermination', {
        memberId: 'member-1',
        tenantId: 'tenant-1',
        planName: 'Gold PPO'
      });

      expect(result.campaignsTriggered).toBe(1);
      expect(result.messagesQueued).toBe(1);
      expect(MessageQueueService.queueEmail).toHaveBeenCalledTimes(1);
    });

    it('should substitute {[plan.Name]} from the trigger context into the email body', async () => {
      const pool = createMockPool({
        campaigns: [{ CampaignId: 'camp-term', TenantId: 'tenant-1' }],
        existingEnrollments: [],
        steps: [
          { StepId: 'step-1', StepOrder: 1, DelayDays: 0, EmailTemplateId: 'tpl-term', SmsTemplateId: null, IsActive: true }
        ],
        termination: [{ TerminationDate: '2026-06-09' }],
        memberContext: [fullMemberContext({
          Subject: 'Your {[plan.Name]} coverage',
          Body: 'Hi {[member.FirstName]}, your plan {[plan.Name]} has been terminated.'
        })]
      });

      await CampaignTriggerService.fireTrigger(pool, 'PlanTermination', {
        memberId: 'member-1',
        tenantId: 'tenant-1',
        planName: 'Gold PPO'
      });

      const arg = MessageQueueService.queueEmail.mock.calls[0][0];
      expect(arg.subject).toBe('Your Gold PPO coverage');
      expect(arg.htmlContent).toBe('Hi John, your plan Gold PPO has been terminated.');
    });
  });

  describe('checkMemberTerminated', () => {
    it('should return true when TerminationDate is set', async () => {
      const pool = createMockPool({
        termination: [{ TerminationDate: '2026-03-15' }]
      });
      const result = await CampaignTriggerService.checkMemberTerminated(pool, 'member-1');
      expect(result).toBe(true);
    });

    it('should return false when no TerminationDate', async () => {
      const pool = createMockPool({ termination: [] });
      const result = await CampaignTriggerService.checkMemberTerminated(pool, 'member-1');
      expect(result).toBe(false);
    });
  });
});
