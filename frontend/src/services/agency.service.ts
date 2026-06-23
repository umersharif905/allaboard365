import { apiService } from './api.service';
import { ApiResponse } from '../types/index';

class AgencyService {
  /**
   * Get all agencies for the current tenant
   */
  static async getAgencies(): Promise<ApiResponse<any[]>> {
    return apiService.get('/api/agencies');
  }

  /**
   * Get single agency by ID
   */
  static async getAgency(agencyId: string): Promise<ApiResponse<any>> {
    return apiService.get(`/api/agencies/${agencyId}`);
  }
}

export default AgencyService;

