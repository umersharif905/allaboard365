import { describe, expect, it } from 'vitest';
import {
  buildDailyCronUtc,
  easternToUtcParts,
  formatScheduleSummary,
  parseVendorImportCron,
  utcToEasternParts,
} from '../vendorImportJobSchedule';

describe('vendorImportJobSchedule', () => {
  it('converts Mutual Health noon/midnight ET to 5,17 UTC', () => {
    expect(easternToUtcParts(0, 0)).toEqual({ hour: 5, minute: 0 });
    expect(easternToUtcParts(12, 0)).toEqual({ hour: 17, minute: 0 });
    expect(buildDailyCronUtc(0, [{ hour: 0, minute: 0 }, { hour: 12, minute: 0 }])).toBe('0 0 5,17 * * *');
  });

  it('converts MPB AllAboard 9 AM/PM ET to 2,14 UTC', () => {
    expect(buildDailyCronUtc(0, [{ hour: 9, minute: 0 }, { hour: 21, minute: 0 }])).toBe('0 0 2,14 * * *');
  });

  it('converts Align SHA 10:30 AM/PM ET to 3,15 UTC at minute 30', () => {
    expect(buildDailyCronUtc(30, [{ hour: 22, minute: 30 }, { hour: 10, minute: 30 }])).toBe('0 30 3,15 * * *');
  });

  it('parses cron back to Eastern slots', () => {
    const parsed = parseVendorImportCron('0 0 5,17 * * *');
    expect(parsed).toEqual({
      kind: 'daily',
      minute: 0,
      slots: [{ hour: 0, minute: 0 }, { hour: 12, minute: 0 }],
    });
  });

  it('round-trips MPB cron', () => {
    const cron = '0 0 2,14 * * *';
    const parsed = parseVendorImportCron(cron);
    expect(parsed.kind).toBe('daily');
    if (parsed.kind === 'daily') {
      expect(buildDailyCronUtc(parsed.minute, parsed.slots)).toBe(cron);
    }
  });

  it('formats human-readable summary', () => {
    expect(formatScheduleSummary('0 0 5,17 * * *')).toBe('Daily at 12:00 AM and 12:00 PM ET');
    expect(formatScheduleSummary('0 0 2,14 * * *')).toBe('Daily at 9:00 AM and 9:00 PM ET');
    expect(formatScheduleSummary('0 0 1,13 * * *')).toBe('Daily at 8:00 AM and 8:00 PM ET');
  });

  it('utcToEasternParts handles wraparound', () => {
    expect(utcToEasternParts(2, 0)).toEqual({ hour: 21, minute: 0 });
  });

  it('marks weekday or non-zero-second cron as custom', () => {
    expect(parseVendorImportCron('0 0 5 * * 1').kind).toBe('custom');
    expect(parseVendorImportCron('5 0 5 * * *').kind).toBe('custom');
  });

  it('parses once-daily cron as friendly', () => {
    expect(parseVendorImportCron('0 30 2 * * *')).toEqual({
      kind: 'daily',
      minute: 30,
      slots: [{ hour: 21, minute: 30 }],
    });
  });
});
