const VendorExportService = require('../vendorExportService');

describe('normalizeProductVendorAmountsMap', () => {
    it('parses object map keyed by product id', () => {
        const pid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
        const map = VendorExportService.normalizeProductVendorAmountsMap({
            [pid]: { vendorAmount: 12.34 }
        });
        expect(map[pid.toUpperCase()].vendorAmount).toBe(12.34);
    });

    it('parses array of { ProductId, VendorAmount }', () => {
        const pid = '11111111-2222-3333-4444-555555555555';
        const map = VendorExportService.normalizeProductVendorAmountsMap([
            { ProductId: pid, VendorAmount: 50 }
        ]);
        expect(map[pid.toUpperCase()].vendorAmount).toBe(50);
    });
});

describe('findProductCapsForNachaDetail', () => {
    const A = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
    const B = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
    const C = 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC';

    it('returns full snapshot when sum matches vendor line', () => {
        const caps = VendorExportService.findProductCapsForNachaDetail(100, {
            [A]: { vendorAmount: 60 },
            [B]: { vendorAmount: 40 }
        });
        expect(caps[A]).toBe(60);
        expect(caps[B]).toBe(40);
    });

    it('picks subset when vendor line is one product', () => {
        const caps = VendorExportService.findProductCapsForNachaDetail(40, {
            [A]: { vendorAmount: 60 },
            [B]: { vendorAmount: 40 }
        });
        expect(caps[B]).toBe(40);
        expect(caps[A]).toBeUndefined();
    });

    it('scales proportionally when no exact subset', () => {
        const caps = VendorExportService.findProductCapsForNachaDetail(90, {
            [A]: { vendorAmount: 60 },
            [B]: { vendorAmount: 40 }
        });
        expect(caps[A] + caps[B]).toBeCloseTo(90, 2);
    });
});

describe('filterSnapshotCapsForVendor', () => {
    const SHAREWELL = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
    const COPAY = '261E5540-A9E5-4973-9D93-B068009C5AD5';

    it('drops other vendors from multi-vendor invoice snapshot', () => {
        const caps = {
            [COPAY]: { vendorAmount: 299.5 },
            [SHAREWELL]: { vendorAmount: 537 }
        };
        const filtered = VendorExportService.filterSnapshotCapsForVendor(
            caps,
            new Set([SHAREWELL])
        );
        expect(Object.keys(filtered)).toEqual([SHAREWELL]);
        expect(filtered[SHAREWELL].vendorAmount).toBe(537);
    });
});

