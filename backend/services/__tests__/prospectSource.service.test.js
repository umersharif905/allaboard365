const svc = require('../prospectSource.service');

describe('generateLinkCode', () => {
  test('returns a 6-char lowercase alphanumeric code', () => {
    const code = svc.generateLinkCode();
    expect(code).toMatch(/^[a-z0-9]{6}$/);
  });
  test('codes differ across calls', () => {
    expect(svc.generateLinkCode()).not.toBe(svc.generateLinkCode());
  });
});

describe('buildPublicLink', () => {
  test('appends id param with AgentCode_LinkCode', () => {
    const url = svc.buildPublicLink('https://x.com/get-covered', 'id', 'MWA000124', 'a1b2c3');
    expect(url).toBe('https://x.com/get-covered?id=MWA000124_a1b2c3');
  });
  test('merges into existing query string', () => {
    const url = svc.buildPublicLink('https://x.com/q?utm=fb', 'id', 'MWA1', 'zz99');
    expect(url).toBe('https://x.com/q?utm=fb&id=MWA1_zz99');
  });
  test('null linkCode -> plain ?id=<AgentCode> (no underscore)', () => {
    const url = svc.buildPublicLink('https://x.com/', 'id', 'MWA1', null);
    expect(url).toBe('https://x.com/?id=MWA1');
  });
});

describe('parseCompositeId', () => {
  test('splits agentCode and suffix on first underscore', () => {
    expect(svc.parseCompositeId('MWA000124_a1b2c3')).toEqual({ agentCode: 'MWA000124', suffix: 'a1b2c3' });
  });
  test('no underscore -> suffix null', () => {
    expect(svc.parseCompositeId('MWA000124')).toEqual({ agentCode: 'MWA000124', suffix: null });
  });
  test('empty/falsey -> nulls', () => {
    expect(svc.parseCompositeId('')).toEqual({ agentCode: null, suffix: null });
  });
});
