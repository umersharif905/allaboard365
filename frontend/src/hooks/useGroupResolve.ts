// frontend/src/hooks/useGroupResolve.ts
import { useQuery } from '@tanstack/react-query';
import { GroupsService } from '../services/groups.service';

/** Matches a standard UUID v4 / v1 format. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a route identifier (UUID or slug) to a canonical groupId.
 *
 * - If `identifier` is already a UUID, it is returned immediately with no network call.
 * - If `identifier` is a slug, calls GET /api/groups/resolve/:identifier to get the real UUID.
 *
 * Usage:
 *   const { groupId, isLoading, isError } = useGroupResolve(identifier);
 */
export const useGroupResolve = (identifier?: string) => {
    const isUuid = !!identifier && UUID_RE.test(identifier);

    const { data, isLoading, isError, error } = useQuery({
        queryKey: ['groupResolve', identifier],
        queryFn: async () => {
            if (!identifier) throw new Error('No identifier provided');
            // UUID — skip the network call
            if (UUID_RE.test(identifier)) return { groupId: identifier };
            const res = await GroupsService.resolveGroupIdentifier(identifier);
            const resolvedId = res.data?.groupId || (res.data as { GroupId?: string } | undefined)?.GroupId;
            if (!res.success || !resolvedId) {
                throw new Error(res.message || `Group not found for identifier: ${identifier}`);
            }
            return { groupId: resolvedId };
        },
        enabled: !!identifier,
        staleTime: 5 * 60_000, // 5 minutes — slugs rarely change
        retry: 1,
    });

    return {
        /** Resolved canonical groupId (UUID). Undefined while resolving a slug. */
        groupId: isUuid ? identifier : data?.groupId,
        /** True only when a slug is being resolved via the network. */
        isLoading: !isUuid && isLoading,
        isError,
        error,
    };
};