describe('allocatePayablesForPaymentDetail', () => {
    const COPAY = '11111111-1111-1111-1111-111111111111';
    const DENTAL = '22222222-2222-2222-2222-222222222222';
    const VISION = '33333333-3333-3333-3333-333333333333';
    const EXTRA = '44444444-4444-4444-4444-444444444444';

    const detail = {
        NACHAPaymentDetailId: 'npd-1',
        VendorAmount: 100,
        GroupName: 'Test Group',
        ProductVendorAmounts: {
            [COPAY]: { vendorAmount: 50 },
            [DENTAL]: { vendorAmount: 30 },
            [VISION]: { vendorAmount: 20 }
        }
    };

    const enrollments = [
        { ProductId: COPAY, ProductName: 'Copay', WeightRate: 25, MemberId: 'm1' },
        { ProductId: COPAY, ProductName: 'Copay', WeightRate: 25, MemberId: 'm2' },
        { ProductId: DENTAL, ProductName: 'Dental', WeightRate: 30, MemberId: 'm3' },
        { ProductId: VISION, ProductName: 'Vision', WeightRate: 20, MemberId: 'm4' },
        { ProductId: EXTRA, ProductName: 'Extra', WeightRate: 99, MemberId: 'm5' }
    ];

    it('allocates contract from enrollment and paid from invoice cap', () => {
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(
            detail,
            enrollments
        );
        const byMember = Object.fromEntries(allocations.map((a) => [a.MemberId, a]));
        expect(byMember.m1.AllocatedVendorAmount).toBeCloseTo(25, 2);
        expect(byMember.m1.PaidVendorAmount).toBeCloseTo(25, 2);
        expect(byMember.m3.AllocatedVendorAmount).toBeCloseTo(30, 2);
        expect(byMember.m3.PaidVendorAmount).toBeCloseTo(30, 2);
        expect(byMember.m5.AllocatedVendorAmount).toBeCloseTo(99, 2);
        expect(byMember.m5.PaidVendorAmount).toBeCloseTo(0, 2);
        expect(byMember.m5.VarianceAmount).toBeCloseTo(-99, 2);
        const contractTotal = allocations.reduce((s, a) => s + a.AllocatedVendorAmount, 0);
        const paidTotal = allocations.reduce((s, a) => s + a.PaidVendorAmount, 0);
        expect(contractTotal).toBeCloseTo(199, 2);
        expect(paidTotal).toBeCloseTo(100, 2);
        expect(warnings.some((w) => w.code === 'enrollment_not_in_snapshot')).toBe(true);
    });

    it('prorates paid within product when enrollment pool exceeds cap', () => {
        const heavy = {
            ...detail,
            VendorAmount: 50,
            ProductVendorAmounts: { [COPAY]: { vendorAmount: 50 } }
        };
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(heavy, [
            { ProductId: COPAY, ProductName: 'Copay', WeightRate: 60, MemberId: 'm1' },
            { ProductId: COPAY, ProductName: 'Copay', WeightRate: 40, MemberId: 'm2' }
        ]);
        expect(allocations[0].AllocatedVendorAmount).toBeCloseTo(60, 2);
        expect(allocations[0].PaidVendorAmount).toBeCloseTo(30, 2);
        expect(allocations[1].AllocatedVendorAmount).toBeCloseTo(40, 2);
        expect(allocations[1].PaidVendorAmount).toBeCloseTo(20, 2);
        expect(warnings.some((w) => w.code === 'product_prorated')).toBe(true);
    });

    it('uses contract enrollment rate and paid invoice cap when rate changed', () => {
        const DENTAL = '22222222-2222-2222-2222-222222222222';
        const pricingHistoryMap = VendorExportService.buildPricingHistoryMap([
            { ProductId: DENTAL, TierType: 'EE', NetRate: 34.21 },
            { ProductId: DENTAL, TierType: 'EE', NetRate: 35.72 },
        ]);
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(
            {
                NACHAPaymentDetailId: 'npd-rate',
                VendorAmount: 34.21,
                GroupName: 'Test',
                ProductVendorAmounts: { [DENTAL]: { vendorAmount: 34.21 } },
            },
            [
                {
                    ProductId: DENTAL,
                    ProductName: 'GetWell Dental',
                    PricingTierType: 'EE',
                    WeightRate: 35.72,
                    MemberId: 'm1',
                },
            ],
            null,
            pricingHistoryMap
        );
        expect(allocations).toHaveLength(1);
        expect(allocations[0].AllocatedVendorAmount).toBeCloseTo(35.72, 2);
        expect(allocations[0].PaidVendorAmount).toBeCloseTo(34.21, 2);
        expect(allocations[0].VarianceAmount).toBeCloseTo(-1.51, 2);
        expect(warnings.some((w) => w.code === 'product_prorated')).toBe(false);
        expect(warnings.some((w) => w.code === 'rate_changed_since_invoice')).toBe(true);
    });

    it('matches multi-enrollment paid from pricing history; contract from enrollment', () => {
        const DENTAL = '22222222-2222-2222-2222-222222222222';
        const pricingHistoryMap = VendorExportService.buildPricingHistoryMap([
            { ProductId: DENTAL, TierType: 'EE', NetRate: 34.21 },
            { ProductId: DENTAL, TierType: 'EE', NetRate: 35.72 },
            { ProductId: DENTAL, TierType: 'EF', NetRate: 109.83 },
            { ProductId: DENTAL, TierType: 'EF', NetRate: 121.03 },
        ]);
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(
            {
                NACHAPaymentDetailId: 'npd-multi',
                VendorAmount: 144.04,
                GroupName: 'Group Invoice',
                ProductVendorAmounts: { [DENTAL]: { vendorAmount: 144.04 } },
            },
            [
                {
                    ProductId: DENTAL,
                    ProductName: 'GetWell Dental',
                    PricingTierType: 'EE',
                    WeightRate: 35.72,
                    MemberId: 'm1',
                    EnrollmentId: 'e1',
                },
                {
                    ProductId: DENTAL,
                    ProductName: 'GetWell Dental',
                    PricingTierType: 'EF',
                    WeightRate: 121.03,
                    MemberId: 'm2',
                    EnrollmentId: 'e2',
                },
            ],
            null,
            pricingHistoryMap
        );
        const byMember = Object.fromEntries(allocations.map((a) => [a.MemberId, a]));
        expect(byMember.m1.AllocatedVendorAmount).toBeCloseTo(35.72, 2);
        expect(byMember.m1.PaidVendorAmount).toBeCloseTo(34.21, 2);
        expect(byMember.m2.AllocatedVendorAmount).toBeCloseTo(121.03, 2);
        expect(byMember.m2.PaidVendorAmount).toBeCloseTo(109.83, 2);
        expect(warnings.some((w) => w.code === 'product_prorated')).toBe(false);
    });

    it('flags duplicate overlapping enrollment when only one rate matches paid cap (Brooks Bohn pattern)', () => {
        const DENTAL = '22222222-2222-2222-2222-222222222222';
        const pricingHistoryMap = VendorExportService.buildPricingHistoryMap([
            { ProductId: DENTAL, TierType: 'ES', NetRate: 61.92 },
            { ProductId: DENTAL, TierType: 'ES', NetRate: 66.3 },
        ]);
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(
            {
                NACHAPaymentDetailId: 'npd-dup',
                VendorAmount: 61.92,
                GroupName: 'Brooks Bohn',
                ProductVendorAmounts: { [DENTAL]: { vendorAmount: 61.92 } },
            },
            [
                {
                    ProductId: DENTAL,
                    ProductName: 'GetWell Dental',
                    PricingTierType: 'ES',
                    WeightRate: 61.92,
                    MemberId: 'm1',
                    EnrollmentId: 'e-old',
                },
                {
                    ProductId: DENTAL,
                    ProductName: 'GetWell Dental',
                    PricingTierType: 'ES',
                    WeightRate: 66.3,
                    MemberId: 'm1',
                    EnrollmentId: 'e-new',
                },
            ],
            null,
            pricingHistoryMap
        );
        const paidTotal = allocations.reduce((s, a) => s + a.PaidVendorAmount, 0);
        expect(paidTotal).toBeCloseTo(61.92, 2);
        expect(allocations).toHaveLength(1);
        expect(warnings.some((w) => w.code === 'enrollment_not_funded')).toBe(true);
        expect(warnings.some((w) => w.code === 'product_prorated')).toBe(false);
    });

    it('falls back to single pool when no snapshot and pool equals paid', () => {
        const noSnap = { NACHAPaymentDetailId: 'npd-2', VendorAmount: 80, GroupName: 'G' };
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(noSnap, [
            { ProductId: COPAY, WeightRate: 40, MemberId: 'm1' },
            { ProductId: DENTAL, WeightRate: 40, MemberId: 'm2' }
        ]);
        const paidTotal = allocations.reduce((s, a) => s + a.PaidVendorAmount, 0);
        expect(paidTotal).toBeCloseTo(80, 2);
        expect(warnings.some((w) => w.code === 'detail_prorated')).toBe(false);
    });

    it('single-pool prorates paid when weight pool exceeds paid amount', () => {
        const noSnap = { NACHAPaymentDetailId: 'npd-3', VendorAmount: 80, GroupName: 'G' };
        const { allocations, warnings } = VendorExportService.allocatePayablesForPaymentDetail(noSnap, [
            { ProductId: COPAY, WeightRate: 60, MemberId: 'm1' },
            { ProductId: DENTAL, WeightRate: 60, MemberId: 'm2' }
        ]);
        const paidTotal = allocations.reduce((s, a) => s + a.PaidVendorAmount, 0);
        expect(paidTotal).toBeCloseTo(80, 2);
        expect(allocations[0].AllocatedVendorAmount).toBeCloseTo(60, 2);
        expect(warnings.some((w) => w.code === 'detail_prorated')).toBe(true);
    });

    it('allocates split ACH paid lines; contract from enrollment', () => {
        const SHAREWELL = 'F165AF93-8268-448D-9DD6-F02FB338EEAE';
        const COPAY = '261E5540-A9E5-4973-9D93-B068009C5AD5';
        const vendorProducts = new Set([SHAREWELL]);
        const snapshot = {
            [COPAY]: { vendorAmount: 299.5 },
            [SHAREWELL]: { vendorAmount: 537 }
        };
        const enrollments = [
            { ProductId: SHAREWELL, ProductName: 'Essential (ShareWELL)', WeightRate: 537, MemberId: 'm1' }
        ];
        const line1 = {
            NACHAPaymentDetailId: 'l1',
            VendorAmount: 375.9,
            InvoiceProductVendorAmounts: snapshot
        };
        const line2 = {
            NACHAPaymentDetailId: 'l2',
            VendorAmount: 161.1,
            InvoiceProductVendorAmounts: snapshot
        };
        const { allocations: a1, warnings: w1 } = VendorExportService.allocatePayablesForPaymentDetail(
            line1,
            enrollments,
            vendorProducts
        );
        const { allocations: a2, warnings: w2 } = VendorExportService.allocatePayablesForPaymentDetail(
            line2,
            enrollments,
            vendorProducts
        );
        const paidTotal =
            a1.reduce((s, a) => s + a.PaidVendorAmount, 0) +
            a2.reduce((s, a) => s + a.PaidVendorAmount, 0);
        expect(a1[0].PaidVendorAmount).toBeCloseTo(375.9, 2);
        expect(a2[0].PaidVendorAmount).toBeCloseTo(161.1, 2);
        expect(a1[0].AllocatedVendorAmount).toBeCloseTo(537, 2);
        expect(paidTotal).toBeCloseTo(537, 2);
        expect(w1.some((w) => w.code === 'snapshot_without_enrollments')).toBe(false);
        expect(w2.some((w) => w.code === 'snapshot_without_enrollments')).toBe(false);
    });
});

