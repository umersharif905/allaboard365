import type { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';

/**
 * ShareWELL "business card" email-signature config (oe.Users.EmailCard, stored as
 * JSON). `photoPath`/`compositePath` are managed by the photo-upload endpoint;
 * the rest are user-editable. GET /me returns this as a JSON string.
 */
export interface EmailCard {
  enabled?: boolean;
  title?: string | null;
  directPhone?: string | null;
  email?: string | null;
  website?: string | null;
  photoPath?: string | null;
  compositePath?: string | null;
}

/** Parse the EmailCard column, which GET /me returns as a JSON string (or null). */
export function parseEmailCard(raw: EmailCard | string | null | undefined): EmailCard | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as EmailCard; } catch { return null; }
  }
  return raw;
}

// Define a type that matches the actual API response with PascalCase properties
export interface UserProfileResponse {
  UserId: string;
  Email: string;
  FirstName: string;
  LastName: string;
  UserType: string;
  TenantId?: string;
  Status: string;
  CreatedDate: string;
  ModifiedDate: string;
  LastLoginDate?: string;
  PhoneNumber?: string;
  /** Free-form #rrggbb hex chosen by the user for their claim chip; null when unset. */
  PreferredColor?: string | null;
  /** Per-user Back Office email footer/signature; null when unset. */
  EmailSignature?: string | null;
  /** ShareWELL signature-card config; JSON string from the API (or null). */
  EmailCard?: EmailCard | string | null;
}

export class UserService {
  /**
   * Fetches the current user's profile data
   * @returns ApiResponse containing user profile data with SQL-style capitalized field names
   */
  static async getCurrentUserProfile(): Promise<ApiResponse<UserProfileResponse>> {
    try {
      return await apiService.get<ApiResponse<UserProfileResponse>>('/api/users/me');
    } catch (error) {
      console.error('❌ Error fetching user profile:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch user profile',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'USER_PROFILE_ERROR'
        }
      };
    }
  }

  /**
   * Upload the current user's email-signature headshot. The backend crops it to
   * an oval, composites it with the ShareWELL ornament, and returns the relative
   * path of the hosted composite (caller prepends API base + cache-buster).
   */
  static async uploadEmailSignaturePhoto(
    file: File
  ): Promise<ApiResponse<{ cardImagePath: string }>> {
    const formData = new FormData();
    formData.append('photo', file);
    return apiService.post<ApiResponse<{ cardImagePath: string }>>(
      '/api/me/email-signature/photo',
      formData
    );
  }
}

export default UserService; 