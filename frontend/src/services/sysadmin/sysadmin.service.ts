import type { ApiResponse } from '../../types/api.types';
import { apiService } from '../api.service';
import type { Group } from '../groups.service';

export class SysAdminService {
  /**
   * Creates a new group for any tenant (SysAdmin access)
   * @param groupData - The group data to create
   * @returns A promise that resolves to the created group
   */
  static async createGroup(groupData: Partial<Group>): Promise<ApiResponse<Group>> {
    return apiService.post<ApiResponse<Group>>('/api/me/sysadmin/groups', groupData);
  }

  /**
   * Gets all groups across all tenants for SysAdmin
   * @returns A promise that resolves to an array of groups
   */
  static async getGroups(): Promise<ApiResponse<Group[]>> {
    return apiService.get<ApiResponse<Group[]>>('/api/me/sysadmin/groups');
  }

  /**
   * Gets a specific group by ID for SysAdmin
   * @param groupId - The ID of the group to fetch
   * @returns A promise that resolves to the group data
   */
  static async getGroup(groupId: string): Promise<ApiResponse<Group>> {
    return apiService.get<ApiResponse<Group>>(`/api/me/sysadmin/groups/${groupId}`);
  }
}

export default SysAdminService;