describe('enrichPayablesAllocationWarning', () => {
    const productNameById = new Map([
        ['16ACE482-845A-4BC8-9A8F-489CD1D002CE', 'Essential (ShareWELL)']
    ]);

    it('uses product name and invoice instead of raw product id in message', () => {
        const enriched = VendorExportService.enrichPayablesAllocationWarning(
            {
                severity: 'warning',
                code: 'snapshot_without_enrollments',
                nachaPaymentDetailId: 'npd-1',
                productId: '16ACE482-845A-4BC8-9A8F-489CD1D002CE',
                productCap: 49.58,
                message: 'legacy'
            },
            {
                InvoiceNumber: 'INV-202604-0099',
                GroupName: 'Acme Corp',
                InvBillingPeriodStart: '2026-04-01',
                InvBillingPeriodEnd: '2026-04-30'
            },
            productNameById
        );
        expect(enriched.title).toBe('Not on payables file');
        expect(enriched.message).toContain('Essential (ShareWELL)');
        expect(enriched.message).not.toContain('16ACE482');
        expect(enriched.invoiceNumber).toBe('INV-202604-0099');
        expect(enriched.accountLabel).toBe('Acme Corp');
    });
});

describe('suppressMisleadingSplitAchProrationWarnings', () => {
    it('removes split-ACH proration noise when invoice NACHA total matches enrollment pool', () => {
        const details = [
            { InvoiceNumber: 'INV-1', VendorAmount: 375.9 },
            { InvoiceNumber: 'INV-1', VendorAmount: 161.1 }
        ];
        const warnings = [
            {
                code: 'product_prorated',
                invoiceNumber: 'INV-1',
                productCap: 161.1,
                weightPool: 537
            }
        ];
        const out = VendorExportService.suppressMisleadingSplitAchProrationWarnings(warnings, details);
        expect(out).toHaveLength(0);
    });

    it('keeps proration when invoice NACHA total is truly below enrollment pool', () => {
        const details = [{ InvoiceNumber: 'INV-2', VendorAmount: 65.4 }];
        const warnings = [
            {
                code: 'product_prorated',
                invoiceNumber: 'INV-2',
                productCap: 65.4,
                weightPool: 218
            }
        ];
        const out = VendorExportService.suppressMisleadingSplitAchProrationWarnings(warnings, details);
        expect(out).toHaveLength(1);
    });
});

