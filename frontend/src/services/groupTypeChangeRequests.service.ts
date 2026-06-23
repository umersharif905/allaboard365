// frontend/src/services/groupTypeChangeRequests.service.ts
import { apiService } from './api.service';

export type GroupRequestStatus = 'Pending' | 'Approved' | 'Denied' | 'Cancelled';
export type GroupType = 'Standard' | 'ListBill';

export interface GroupTypeChangeRequest {
  RequestId: string;
  GroupId: string;
  TenantId: string;
  RequestedBy: string;
  CurrentType: GroupType;
  RequestedType: GroupType;
  Status: GroupRequestStatus;
  Reason: string | null;
  ReviewedBy: string | null;
  ReviewedAt: string | null;
  ReviewNotes: string | null;
  CreatedDate: string;
  ModifiedDate: string;
  /** JOIN'd from oe.Groups — display name of the group being converted */
  GroupName?: string | null;
  /** JOIN'd from oe.Users — full name of the agent who submitted the request */
  RequestedByName?: string | null;
  /** Present when requested by SysAdmin (cross-tenant fetch joins oe.Tenants) */
  TenantName?: string | null;
}

export async function createRequest(params: {
  groupId: string;
  requestedType: GroupType;
  reason: string;
}): Promise<GroupTypeChangeRequest> {
  const response = await apiService.post<{ success: boolean; data: GroupTypeChangeRequest }>(
    '/api/group-type-change-requests',
    params
  );
  return response.data;
}

export async function listRequests(params: {
  status?: string;
  groupId?: string;
}): Promise<GroupTypeChangeRequest[]> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.groupId) query.set('groupId', params.groupId);
  const qs = query.toString() ? `?${query.toString()}` : '';
  const response = await apiService.get<{ success: boolean; data: GroupTypeChangeRequest[] }>(
    `/api/group-type-change-requests${qs}`
  );
  return response.data;
}

export async function approve(requestId: string, notes?: string): Promise<GroupTypeChangeRequest> {
  const response = await apiService.post<{ success: boolean; data: GroupTypeChangeRequest }>(
    `/api/group-type-change-requests/${requestId}/approve`,
    { notes }
  );
  return response.data;
}

export interface InstantApproveResult {
  requestId: string;
  groupId: string;
  wizardUrl: string;
}

/**
 * TenantAdmin / SysAdmin shortcut: insert a pre-Approved type-change request
 * and skip the request-and-review flow. The actual GroupType flip still
 * happens in the conversion-wizard apply step.
 */
export async function instantApprove(params: {
  groupId: string;
  requestedType: GroupType;
}): Promise<InstantApproveResult> {
  const response = await apiService.post<{ success: boolean; data: InstantApproveResult }>(
    `/api/groups/${params.groupId}/type-change/instant-approve`,
    { requestedType: params.requestedType }
  );
  return response.data;
}

export async function deny(requestId: string, notes: string): Promise<GroupTypeChangeRequest> {
  const response = await apiService.post<{ success: boolean; data: GroupTypeChangeRequest }>(
    `/api/group-type-change-requests/${requestId}/deny`,
    { notes }
  );
  return response.data;
}
