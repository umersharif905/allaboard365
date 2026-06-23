const CampaignTriggerService = require('../services/campaignTrigger.service');

describe('Campaign System Integration', () => {
  it('should export CampaignTriggerService with required methods', () => {
    expect(CampaignTriggerService).toBeDefined();
    expect(typeof CampaignTriggerService.fireTrigger).toBe('function');
    expect(typeof CampaignTriggerService.processSteps).toBe('function');
    expect(typeof CampaignTriggerService.checkMemberTerminated).toBe('function');
  });

  it('should export campaign routes as Express router', () => {
    const router = require('../routes/campaigns');
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });
});