describe('consolidatePayablesAllocationWarningsForDisplay', () => {
    it('rolls up duplicate invoice+account product warnings to one row', () => {
        const consolidated = VendorExportService.consolidatePayablesAllocationWarningsForDisplay([
            {
                code: 'snapshot_without_enrollments',
                invoiceNumber: 'INV-202604-1242',
                accountLabel: 'Claudia Hobbs',
                productId: 'A',
                productName: 'Lyric (Bundle)',
                productCap: 0.55,
                title: 'Product not on payables file',
                message: 'a'
            },
            {
                code: 'snapshot_without_enrollments',
                invoiceNumber: 'INV-202604-1242',
                accountLabel: 'Claudia Hobbs',
                productId: 'B',
                productName: 'Copay MEC',
                productCap: 49.58,
                title: 'Product not on payables file',
                message: 'b'
            },
            {
                code: 'snapshot_without_enrollments',
                invoiceNumber: 'INV-202604-1242',
                accountLabel: 'Claudia Hobbs',
                productId: 'A',
                productName: 'Lyric (Bundle)',
                productCap: 0.55,
                title: 'Product not on payables file',
                message: 'dup'
            }
        ]);
        expect(consolidated).toHaveLength(1);
        expect(consolidated[0].accountLabel).toBe('Claudia Hobbs');
        expect(consolidated[0].lineItemCount).toBe(2);
        expect(consolidated[0].notOnPayablesFile).toBeCloseTo(50.13, 2);
    });
});

