/**
 * Unit tests for ShortCodeService (pure logic + collision branches).
 *
 * Covers the documented divergence from the "numeric _2 suffix" path used
 * by `backend/routes/me/agent/enrollment-links.js:164-168`: this service
 * falls back to a RANDOM suffix, not a numeric one, when both underscore
 * and dash variants are taken.
 *
 * Run: npx jest short-code.service
 */

const mockQuery = jest.fn();
const mockInput = jest.fn().mockReturnThis();
const mockRequest = jest.fn(() => ({
  input: mockInput,
  query: mockQuery
}));
const mockPool = { request: mockRequest };

jest.mock('../../config/database', () => ({
  getPool: jest.fn(async () => mockPool),
  sql: {
    NVarChar: 'NVarChar'
  }
}));

const ShortCodeService = require('../shared/short-code.service');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ShortCodeService.normalize', () => {
  test('lowercases and strips non-alphanumeric', () => {
    expect(ShortCodeService.normalize("O'Brien-Smith")).toBe('obriensmith');
  });

  test('returns empty string for null/undefined', () => {
    expect(ShortCodeService.normalize(null)).toBe('');
    expect(ShortCodeService.normalize(undefined)).toBe('');
    expect(ShortCodeService.normalize('')).toBe('');
  });

  test('preserves digits', () => {
    expect(ShortCodeService.normalize('John3rd')).toBe('john3rd');
  });

  test('strips unicode accents (current behavior: drops them entirely)', () => {
    // NOTE: current impl drops accented chars since regex only keeps a-z0-9.
    // Test documents the behavior so a future normalize improvement is intentional.
    expect(ShortCodeService.normalize('José')).toBe('jos');
  });
});

describe('ShortCodeService.isValidShortCode', () => {
  test.each([
    ['ag_jeremy_francis', true],
    ['ag-jeremy-francis', true],
    ['ag_jeremy_francis_2', true],
    ['marketing_open_2026', true],
    ['mk-campaign-1', true]
  ])('accepts valid code %s', (code, expected) => {
    expect(ShortCodeService.isValidShortCode(code)).toBe(expected);
  });

  test.each([
    [null],
    [undefined],
    [''],
    [123],
    ['Uppercase_Code'],
    ['ag jeremy francis'],
    ['ag_jeremy_françis'],
    ['no_prefix'] // valid per current regex actually; see next
  ])('rejects invalid input %s', (code) => {
    if (code === 'no_prefix') {
      // Current regex /^[a-z]+[_-][a-z0-9_-]+$/ accepts this.
      // Documents behavior rather than failing.
      expect(ShortCodeService.isValidShortCode(code)).toBe(true);
    } else {
      expect(ShortCodeService.isValidShortCode(code)).toBe(false);
    }
  });
});

describe('ShortCodeService.generateAgentShortCode', () => {
  test('returns underscore variant when neither is taken', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    const code = await ShortCodeService.generateAgentShortCode('Jeremy', 'Francis');
    expect(code).toBe('ag_jeremy_francis');
  });

  test('returns dash variant when underscore is already taken', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [{ ShortCode: 'ag_jeremy_francis' }]
    });
    const code = await ShortCodeService.generateAgentShortCode('Jeremy', 'Francis');
    expect(code).toBe('ag-jeremy-francis');
  });

  test('returns underscore when only dash is taken', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [{ ShortCode: 'ag-jeremy-francis' }]
    });
    const code = await ShortCodeService.generateAgentShortCode('Jeremy', 'Francis');
    expect(code).toBe('ag_jeremy_francis');
  });

  test('falls back to random suffix (NOT numeric _2) when both variants taken', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [
        { ShortCode: 'ag_jeremy_francis' },
        { ShortCode: 'ag-jeremy-francis' }
      ]
    });
    const code = await ShortCodeService.generateAgentShortCode('Jeremy', 'Francis');
    // Documents the divergence from `me/agent/enrollment-links.js:164-168`
    // which uses `ag_first_last_${existingCount+1}`.
    expect(code).toMatch(/^ag_jeremy_francis_[a-z0-9]{5}$/);
    expect(code).not.toBe('ag_jeremy_francis_2');
  });

  test('supports custom prefix (e.g. marketing)', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    const code = await ShortCodeService.generateAgentShortCode(
      'Summer',
      'Campaign',
      null,
      'marketing'
    );
    expect(code).toBe('marketing_summer_campaign');
  });

  test('throws when first name is missing', async () => {
    await expect(
      ShortCodeService.generateAgentShortCode('', 'Francis')
    ).rejects.toThrow('First name and last name are required');
  });

  test('throws when last name is missing', async () => {
    await expect(
      ShortCodeService.generateAgentShortCode('Jeremy', null)
    ).rejects.toThrow('First name and last name are required');
  });

  test('throws when names contain no alphanumerics after normalize', async () => {
    await expect(
      ShortCodeService.generateAgentShortCode('---', '***')
    ).rejects.toThrow('Invalid first name or last name');
  });

  test('uses provided pool instead of calling getPool', async () => {
    const { getPool } = require('../../config/database');
    getPool.mockClear();
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    const customPool = { request: jest.fn(() => ({ input: mockInput, query: mockQuery })) };
    await ShortCodeService.generateAgentShortCode('A', 'B', customPool);
    expect(getPool).not.toHaveBeenCalled();
    expect(customPool.request).toHaveBeenCalled();
  });
});

describe('ShortCodeService.isShortCodeAvailable', () => {
  test('returns true when code does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ recordset: [] });
    await expect(
      ShortCodeService.isShortCodeAvailable('ag_new_code')
    ).resolves.toBe(true);
  });

  test('returns false when code exists', async () => {
    mockQuery.mockResolvedValueOnce({
      recordset: [{ ShortCode: 'ag_taken' }]
    });
    await expect(
      ShortCodeService.isShortCodeAvailable('ag_taken')
    ).resolves.toBe(false);
  });

  test('propagates DB errors', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection closed'));
    await expect(
      ShortCodeService.isShortCodeAvailable('ag_x')
    ).rejects.toThrow('connection closed');
  });
});
