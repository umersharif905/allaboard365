'use strict';

const { nextAllowedSendTime } = require('../nextAllowedSendTime');

describe('nextAllowedSendTime', () => {
  it('returns a future UTC instant', () => {
    const now = new Date('2026-06-08T03:00:00.000Z'); // midnight-ish ET
    const next = nextAllowedSendTime(now);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  it('skips Sunday for a Saturday night request', () => {
    const satNight = new Date('2026-06-07T03:00:00.000Z'); // Sat ~11pm ET
    const next = nextAllowedSendTime(satNight);
    const wd = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(next);
    expect(wd).toMatch(/Mon/);
    expect(wd).toMatch(/11:00/);
  });
});
