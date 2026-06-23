// frontend/src/services/vendorCallCenter.service.ts
// Typed client for the vendor Call Center API (/api/me/vendor/call-center) plus
// the Zoom phone-config endpoints used by the dedicated settings page.

import { apiService } from './api.service';

const BASE = '/api/me/vendor/call-center';
const CONFIG_BASE = '/api/me/vendor/profile/phone-config';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface CallCenterConfig {
  provider: string | null;
  enabled: boolean;
  configured: boolean;
  autoMatchEnabled: boolean;
  recordingsEnabled: boolean;
  popupEnabled: boolean;
  webhookUrl: string | null;
  isAdmin: boolean;
}

export interface ActiveCall {
  ActiveCallId: string;
  CallType: string;
  CallStatus: string;
  CallerNumber: string | null;
  CallerName: string | null;
  CalleeNumber: string | null;
  CalleeName: string | null;
  CallStartTime: string;
  ExternalCallId: string | null;
  AgentUserId: string | null;
  AgentName: string | null;
  AgentExtension: string | null;
  MemberId: string | null;
  MemberFirstName: string | null;
  MemberLastName: string | null;
  MemberEmail: string | null;
  MemberPhone: string | null;
  HouseholdId: string | null;
  OpenCaseCount: number;
  OpenShareRequestCount: number;
}

export interface CallListItem {
  CallLogId: string;
  CallType: string;
  CallStatus: string;
  CallerNumber: string | null;
  CallerName: string | null;
  CalleeNumber: string | null;
  CalleeName: string | null;
  CallStartTime: string | null;
  CallEndTime: string | null;
  CallDurationSeconds: number | null;
  MemberId: string | null;
  ShareRequestId: string | null;
  MatchedBy: string | null;
  AgentUserId: string | null;
  AgentExtension: string | null;
  AnsweredBy: 'User' | 'AutoReceptionist' | 'CallQueue' | 'CommonArea' | 'SharedLineGroup' | null;
  HasRecording: boolean;
  RecordingUrl: string | null;
  CallNotes: string | null;
  AISummary: string | null;
  AISummaryStatus: string | null;
  TranscriptStatus: string | null;
  HasTranscript: boolean;
  Source: string;
  CreatedDate: string;
  MemberFirstName: string | null;
  MemberLastName: string | null;
  AgentFirstName: string | null;
  AgentLastName: string | null;
  RequestNumber: string | null;
}

export interface CallDetail extends CallListItem {
  TranscriptText: string | null;
  TranscriptSource: string | null;
  AISummaryGeneratedAt: string | null;
  AISummaryModel: string | null;
  MemberEmail: string | null;
  MemberPhone: string | null;
  EncounterId: string | null;
  EncounterNumber: string | null;
  EncounterCaseId: string | null;
  EncounterShareRequestId: string | null;
}

export interface CallListResult {
  total: number;
  limit: number;
  offset: number;
  calls: CallListItem[];
}

export interface OpenCase {
  CaseId: string;
  CaseNumber: string;
  Title: string | null;
  Status: string;
  ClaimedByUserId: string | null;
  ClaimedByFirst: string | null;
  ClaimedByLast: string | null;
  CreatedDate: string;
}

export interface OpenShareRequest {
  ShareRequestId: string;
  RequestNumber: string;
  Status: string;
  TotalBilledAmount: number | null;
  Balance: number | null;
  SubmittedDate: string | null;
  CreatedDate: string;
  RequestTypeName: string | null;
}

export interface MemberContext {
  member: {
    MemberId: string;
    HouseholdId: string | null;
    DateOfBirth: string | null;
    FirstName: string;
    LastName: string;
    Email: string | null;
    Phone: string | null;
  };
  openCases: OpenCase[];
  openShareRequests: OpenShareRequest[];
}

export interface CallStats {
  TotalCalls: number;
  Inbound: number;
  Outbound: number;
  Missed: number;
  Voicemail: number;
  MatchedToMember: number;
  WithRecording: number;
  WithTranscript: number;
  WithSummary: number;
  TotalDurationSeconds: number;
  AvgDurationSeconds: number;
  UniqueMembers: number;
  scope: 'mine' | 'all';
}

