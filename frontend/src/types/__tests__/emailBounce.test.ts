import { describe, it, expect } from 'vitest';
import { isLikelyBounce } from '../email.types';

const t = (over: Partial<{ Subject: string; CounterpartyName: string; CounterpartyAddress: string }>) => ({
  Subject: null, CounterpartyName: null, CounterpartyAddress: null, ...over,
}) as Parameters<typeof isLikelyBounce>[0];

describe('isLikelyBounce', () => {
  it('flags Undeliverable subjects', () => {
    expect(isLikelyBounce(t({ Subject: 'Undeliverable: RE: Your claim' }))).toBe(true);
  });
  it('flags postmaster / mailer-daemon senders', () => {
    expect(isLikelyBounce(t({ CounterpartyAddress: 'postmaster@outlook.com' }))).toBe(true);
    expect(isLikelyBounce(t({ CounterpartyAddress: 'MAILER-DAEMON@googlemail.com' }))).toBe(true);
  });
  it('flags Exchange NDR system senders', () => {
    expect(isLikelyBounce(t({ CounterpartyAddress: 'microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@sharewellpartners.com' }))).toBe(true);
  });
  it('does not flag a normal customer email', () => {
    expect(isLikelyBounce(t({ Subject: 'Question about my reimbursement', CounterpartyAddress: 'jordan@gmail.com' }))).toBe(false);
  });
});
