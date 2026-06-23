/**
 * Unit tests for vendor group ID helpers.
 *
 * Covers (per plan Part E6):
 *  - formatVendorGroupId for Prefix and Suffix.
 *  - parseNumericPartFromVendorGroupId — anchored strip, digit-rich prefix,
 *    malformed input.
 *  - normalizeBetweenGroupsStep — NULL → 5; 1, 10 pass through.
 *  - normalizeAffixPosition — NULL/unknown → 'Prefix'; case-insensitive accept.
 *  - buildNumericPartSqlExpr — emits TRY_CAST when no prefix; emits anchored
 *    LEFT/RIGHT comparison + SUBSTRING when prefix is configured.
 *
 * These helpers are pure and do not touch the database, so this suite runs
 * without any mocks.
 */

const VendorGroupIdService = require('../vendorGroupIdService');

describe('VendorGroupIdService.normalizeAffixPosition', () => {
    test('NULL/undefined → Prefix', () => {
        expect(VendorGroupIdService.normalizeAffixPosition(null)).toBe('Prefix');
        expect(VendorGroupIdService.normalizeAffixPosition(undefined)).toBe('Prefix');
        expect(VendorGroupIdService.normalizeAffixPosition('')).toBe('Prefix');
    });

    test('case-insensitive accept', () => {
        expect(VendorGroupIdService.normalizeAffixPosition('Prefix')).toBe('Prefix');
        expect(VendorGroupIdService.normalizeAffixPosition('Suffix')).toBe('Suffix');
        expect(VendorGroupIdService.normalizeAffixPosition('PREFIX')).toBe('Prefix');
        expect(VendorGroupIdService.normalizeAffixPosition('suffix')).toBe('Suffix');
    });

    test('unknown values fall back to Prefix', () => {
        expect(VendorGroupIdService.normalizeAffixPosition('middle')).toBe('Prefix');
        expect(VendorGroupIdService.normalizeAffixPosition(123)).toBe('Prefix');
    });
});

describe('VendorGroupIdService.normalizeBetweenGroupsStep', () => {
    test('NULL/undefined → 5 (legacy ARM default)', () => {
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(null)).toBe(5);
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(undefined)).toBe(5);
    });

    test('positive integers pass through', () => {
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(1)).toBe(1);
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(5)).toBe(5);
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(10)).toBe(10);
    });

    test('zero / negative / non-numeric fall back to 5', () => {
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(0)).toBe(5);
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(-3)).toBe(5);
        expect(VendorGroupIdService.normalizeBetweenGroupsStep('abc')).toBe(5);
    });

    test('floors decimals', () => {
        expect(VendorGroupIdService.normalizeBetweenGroupsStep(2.7)).toBe(2);
    });
});

describe('VendorGroupIdService.formatVendorGroupId', () => {
    test('no prefix → numeric only', () => {
        expect(VendorGroupIdService.formatVendorGroupId('', 1001)).toBe('1001');
        expect(VendorGroupIdService.formatVendorGroupId(null, 1001, 'Suffix')).toBe('1001');
    });

    test('Prefix mode (default) places affix at start', () => {
        expect(VendorGroupIdService.formatVendorGroupId('MW', 1001)).toBe('MW1001');
        expect(VendorGroupIdService.formatVendorGroupId('MW', 1001, 'Prefix')).toBe('MW1001');
    });

    test('Suffix mode places affix at end', () => {
        expect(VendorGroupIdService.formatVendorGroupId('MW', 1001, 'Suffix')).toBe('1001MW');
    });

    test('digit-rich prefix is preserved exactly', () => {
        expect(VendorGroupIdService.formatVendorGroupId('90', 1001)).toBe('901001');
        expect(VendorGroupIdService.formatVendorGroupId('90', 1001, 'Suffix')).toBe('100190');
    });
});