export interface AgentReportRow {
  AgentUserId: string | null;
  AgentFirstName: string | null;
  AgentLastName: string | null;
  TotalCalls: number;
  Inbound: number;
  Outbound: number;
  Missed: number;
  TotalDurationSeconds: number;
  AvgDurationSeconds: number;
  UniqueMembers: number;
}

export interface ZoomUserMapping {
  zoomUserId: string;
  zoomEmail: string | null;
  zoomDisplayName: string;
  zoomExtension: string | null;
  mappedUserId: string | null;
  suggestedUserId: string | null;
}

export interface VendorUserOption {
  UserId: string;
  FirstName: string;
  LastName: string;
  Email: string | null;
}

export interface AgentMapData {
  zoomUsers: ZoomUserMapping[];
  vendorUsers: VendorUserOption[];
  currentMap: Array<Record<string, unknown>>;
  zoomError: string | null;
}

export interface PhoneConfig {
  phoneProvider: string;
  phoneProviderEnabled: boolean;
  zoomAccountId: string;
  zoomClientId: string;
  hasZoomClientSecret: boolean;
  zoomWebhookSecretToken: string;
  zoomWebhookUrl: string;
  phoneAutoMatchEnabled: boolean;
  phonePopupEnabled: boolean;
  phoneRecordingsEnabled: boolean;
}

export interface CallListFilters {
  scope?: 'mine' | 'all';
  direction?: string;
  search?: string;
  matched?: boolean;
  hasRecording?: boolean;
  hasTranscript?: boolean;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

function buildQuery(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') sp.append(k, String(v));
  });
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const vendorCallCenterService = {
  async getConfig(): Promise<CallCenterConfig> {
    const r = await apiService.get<ApiResponse<CallCenterConfig>>(`${BASE}/config`);
    return r.data;
  },

  async getLiveCalls(): Promise<ActiveCall[]> {
    const r = await apiService.get<ApiResponse<ActiveCall[]>>(`${BASE}/live`);
    return r.data;
  },

  async getMemberContext(memberId: string): Promise<MemberContext> {
    const r = await apiService.get<ApiResponse<MemberContext>>(`${BASE}/members/${memberId}/context`);
    return r.data;
  },

  async lookupByPhone(phone: string): Promise<MemberContext['member'][]> {
    const r = await apiService.get<ApiResponse<MemberContext['member'][]>>(`${BASE}/lookup${buildQuery({ phone })}`);
    return r.data;
  },

  async getCalls(filters: CallListFilters = {}): Promise<CallListResult> {
    const r = await apiService.get<ApiResponse<CallListResult>>(`${BASE}/calls${buildQuery(filters as Record<string, unknown>)}`);
    return r.data;
  },

  async getCall(callLogId: string): Promise<CallDetail> {
    const r = await apiService.get<ApiResponse<CallDetail>>(`${BASE}/calls/${callLogId}`);
    return r.data;
  },

  async updateCall(callLogId: string, updates: { callNotes?: string; shareRequestId?: string; memberId?: string }): Promise<CallDetail> {
    const r = await apiService.put<ApiResponse<CallDetail>>(`${BASE}/calls/${callLogId}`, updates);
    return r.data;
  },

  async generateSummary(callLogId: string, force = false): Promise<{ summarized: boolean; summary?: string; reason?: string }> {
    const r = await apiService.post<ApiResponse<{ summarized: boolean; summary?: string; reason?: string }>>(
      `${BASE}/calls/${callLogId}/summary`,
      { force }
    );
    return r.data;
  },

  recordingUrl(callLogId: string): string {
    return `${BASE}/calls/${callLogId}/recording`;
  },

  // Recordings are auth-gated and proxied through the API, so fetch them as an
  // authenticated blob and let the caller create an object URL for <audio>.
  async getRecordingBlob(callLogId: string): Promise<Blob> {
    return apiService.get<Blob>(`${BASE}/calls/${callLogId}/recording`, { responseType: 'blob' });
  },

  async getStats(scope: 'mine' | 'all', fromDate?: string, toDate?: string): Promise<CallStats> {
    const r = await apiService.get<ApiResponse<CallStats>>(`${BASE}/stats${buildQuery({ scope, fromDate, toDate })}`);
    return r.data;
  },

  async getAgentReport(fromDate?: string, toDate?: string): Promise<AgentReportRow[]> {
    const r = await apiService.get<ApiResponse<AgentReportRow[]>>(`${BASE}/reports/agents${buildQuery({ fromDate, toDate })}`);
    return r.data;
  },

  async sync(fromDate?: string, toDate?: string): Promise<void> {
    await apiService.post<ApiResponse<unknown>>(`${BASE}/sync`, { fromDate, toDate });
  },

  // Settings (admin)
  async getAgentMap(): Promise<AgentMapData> {
    const r = await apiService.get<ApiResponse<AgentMapData>>(`${BASE}/agent-map`);
    return r.data;
  },

  async saveAgentMap(entries: Array<{ zoomUserId: string; zoomEmail?: string | null; zoomExtension?: string | null; zoomDisplayName?: string | null; userId?: string | null }>): Promise<void> {
    await apiService.put<ApiResponse<unknown>>(`${BASE}/agent-map`, { entries });
  },

  async getPhoneConfig(): Promise<PhoneConfig> {
    const r = await apiService.get<ApiResponse<PhoneConfig>>(CONFIG_BASE);
    return r.data;
  },

  async savePhoneConfig(config: Partial<PhoneConfig> & { zoomClientSecret?: string }): Promise<void> {
    await apiService.put<ApiResponse<unknown>>(CONFIG_BASE, config);
  },

  async testConnection(): Promise<{ success: boolean; message?: string }> {
    return apiService.post<{ success: boolean; message?: string }>(`${CONFIG_BASE}/test`, {});
  },
};

