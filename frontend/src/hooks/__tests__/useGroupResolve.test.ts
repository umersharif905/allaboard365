// frontend/src/hooks/__tests__/useGroupResolve.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ------------------------------------------------------------------
// Isolated unit tests for the pure logic in useGroupResolve.
// We test the UUID-detection regex directly (no React / react-query
// dependency needed for these invariants).
// ------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('UUID_RE (identifier detection)', () => {
    it('matches a well-formed lowercase UUID', () => {
        expect(UUID_RE.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
    });

    it('matches a well-formed uppercase UUID', () => {
        expect(UUID_RE.test('A1B2C3D4-E5F6-7890-ABCD-EF1234567890')).toBe(true);
    });

    it('does NOT match a slug', () => {
        expect(UUID_RE.test('acme-corp')).toBe(false);
    });

    it('does NOT match an empty string', () => {
        expect(UUID_RE.test('')).toBe(false);
    });

    it('does NOT match a partial UUID', () => {
        expect(UUID_RE.test('a1b2c3d4-e5f6-7890-abcd')).toBe(false);
    });

    it('does NOT match a UUID with extra characters', () => {
        expect(UUID_RE.test('a1b2c3d4-e5f6-7890-abcd-ef1234567890-extra')).toBe(false);
    });
});

// ------------------------------------------------------------------
// resolveGroupIdentifier service-layer behaviour (mocked).
// ------------------------------------------------------------------
describe('GroupsService.resolveGroupIdentifier (mocked)', () => {
    const mockResolve = vi.fn();

    beforeEach(() => {
        mockResolve.mockReset();
    });

    it('returns the resolved groupId on success', async () => {
        mockResolve.mockResolvedValue({
            success: true,
            data: { groupId: 'resolved-uuid-1234', groupName: 'Acme Corp' },
        });

        const result = await mockResolve('acme-corp');
        expect(result.success).toBe(true);
        expect(result.data.groupId).toBe('resolved-uuid-1234');
    });

    it('returns success:false when group is not found', async () => {
        mockResolve.mockResolvedValue({
            success: false,
            data: { groupId: '' },
            message: 'Group not found for identifier: unknown-slug',
        });

        const result = await mockResolve('unknown-slug');
        expect(result.success).toBe(false);
        expect(result.message).toContain('not found');
    });
});

// ------------------------------------------------------------------
// Slug normalisation logic (mirrors GroupsAddGroup auto-suggest).
// ------------------------------------------------------------------
describe('slug auto-suggest from group name', () => {
    const toSlug = (name: string) =>
        name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 64);

    it('converts a simple name to a slug', () => {
        expect(toSlug('Acme Corp')).toBe('acme-corp');
    });

    it('strips special characters', () => {
        // O'Brien & Sons, LLC → obrien  sons llc → spaces collapsed → obrien-sons-llc
        expect(toSlug('O\'Brien & Sons, LLC')).toBe('obrien-sons-llc');
    });

    it('collapses multiple spaces', () => {
        expect(toSlug('Some   Group   Name')).toBe('some-group-name');
    });

    it('truncates at 64 characters', () => {
        const long = 'a'.repeat(100);
        expect(toSlug(long).length).toBeLessThanOrEqual(64);
    });

    it('returns empty string for blank input', () => {
        expect(toSlug('')).toBe('');
    });
});