describe('formatPayablesCoveragePeriod', () => {
    it('formats start and end as a single range', () => {
        expect(
            VendorExportService.formatPayablesCoveragePeriod('2026-05-01', '2026-05-31')
        ).toBe('5/1/2026 - 5/31/2026');
    });
});

describe('buildDefaultPayablesMemberRows', () => {
    it('preserves coverage period when consolidating by member', () => {
        const consolidated = VendorExportService.buildDefaultPayablesMemberRows([
            {
                'Alternate ID': 'MW001',
                'First Name': 'Jane',
                'Last Name': 'Doe',
                'Vendor Amount': 35.72,
                'Paid Amount': 34.21,
                'Coverage Period': '5/1/2026 - 5/31/2026',
                'Paid Through Start': '2026-05-01',
                'Paid Through End': '2026-05-31'
            }
        ]);
        expect(consolidated[0]['Coverage Period']).toBe('5/1/2026 - 5/31/2026');
    });
});

describe('formatAsCSVFromTemplate optional columns', () => {
    it('omits {?Name} columns when every row is blank or zero', () => {
        const csv = VendorExportService.formatAsCSVFromTemplate(
            [
                {
                    'Last Name': 'Alexander',
                    'First Name': 'Alex',
                    'Vendor Amount': 61.92,
                    'Paid Amount': 61.92,
                    Variance: 0,
                    Underpaid: 0,
                    Overpaid: 0
                },
                {
                    'Last Name': 'Contract Total',
                    'Vendor Amount': 61.92,
                    'Paid Amount': 61.92,
                    Variance: 0
                }
            ],
            '{LastName:Last Name},{ContractAmount:Contract Amount},{?Variance:Variance},{?Underpaid:Underpaid},{?Overpaid:Overpaid}'
        );
        const header = csv.split('\n')[0];
        expect(header).toBe('Last Name,Contract Amount');
        expect(csv).not.toContain('Variance');
    });

    it('includes {?Name} columns when any row has a meaningful value', () => {
        const csv = VendorExportService.formatAsCSVFromTemplate(
            [
                {
                    'Last Name': 'Dally',
                    'Vendor Amount': 121.03,
                    'Paid Amount': 109.83,
                    Variance: -11.2
                },
                {
                    'Last Name': 'Underpaid Total',
                    Underpaid: 208.22
                }
            ],
            '{LastName:Last Name},{ContractAmount:Contract Amount},{?Variance:Variance},{?Underpaid:Underpaid},{?Overpaid:Overpaid}'
        );
        const header = csv.split('\n')[0];
        expect(header).toBe('Last Name,Contract Amount,Variance,Underpaid');
        expect(csv).not.toContain('Overpaid');
        expect(csv).toContain('Underpaid Total');
    });
});