export async function getMemberShareRequests(memberId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await apiService.get<any>(`/api/me/vendor/share-requests`, { params: { memberId, limit: 20 } });
  return (r?.data || r?.shareRequests || []) as Array<{ ShareRequestId: string; RequestNumber: string; Status: string }>;
}

export async function getMemberCases(memberId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await apiService.get<any>(`/api/me/vendor/cases`, { params: { memberId, limit: 20 } });
  return (r?.data || r?.cases || []) as Array<{ CaseId: string; CaseNumber: string; Status: string; Title: string }>;
}

export async function searchAllShareRequests(q: string) {
  if (!q || q.length < 2) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await apiService.get<any>(`/api/me/vendor/share-requests/search`, { params: { q } });
  const data = r?.data ?? r ?? [];
  return (Array.isArray(data) ? data : (data?.shareRequests || data?.data || [])) as Array<{
    ShareRequestId: string;
    RequestNumber: string;
    Status: string;
    MemberFirstName?: string | null;
    MemberLastName?: string | null;
  }>;
}

export async function searchAllCases(q: string) {
  if (!q || q.length < 2) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await apiService.get<any>(`/api/me/vendor/cases`, { params: { search: q, limit: 20 } });
  const data = r?.data ?? r ?? [];
  return (Array.isArray(data) ? data : (data?.cases || data?.data || [])) as Array<{
    CaseId: string;
    CaseNumber: string;
    Title: string | null;
    Status: string;
  }>;
}

export async function attachEncounterToCase(encounterId: string, caseId: string | null) {
  return apiService.patch<ApiResponse<unknown>>(`/api/me/vendor/encounters/${encounterId}`, { caseId });
}

export async function attachEncounterToShareRequest(encounterId: string, shareRequestId: string | null) {
  return apiService.patch<ApiResponse<unknown>>(`/api/me/vendor/encounters/${encounterId}`, { shareRequestId });
}

export async function updateEncounterNotes(encounterId: string, notes: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await apiService.patch<ApiResponse<any>>(`/api/me/vendor/encounters/${encounterId}`, { notes });
  return r?.data ?? r;
}

export default vendorCallCenterService;
