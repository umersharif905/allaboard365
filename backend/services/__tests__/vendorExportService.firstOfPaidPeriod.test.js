const VendorExportService = require('../vendorExportService');

describe('firstOfPaidPeriodMonthMDY', () => {
  it('returns 4/1/2026 for a 1st-cohort period starting 4/1', () => {
    const result = VendorExportService.firstOfPaidPeriodMonthMDY(
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-30T23:59:59Z')
    );
    expect(result).toBe('4/1/2026');
  });
  it('returns 4/15/2026 for a 15th-cohort period starting 4/15', () => {
    const result = VendorExportService.firstOfPaidPeriodMonthMDY(
      new Date('2026-04-15T00:00:00Z'),
      new Date('2026-05-14T23:59:59Z')
    );
    expect(result).toBe('4/15/2026');
  });
});

describe('eligibility template dateOffset modifier', () => {
  it('parseEligibilityDateDisplayToParts reads M/d/yyyy and ISO', () => {
    expect(VendorExportService.parseEligibilityDateDisplayToParts('5/15/2026')).toEqual({ y: 2026, m: 5, d: 15 });
    expect(VendorExportService.parseEligibilityDateDisplayToParts('2026-05-15')).toEqual({ y: 2026, m: 5, d: 15 });
    expect(VendorExportService.parseEligibilityDateDisplayToParts('05152026')).toEqual({ y: 2026, m: 5, d: 15 });
  });

  it('applyDateOffsetSpec: _/1/_ forces first of month', () => {
    const out = VendorExportService.applyDateOffsetSpec({ y: 2026, m: 5, d: 15 }, '_/1/_');
    expect(out).toEqual({ y: 2026, m: 5, d: 1 });
  });

  it('applyDateOffsetSpec: 5/1/_ sets May 1, same year', () => {
    expect(VendorExportService.applyDateOffsetSpec({ y: 2026, m: 3, d: 20 }, '5/1/_')).toEqual({ y: 2026, m: 5, d: 1 });
  });

  it('applyDateOffsetSpec: _/_/2027 overrides year only', () => {
    expect(VendorExportService.applyDateOffsetSpec({ y: 2026, m: 4, d: 10 }, '_/_/2027')).toEqual({
      y: 2027,
      m: 4,
      d: 10
    });
  });

  it('formatAsCSVFromTemplate applies dateOffset after vendor date format', () => {
    const template = '{EnrollmentDate(dateOffset=_/1/_):Eff}';
    const csv = VendorExportService.formatAsCSVFromTemplate(
      [{ 'Enrollment Date': '5/15/2026' }],
      template,
      { EligibilityDateFormat: 'Padded' }
    );
    expect(csv.split('\n')[1]).toBe('05/01/2026');
  });
});
