const {
    pickUaTierFromEnrollmentRows,
    mapRelationToPrimary
} = require('../publicFormInvitationPrefillService');

describe('pickUaTierFromEnrollmentRows', () => {
    it('reads the ConfigValue matching the UA field index (index 0 -> ConfigValue1)', () => {
        const rows = [{
            RequiredDataFields: JSON.stringify([{ fieldName: 'Unshared Amount $' }]),
            ConfigValue1: '2500'
        }];
        expect(pickUaTierFromEnrollmentRows(rows)).toBe('2500');
    });

    it('maps a UA field at index 2 to ConfigValue3', () => {
        const rows = [{
            RequiredDataFields: JSON.stringify([
                { fieldName: 'Plan Level' },
                { fieldName: 'Tobacco' },
                { fieldName: 'Unshared amount' }
            ]),
            ConfigValue1: 'Gold',
            ConfigValue2: 'No',
            ConfigValue3: '5000'
        }];
        expect(pickUaTierFromEnrollmentRows(rows)).toBe('5000');
    });

    it('accepts RequiredDataFields as an already-parsed array', () => {
        const rows = [{
            RequiredDataFields: [{ fieldName: 'unshared   amount' }],
            ConfigValue1: '1500'
        }];
        expect(pickUaTierFromEnrollmentRows(rows)).toBe('1500');
    });

    it('returns null when no UA field is present', () => {
        const rows = [{
            RequiredDataFields: JSON.stringify([{ fieldName: 'Deductible' }]),
            ConfigValue1: '1000'
        }];
        expect(pickUaTierFromEnrollmentRows(rows)).toBeNull();
    });

    it('skips a row whose UA ConfigValue is empty, falling through to the next row', () => {
        const rows = [
            { RequiredDataFields: JSON.stringify([{ fieldName: 'Unshared Amount' }]), ConfigValue1: '' },
            { RequiredDataFields: JSON.stringify([{ fieldName: 'Unshared Amount' }]), ConfigValue1: '2500' }
        ];
        expect(pickUaTierFromEnrollmentRows(rows)).toBe('2500');
    });

    it('ignores malformed RequiredDataFields JSON', () => {
        const rows = [{ RequiredDataFields: '{not valid', ConfigValue1: '2500' }];
        expect(pickUaTierFromEnrollmentRows(rows)).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(pickUaTierFromEnrollmentRows([])).toBeNull();
        expect(pickUaTierFromEnrollmentRows(undefined)).toBeNull();
    });
});

describe('mapRelationToPrimary', () => {
    it('maps P/S/C to self/spouse/child', () => {
        expect(mapRelationToPrimary('P')).toBe('self');
        expect(mapRelationToPrimary('S')).toBe('spouse');
        expect(mapRelationToPrimary('C')).toBe('child');
    });
});
