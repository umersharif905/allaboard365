import { apiService } from './api.service';

export interface MentionableUser {
  UserId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  roles: string[];
}

interface MentionableResponse {
  success: boolean;
  data?: MentionableUser[];
}

/**
 * Active back-office teammates (VendorAgent/VendorAdmin) in the caller's
 * vendor, excluding the caller. Used to power @-mention autocomplete in
 * Share Request and Case notes.
 */
export async function listMentionableVendorUsers(
  signal?: AbortSignal
): Promise<MentionableUser[]> {
  const resp = await apiService.get<MentionableResponse>(
    '/api/me/vendor/users/mentionable',
    signal ? { signal } : undefined
  );
  return resp.success && Array.isArray(resp.data) ? resp.data : [];
}

export const mentionDisplayName = (u: MentionableUser): string =>
  `${u.FirstName || ''} ${u.LastName || ''}`.trim();
