// Target-range math + snapshot shaping for the pricing proxy.
const { computeTargets, buildSnapshot, TARGET_MIN_PCT, TARGET_MAX_PCT } = require('../cptPricingService');

jest.mock('axios');
const axios = require('axios');

describe('computeTargets', () => {
    it('attaches 150/200% ranges per site and picks the cheapest site as headline', () => {
        const result = computeTargets({
            code: '27447',
            totals: [
                { site: 'Ambulatory Surgery Center (ASC)', professional: 1084.96, facility: 9393.16, anesthesia: 297.15, total: 10775.27 },
                { site: 'Hospital Outpatient (HOPD)', professional: 1084.96, facility: 13116.76, anesthesia: 297.15, total: 14498.87 }
            ],
            sections: []
        });

        expect(result.medicareTotal).toBe(10775.27);
        expect(result.headlineSite).toBe('Ambulatory Surgery Center (ASC)');
        expect(result.targetMin).toBe(16162.91); // 1.5x
        expect(result.targetMax).toBe(21550.54); // 2.0x
        expect(result.totals[1].targetMin).toBe(21748.31);
        expect(result.totals[1].targetMax).toBe(28997.74);
        expect(result.targetMinPct).toBe(TARGET_MIN_PCT);
        expect(result.targetMaxPct).toBe(TARGET_MAX_PCT);
    });

    it('falls back to the professional fee when totals is empty (office codes)', () => {
        const result = computeTargets({
            code: '99213',
            totals: [],
            sections: [
                { kind: 'professional', payable: true, result: 90.84, result_label: 'Allowed amount · non-facility (office)' }
            ]
        });

        expect(result.medicareTotal).toBe(90.84);
        expect(result.targetMin).toBe(136.26);
        expect(result.targetMax).toBe(181.68);
    });

    it('returns null targets when nothing is payable', () => {
        const result = computeTargets({ code: '00000', totals: [], sections: [] });
        expect(result.medicareTotal).toBeNull();
        expect(result.targetMin).toBeNull();
        expect(result.targetMax).toBeNull();
    });
});

describe('buildSnapshot', () => {
    beforeEach(() => {
        process.env.PRICING_API_USER = 'test';
        process.env.PRICING_API_PASS = 'test';
        axios.get.mockReset();
    });

    it('shapes the persisted snapshot from the API response', async () => {
        axios.get.mockResolvedValue({
            data: {
                code: '45378', description: 'COLONOSCOPY', found: true,
                zip: '28202', locality: 'NC/00', site: 'facility', anes_minutes_used: 30,
                totals: [{ site: 'ASC', professional: 200, facility: 600, anesthesia: 100, total: 900 }],
                sections: [{ kind: 'professional', payable: true, result: 200 }]
            }
        });

        const snap = await buildSnapshot('45378', '28202');
        expect(snap.medicareTotal).toBe(900);
        expect(snap.targetMin).toBe(1350);
        expect(snap.targetMax).toBe(1800);
        expect(snap.snapshotZip).toBe('28202');
        expect(snap.snapshot.totals[0].targetMax).toBe(1800);
        expect(snap.snapshot.sections).toHaveLength(1);
    });

    it('throws CPT_NOT_FOUND when the API has no data for the code', async () => {
        axios.get.mockResolvedValue({ data: { code: '99999', found: false, totals: [], sections: [] } });
        await expect(buildSnapshot('99999', null)).rejects.toMatchObject({ code: 'CPT_NOT_FOUND' });
    });
});
