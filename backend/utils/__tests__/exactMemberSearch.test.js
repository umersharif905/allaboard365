'use strict';

const { classifyExactSearch } = require('../exactMemberSearch');

describe('classifyExactSearch', () => {
    it('returns null for empty / whitespace input', () => {
        expect(classifyExactSearch('')).toBeNull();
        expect(classifyExactSearch('   ')).toBeNull();
        expect(classifyExactSearch(null)).toBeNull();
        expect(classifyExactSearch(undefined)).toBeNull();
    });

    it('does NOT qualify a lone first name (no off-plan browsing)', () => {
        expect(classifyExactSearch('John')).toBeNull();
        expect(classifyExactSearch('joh')).toBeNull();
        expect(classifyExactSearch('Smith')).toBeNull();
    });

    it('detects an exact email, lower-cased', () => {
        expect(classifyExactSearch('  John@Example.COM ')).toEqual({ email: 'john@example.com' });
        // bare '@' without a domain does not qualify
        expect(classifyExactSearch('john@')).toBeNull();
    });

    it('detects a phone by its last 10 digits', () => {
        // Formatting chars (+, parens) disqualify it as a card, so phone-only.
        expect(classifyExactSearch('+1 (555) 123-4567')).toEqual({ phone: '5551234567' });
        expect(classifyExactSearch('(555) 123-4567')).toEqual({ phone: '5551234567' });
        // fewer than 10 digits is not a phone
        expect(classifyExactSearch('123456')).toEqual({ card: '123456' });
    });

    it('detects a full name (two+ words with a letter)', () => {
        expect(classifyExactSearch('John Smith')).toEqual({ fullName: 'john smith' });
        expect(classifyExactSearch('  Mary  Jane   Watson ')).toEqual({ fullName: 'mary jane watson' });
    });

    it('detects a member card id (alphanumeric with a digit)', () => {
        expect(classifyExactSearch('SW8153334')).toEqual({ card: 'sw8153334' });
        // dashes are stripped; no internal space, so it stays card-only
        expect(classifyExactSearch('SW-8153334')).toEqual({ card: 'sw8153334' });
    });

    it('a 10-digit numeric qualifies as both phone and card (predicates are OR-ed)', () => {
        expect(classifyExactSearch('5551234567')).toEqual({ phone: '5551234567', card: '5551234567' });
        expect(classifyExactSearch('555-123-4567')).toEqual({ phone: '5551234567', card: '5551234567' });
    });

    it('an email never doubles as phone/name/card', () => {
        const r = classifyExactSearch('a.b+tag@mail.co');
        expect(r).toEqual({ email: 'a.b+tag@mail.co' });
    });
});
