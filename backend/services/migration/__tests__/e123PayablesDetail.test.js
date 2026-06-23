'use strict';

const fs = require('fs');
const path = require('path');
const {
  parsePayablesCsvBuffer,
  buildPayablesAgentIndex,
  normalizePayablesRow,
  inferProductTierFromBenefit,
  buildPayoutExpectations,
  matchSellerPayoutToTier
} = require('../e123PayablesDetail.service');

const SAMPLE_CSV = `"Posted Date","Agent ID","Label","Payee Agent ID","Payee Agent Label","Product ID","Benefit","Transaction ID","Commissionable Amount","Payout","Type","Subtype","Bank Name","Routing Number","Account Number"
04/30/2026,804148,Jordan Helfgott Individuals,782721,Global Benefits ,45042,Member + Spouse $3000 UA,10902,$315.00,$20.00,COMM,Product,Wells Fargo,061000227,3077999914
04/30/2026,804148,Jordan Helfgott Individuals,785508,Steve Schone,45042,Member + Spouse $3000 UA,10902,$315.00,$12.00,COMM,Product,America First Credit Union,324377516,746046868659
04/30/2026,792515,Global Benefits Individual Enrollment,782721,Global Benefits ,45042,Member Only $1500 UA,9611,$220.00,$24.00,COMM,Product,Wells Fargo,061000227,3077999914
04/30/2026,897554,Karen Maria Miller,897554,Karen Maria Miller,45042,Member Only $1500 UA,511342548,$220.00,$20.00,COMM,Product,Bank of America,123103716,139107372968
`;

describe('e123PayablesDetail.service', () => {
  it('maps benefit text to EE/ES product tier codes', () => {
    expect(inferProductTierFromBenefit('Member Only $1500 UA')).toBe('EE');
    expect(inferProductTierFromBenefit('Member + Spouse $3000 UA')).toBe('ES');
    expect(inferProductTierFromBenefit('Employee + Child')).toBe('EC');
    expect(inferProductTierFromBenefit('Family Plan')).toBe('EF');
  });

  it('matches seller payout to tier from CommissionJson productTiers', () => {
    const legacyToSort = new Map([[-1, -1], [0, 0]]);
    const levelNameBySort = new Map([[-1, 'Advisor'], [0, 'Junior Partner']]);
    const rules = [{
      ruleId: 'r1',
      ruleName: 'Copay',
      productId: 'prod-1',
      e123Pdid: 45042,
      tierLevel: null,
      commissionType: 'Tiered',
      commissionJson: JSON.stringify({
        type: 'flatrate',
        tiers: [
          {
            level: -1,
            name: 'Advisor',
            productTiers: { EE: { flatAmount: 15 } }
          },
          {
            level: 0,
            name: 'Junior Partner',
            productTiers: { EE: { flatAmount: 17 } }
          }
        ]
      })
    }];
    const expectations = buildPayoutExpectations(rules, legacyToSort);
    const hit = matchSellerPayoutToTier(
      {
        payout: 17,
        commissionableAmount: 220,
        productId: 45042,
        benefit: 'Member Only $1500 UA'
      },
      expectations,
      levelNameBySort
    );
    expect(hit).not.toBeNull();
    expect(hit.tierLevel).toBe(0);
    expect(hit.tierLabel).toBe('Junior Partner');
  });

  it('parses payables detail rows and classifies seller vs override lines', () => {
    const parsed = parsePayablesCsvBuffer(Buffer.from(SAMPLE_CSV), { fileName: 'test.csv' });
    expect(parsed.commProductRowCount).toBe(4);

    const seller = parsed.rows.find((r) => r.payeeAgentId === 897554);
    expect(seller.isSellerLine).toBe(true);
    expect(seller.payout).toBe(20);

    const override = parsed.rows.find((r) => r.payeeAgentId === 785508);
    expect(override.isOverrideLine).toBe(true);
    expect(override.sellingAgentId).toBe(804148);
  });

  it('extracts ACH from payee rows with full account numbers', async () => {
    const parsed = parsePayablesCsvBuffer(Buffer.from(SAMPLE_CSV));
    const index = await buildPayablesAgentIndex(parsed, {
      agencyId: null,
      tenantId: null,
      instanceId: null,
      brokerIdsInScope: [897554, 782721, 785508]
    });

    const karen = index.agents['897554'];
    expect(karen.achAvailable).toBe(true);
    expect(karen.ach.routingNumber).toBe('123103716');
    expect(karen.ach.accountNumber).toBe('139107372968');
    expect(karen.sellerLineCount).toBe(1);
    expect(karen.overrideLineCount).toBe(0);
  });

  it('does not use override lines for tier samples', async () => {
    const parsed = parsePayablesCsvBuffer(Buffer.from(SAMPLE_CSV));
    const index = await buildPayablesAgentIndex(parsed, {
      brokerIdsInScope: [785508]
    });
    expect(index.agents['785508'].sellerLineCount).toBe(0);
    expect(index.agents['785508'].overrideLineCount).toBe(1);
    expect(index.agents['785508'].tierInference.sampleCount).toBe(0);
  });

  it('parses real Sharewell payables export sample when present locally', () => {
    const realPath = path.join(
      process.env.HOME || '',
      'Downloads/1552_payables_detail_2026_06_02_15_08_08.csv'
    );
    if (!fs.existsSync(realPath)) return;

    const buf = fs.readFileSync(realPath);
    const parsed = parsePayablesCsvBuffer(buf, { fileName: path.basename(realPath) });
    expect(parsed.rowCount).toBeGreaterThan(100);
    expect(parsed.dominantMonth).toBeTruthy();

    const withAch = parsed.rows.filter(
      (r) => String(r.routingNumber || '').replace(/\D/g, '').length === 9
        && String(r.accountNumber || '').replace(/\D/g, '').length >= 4
    );
    expect(withAch.length).toBeGreaterThan(0);
  });
});
