const {
    shapePrefillRow,
    isPlaceholderEmail
} = require('../publicFormInvitationPrefillService');

describe('isPlaceholderEmail', () => {
    it('treats synthetic @noemail.com dependent addresses as placeholders', () => {
        expect(isPlaceholderEmail('dependent-abc@noemail.com')).toBe(true);
        expect(isPlaceholderEmail('SW0530092+dep-1@NOEMAIL.com')).toBe(true);
    });
    it('treats empty / null as a placeholder', () => {
        expect(isPlaceholderEmail('')).toBe(true);
        expect(isPlaceholderEmail(null)).toBe(true);
        expect(isPlaceholderEmail(undefined)).toBe(true);
    });
    it('keeps real addresses', () => {
        expect(isPlaceholderEmail('jane@example.com')).toBe(false);
    });
});

describe('shapePrefillRow', () => {
    const baseRow = {
        FirstName: 'Miles',
        LastName: 'Loiselle',
        PhoneNumber: null,
        HouseholdMemberID: null,
        DateOfBirth: '2008-09-19T00:00:00.000Z',
        RelationshipType: 'C',
        Address: '1 Main St',
        City: 'Reno',
        State: 'NV',
        Zip: '89501'
    };

    it('does NOT autofill a dependent placeholder email into the email field', () => {
        const out = shapePrefillRow(
            { ...baseRow, Email: 'dependent-286b0024@noemail.com' },
            null
        );
        // The bug: a child/spouse selection autofilled a junk @noemail.com address.
        expect(out.email).toBeNull();
        // Other fields still flow through so the dependent autofills correctly.
        expect(out.firstName).toBe('Miles');
        expect(out.dateOfBirth).toBe('2008-09-19');
        expect(out.relationToPrimary).toBe('child');
        expect(out.addressCity).toBe('Reno');
    });

    it('keeps a real email', () => {
        const out = shapePrefillRow({ ...baseRow, Email: 'stephanie@example.com' }, '1500');
        expect(out.email).toBe('stephanie@example.com');
        expect(out.uaTier).toBe('1500');
    });

    it('tolerates a member with no user row (LEFT JOIN miss): all user fields null', () => {
        const out = shapePrefillRow(
            {
                FirstName: null, LastName: null, Email: null, PhoneNumber: null,
                HouseholdMemberID: 'MW123', DateOfBirth: null, RelationshipType: 'C',
                Address: null, City: null, State: null, Zip: null
            },
            null
        );
        expect(out.email).toBeNull();
        expect(out.firstName).toBeNull();
        expect(out.memberId).toBe('MW123');
        expect(out.relationToPrimary).toBe('child');
    });
});

describe('shapePrefillRow — household primary fallback for dependents', () => {
    // A spouse/child whose own record carries no member ID, phone, or address —
    // those live on the household primary (RelationshipType 'P').
    const dependentRow = {
        FirstName: 'Miles', LastName: 'Loiselle', Email: 'dep@noemail.com',
        PhoneNumber: null, HouseholdMemberID: null,
        DateOfBirth: '2008-09-19T00:00:00.000Z', RelationshipType: 'C',
        Address: null, City: null, State: null, Zip: null
    };
    const family = {
        memberId: 'MW15990304', phone: '734-459-9970',
        addressLine1: '24861 Davenport Ave', addressCity: 'Novi',
        addressState: 'MI', addressZip: '48374'
    };

    it('fills a dependent’s blank member ID, phone, and address from the primary', () => {
        const out = shapePrefillRow(dependentRow, null, family);
        expect(out.memberId).toBe('MW15990304');          // family ID for everyone
        expect(out.phone).toBe('734-459-9970');           // primary's phone
        expect(out.addressLine1).toBe('24861 Davenport Ave');
        expect(out.addressCity).toBe('Novi');
        expect(out.addressState).toBe('MI');
        expect(out.addressZip).toBe('48374');
        // Individual fields stay the dependent's own.
        expect(out.firstName).toBe('Miles');
        expect(out.dateOfBirth).toBe('2008-09-19');
        expect(out.relationToPrimary).toBe('child');
        expect(out.email).toBeNull();
    });

    it('keeps a dependent’s own phone when present (fallback only fills blanks)', () => {
        const out = shapePrefillRow({ ...dependentRow, PhoneNumber: '7347519698' }, null, family);
        expect(out.phone).toBe('7347519698');
    });

    it('member ID is always the family ID, even if a dependent has a stray own ID', () => {
        const out = shapePrefillRow({ ...dependentRow, HouseholdMemberID: 'STRAY1' }, null, family);
        expect(out.memberId).toBe('MW15990304');
    });

    it('uses the dependent’s own full address when present (no mixed/partial merge)', () => {
        const out = shapePrefillRow(
            { ...dependentRow, Address: '5 Oak St', City: 'Reno', State: 'NV', Zip: '89501' },
            null, family
        );
        expect(out.addressLine1).toBe('5 Oak St');
        expect(out.addressCity).toBe('Reno');
        expect(out.addressState).toBe('NV');
        expect(out.addressZip).toBe('89501');
    });

    it('no family fallback (no household / no primary) → own blank values, no crash', () => {
        const out = shapePrefillRow(dependentRow, null);
        expect(out.memberId).toBeNull();
        expect(out.phone).toBeNull();
        expect(out.addressLine1).toBeNull();
    });
});

describe('shapePrefillRow — email fallback to the primary', () => {
    const familyWithEmail = {
        memberId: 'MW1', phone: '555-0100', email: 'primary@example.com',
        addressLine1: '1 Main', addressCity: 'Reno', addressState: 'NV', addressZip: '89501'
    };
    const child = {
        FirstName: 'Kid', LastName: 'Doe', Email: 'kid-1@noemail.com',
        PhoneNumber: null, HouseholdMemberID: null, DateOfBirth: null,
        RelationshipType: 'C', Address: null, City: null, State: null, Zip: null
    };

    it('uses the primary email when the dependent has only a @noemail placeholder', () => {
        const out = shapePrefillRow(child, null, familyWithEmail);
        expect(out.email).toBe('primary@example.com');
    });

    it('keeps a spouse’s own real email over the primary’s', () => {
        const out = shapePrefillRow(
            { ...child, RelationshipType: 'S', Email: 'spouse@example.com' },
            null,
            familyWithEmail
        );
        expect(out.email).toBe('spouse@example.com');
    });

    it('stays null when neither the dependent nor the primary has a real email', () => {
        const out = shapePrefillRow(child, null, { memberId: 'MW1', email: null });
        expect(out.email).toBeNull();
    });
});