describe('formatPayablesCSV with clawbacks', () => {
    it('appends clawback rows, contract/paid footers, and net ACH footer', () => {
        const memberRows = [
            {
                'Alternate ID': 'M1',
                'First Name': 'Shane',
                'Last Name': 'Swinehart',
                'Product Name': 'Essential (ShareWELL)',
                'Product Type': 'Healthcare',
                'Vendor Amount': 250,
                Premium: 250,
                'Paid Amount': 218,
                Variance: -32
            }
        ];
        const { csv, total, contractTotal, paidTotal, netTotal, clawbacksTotal } = VendorExportService.formatPayablesCSV(
            memberRows,
            {},
            '2026-05-01',
            '2026-05-31',
            {
                clawbackRows: [
                    {
                        HouseholdName: 'Dawn Taylor',
                        HouseholdMemberID: 'SW15990863',
                        MemberState: 'TX',
                        ConsumedFromClawback: 149,
                        RefundReason: 'Customer Request'
                    }
                ],
                nachaPayoutNet: 69
            }
        );
        expect(total).toBe(250);
        expect(contractTotal).toBe(250);
        expect(paidTotal).toBe(218);
        expect(clawbacksTotal).toBe(-149);
        expect(netTotal).toBe(69);
        expect(csv).toContain('Dawn');
        expect(csv).toContain('Payables Total');
        expect(csv).toContain('Paid Total');
        expect(csv).toContain('Still owe');
        expect(csv).toContain('Net ACH');
    });

    it('omits gap footer row when contract matches paid', () => {
        const memberRows = [
            {
                'Alternate ID': 'M1',
                'First Name': 'Alex',
                'Last Name': 'Alexander',
                'Vendor Amount': 61.92,
                Premium: 61.92,
                'Paid Amount': 61.92
            }
        ];
        const { csv } = VendorExportService.formatPayablesCSV(memberRows, {}, '2026-05-01', '2026-05-31');
        expect(csv).toContain('Payables Total');
        expect(csv).toContain('Paid Total');
        expect(csv).not.toContain('Still owe');
        expect(csv).not.toContain('Overpaid Amount');
    });

    it('labels positive gap as Overpaid Amount', () => {
        const memberRows = [
            {
                'Alternate ID': 'M1',
                'First Name': 'Pat',
                'Last Name': 'Lee',
                'Vendor Amount': 100,
                Premium: 100,
                'Paid Amount': 125
            }
        ];
        const { csv } = VendorExportService.formatPayablesCSV(memberRows, {}, '2026-05-01', '2026-05-31');
        expect(csv).toContain('Overpaid Amount');
        expect(csv).toContain('25');
        expect(csv).not.toContain('Still owe');
    });
});

describe('buildPayablesReconciliationSummary', () => {
    it('reconciles paid total to net ACH; contract may differ', () => {
        const summary = VendorExportService.buildPayablesReconciliationSummary({
            nachaPayout: 606,
            nachaPayoutGross: 755,
            payablesTotal: 2720,
            paidTotal: 514.34,
            allocationWarnings: [{ notOnPayablesFile: 72.2 }],
            clawbacksTotalApplied: 149
        });
        expect(summary.nachaPayout).toBe(606);
        expect(summary.contractTotal).toBe(2720);
        expect(summary.paidTotal).toBe(514.34);
        expect(summary.contractVsPaidVariance).toBeCloseTo(-2205.66, 2);
        expect(summary.gap).toBeCloseTo(91.66, 2);
        expect(summary.unexplainedGap).toBeCloseTo(514.34 + 72.2 - 606 - 149, 2);
        expect(summary.reconciledWithClawbacks).toBe(false);
        expect(summary.notOnPayablesFile).toBeCloseTo(72.2, 2);
    });

    it('treats itemized not-on-payables amounts as explained (ARM Dental terminated-enrollment case)', () => {
        const summary = VendorExportService.buildPayablesReconciliationSummary({
            nachaPayout: 2565.57,
            nachaPayoutGross: 2565.57,
            payablesTotal: 2720,
            paidTotal: 2503.65,
            allocationWarnings: [{ notOnPayablesFile: 61.92 }],
            clawbacksTotalApplied: 0
        });
        expect(summary.unexplainedGap).toBeCloseTo(0, 2);
        expect(summary.gap).toBeCloseTo(61.92, 2);
        expect(summary.contractVsPaidVariance).toBeCloseTo(-216.35, 2);
        expect(summary.notOnPayablesFile).toBeCloseTo(61.92, 2);
    });

    it('marks reconciled when payables paid total matches net ACH plus clawbacks', () => {
        const summary = VendorExportService.buildPayablesReconciliationSummary({
            nachaPayout: 606,
            nachaPayoutGross: 755,
            payablesTotal: 800,
            paidTotal: 755,
            allocationWarnings: [],
            clawbacksTotalApplied: 149
        });
        expect(summary.unexplainedGap).toBe(0);
        expect(summary.reconciledWithClawbacks).toBe(true);
    });
});
