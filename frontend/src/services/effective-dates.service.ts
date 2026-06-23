// frontend/src/services/effective-dates.service.ts
import { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';

export interface EffectiveDateOptions {
  type: 'fixed' | 'dropdown' | 'calendar';
  fixedDate?: string | null;
  availableDates?: string[] | null;
  dateRange?: {
    earliest: string;
    latest: string;
  } | null;
  restrictions: {
    mustBeFirstOfMonth: boolean;
    maxDaysInFuture?: number;
    allowedDays?: number[];
    householdCohort?: 'FIRST' | 'FIFTEENTH' | null;
    windowMonthsPast?: number;
    windowMonthsFuture?: number;
  };
}

export interface EffectiveDatesResponse {
  enrollmentType: 'Group' | 'Individual';
  memberQualified: boolean;
  qualificationMessage: string;
  effectiveDateOptions: EffectiveDateOptions;
}

export class EffectiveDatesService {
  /**
   * Get available effective dates for any scenario
   * 
   * @param memberId - The member ID (required)
   * @param selectedProducts - Array of selected product IDs (optional)
   * @returns Promise<ApiResponse<EffectiveDatesResponse>>
   */
  static async getEffectiveDates(
    memberId: string,
    selectedProducts: string[] = [],
    windowOverride?: { pastMonths?: number; futureMonths?: number }
  ): Promise<ApiResponse<EffectiveDatesResponse>> {
    try {
      const queryParams = new URLSearchParams();

      // Only add memberId if it exists (for Agent-Static links, it will be empty)
      if (memberId && memberId.trim()) {
        queryParams.append('memberId', memberId);
      }

      if (selectedProducts.length > 0) {
        queryParams.append('selectedProducts', selectedProducts.join(','));
      }

      if (windowOverride?.pastMonths != null) {
        queryParams.append('pastMonths', String(windowOverride.pastMonths));
      }
      if (windowOverride?.futureMonths != null) {
        queryParams.append('futureMonths', String(windowOverride.futureMonths));
      }
      
      const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';
      const endpoint = `/api/effective-dates${queryString}`;
      
      console.log('🔍 DEBUG: Fetching effective dates - memberId:', memberId || 'N/A (Agent-Static)', 'selectedProducts:', selectedProducts);
      
      return await apiService.get<ApiResponse<EffectiveDatesResponse>>(endpoint);
    } catch (error) {
      console.error('❌ Error fetching effective dates:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to fetch effective dates',
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          code: 'EFFECTIVE_DATES_ERROR'
        }
      };
    }
  }
}

export default EffectiveDatesService;