describe('VendorGroupIdService.parseNumericPartFromVendorGroupId', () => {
    test('no prefix → integer cast', () => {
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('1001', '')).toBe(1001);
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('90500', null)).toBe(90500);
    });

    test('Prefix mode strips from start (anchored)', () => {
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('MW1001', 'MW')).toBe(1001);
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('MW1001', 'MW', 'Prefix')).toBe(1001);
    });

    test('Suffix mode strips from end (anchored)', () => {
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('1001MW', 'MW', 'Suffix')).toBe(1001);
    });

    test('digit-rich prefix only strips when actually present at start', () => {
        // Stored ID "901001" with prefix "90" should yield 1001 (anchored), not "01" or NaN.
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('901001', '90')).toBe(1001);
    });

    test('digit-rich prefix in suffix mode never strips substring at start', () => {
        // Suffix "90" with stored "9090" must strip ONLY the trailing 90, leaving 90.
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('9090', '90', 'Suffix')).toBe(90);
    });

    test('returns NaN when shape does not match the configured affix', () => {
        // Prefix is "MW" but stored ID has no prefix → mismatch.
        expect(Number.isNaN(VendorGroupIdService.parseNumericPartFromVendorGroupId('1001', 'MW'))).toBe(true);
        // Stored ID is prefix mode but vendor configured as Suffix → mismatch.
        expect(Number.isNaN(VendorGroupIdService.parseNumericPartFromVendorGroupId('MW1001', 'MW', 'Suffix'))).toBe(true);
        // Empty input.
        expect(Number.isNaN(VendorGroupIdService.parseNumericPartFromVendorGroupId('', 'MW'))).toBe(true);
        expect(Number.isNaN(VendorGroupIdService.parseNumericPartFromVendorGroupId(null, 'MW'))).toBe(true);
    });

    test('non-numeric residue → NaN', () => {
        // After stripping prefix, "abc" is non-numeric.
        expect(Number.isNaN(VendorGroupIdService.parseNumericPartFromVendorGroupId('MWabc', 'MW'))).toBe(true);
    });

    test('trims surrounding whitespace before matching', () => {
        expect(VendorGroupIdService.parseNumericPartFromVendorGroupId('  MW1001  ', 'MW')).toBe(1001);
    });
});

describe('VendorGroupIdService.buildNumericPartSqlExpr', () => {
    test('no prefix → plain TRY_CAST', () => {
        const expr = VendorGroupIdService.buildNumericPartSqlExpr('vgi.VendorGroupId', '', null, 'numericAffix');
        expect(expr).toBe('TRY_CAST(vgi.VendorGroupId AS INT)');
    });

    test('Prefix mode (default) emits anchored LEFT compare + SUBSTRING from after prefix', () => {
        const expr = VendorGroupIdService.buildNumericPartSqlExpr('vgi.VendorGroupId', 'MW', null, 'numericAffix');
        // Should compare LEFT(...) = @numericAffix and start SUBSTRING at position prefix.length + 1 = 3.
        expect(expr).toMatch(/LEFT\(vgi\.VendorGroupId, 2\) = @numericAffix/);
        expect(expr).toMatch(/SUBSTRING\(vgi\.VendorGroupId, 3,/);
        expect(expr).not.toMatch(/REPLACE\(/);
    });

    test('Suffix mode emits anchored RIGHT compare + LEFT trim', () => {
        const expr = VendorGroupIdService.buildNumericPartSqlExpr('vgi.VendorGroupId', 'MW', 'Suffix', 'numericAffix');
        expect(expr).toMatch(/RIGHT\(vgi\.VendorGroupId, 2\) = @numericAffix/);
        expect(expr).toMatch(/LEFT\(vgi\.VendorGroupId, LEN\(vgi\.VendorGroupId\) - 2\)/);
        expect(expr).not.toMatch(/REPLACE\(/);
    });

    test('digit-rich prefix uses anchored compare (never substring REPLACE)', () => {
        const expr = VendorGroupIdService.buildNumericPartSqlExpr('vgi.VendorGroupId', '90', 'Prefix', 'numericAffix');
        expect(expr).toMatch(/LEFT\(vgi\.VendorGroupId, 2\) = @numericAffix/);
        expect(expr).not.toMatch(/REPLACE\(/);
    });
});

describe('VendorGroupIdService preview/apply count expression — round trip', () => {
    /**
     * Smoke test: format + parse must be inverses for both Prefix and Suffix.
     * If preview ever derives baseGroupId differently from apply, both sides
     * use these helpers, so this round-trip is a strong invariant.
     */
    const cases = [
        { prefix: '', position: null, num: 90500 },
        { prefix: 'MW', position: 'Prefix', num: 1001 },
        { prefix: 'MW', position: 'Suffix', num: 1001 },
        { prefix: '90', position: 'Prefix', num: 1001 },
        { prefix: '90', position: 'Suffix', num: 1001 },
    ];
    test.each(cases)('round-trip prefix=$prefix pos=$position num=$num', ({ prefix, position, num }) => {
        const formatted = VendorGroupIdService.formatVendorGroupId(prefix, num, position);
        const parsed = VendorGroupIdService.parseNumericPartFromVendorGroupId(formatted, prefix, position);
        expect(parsed).toBe(num);
    });
});
