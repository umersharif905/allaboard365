// frontend/src/services/prospect.service.ts
// Typed client for the Prospects CRM API. Visibility (agent/agency/self) is resolved
// server-side from the role + scope/agentId/agencyId query params, so a single
// endpoint serves every role.

import { apiService } from './api.service';

export type ProspectStatus = 'New' | 'Contacted' | 'Proposal Sent' | 'Closed' | 'Lost';

export const PROSPECT_STATUSES: ProspectStatus[] = [
  'New',
  'Contacted',
  'Proposal Sent',
  'Closed',
  'Lost',
];

/** Known lead sources for the Source column/filter. The list is open-ended
 *  server-side, but these are the values we surface in the UI. */
export const PROSPECT_SOURCES: string[] = [
  'MightyWELL Website',
  'Manual',
  'ApiIngest',
  'Proposal',
  'Quote',
];

export interface ProspectTag {
  ProspectTagId: string;
  Name: string;
  Color: string;
}

export interface ProspectTagFull extends ProspectTag {
  AgencyId: string | null;
  CreatedDate: string;
}

export interface GroupProspectSummary {
  GroupProspectId: string;
  CompanyName: string;
  ContactEmail: string | null;
  TotalEmployees: number | null;
  Status: string;
}

export interface Prospect {
  ProspectId: string;
  TenantId: string;
  AgentId: string | null;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  Phone: string | null;
  Status: ProspectStatus;
  ReferralName: string | null;
  PremiumAmount: number | null;
  Source: string;
  /** Pastel color key of the named source this prospect came from (if any). */
  SourceColor?: string | null;
  SuggestedMemberId: string | null;
  MemberId: string | null;
  ClosedDate: string | null;
  CreatedDate: string;
  ModifiedDate: string;
  Notes?: string | null;
  AgentFirstName?: string | null;
  AgentLastName?: string | null;
  // New fields from Phase 2
  Tags?: ProspectTag[];
  GroupProspectId?: string | null;
  NextFollowUpDate?: string | null;
  LastContactedDate?: string | null;
}

export interface ProspectProduct {
  ProspectProductId: string;
  ProductId: string;
  ProductName: string | null;
  PremiumAmount: number | null;
  Source: string;
  CreatedDate: string;
}

export interface ProspectMemberSummary {
  MemberId: string;
  Status: string;
  FirstName: string | null;
  LastName: string | null;
  Email: string | null;
  PhoneNumber: string | null;
}

export interface ProspectDetail {
  prospect: Prospect;
  products: ProspectProduct[];
  member: ProspectMemberSummary | null;
  tags?: ProspectTag[];
  group?: GroupProspectSummary | null;
}

export type FollowUpFilter = 'overdue' | 'upcoming' | 'any';
export type SortByField = 'createdDate' | 'name' | 'status' | 'premium' | 'followUp' | 'lastContacted' | 'source';
export type SortDir = 'asc' | 'desc';

export interface ProspectListParams {
  /** Specific owning agent GUID. Do NOT pass scope sentinels here. */
  agentId?: string;
  /** Visibility scope when no specific agent is chosen. */
  scope?: 'self' | 'downline' | 'agency' | 'direct';
  /** TenantAdmin/SysAdmin: narrow to one agency. */
  agencyId?: string;
  status?: ProspectStatus;
  /** Lead source filter (e.g. 'MightyWELL Website', 'Manual', 'ApiIngest'). */
  source?: string;
  /** Filter by a specific ProspectSource record (UUID). */
  sourceId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  // Phase 2 params
  sortBy?: SortByField;
  sortDir?: SortDir;
  tags?: string;  // comma-separated tagId list
  followUp?: FollowUpFilter;
}

export interface ProspectListResult {
  prospects: Prospect[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateProspectInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  referralName?: string;
  premiumAmount?: number | null;
  notes?: string;
  products?: Array<{ productId: string; premiumAmount?: number | null }>;
  /** TenantAdmin/SysAdmin: assign to a specific agent. */
  agentId?: string;
}

export type UpdateProspectInput = Partial<{
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  status: ProspectStatus;
  referralName: string | null;
  premiumAmount: number | null;
  notes: string | null;
  nextFollowUpDate: string | null;
}>;

export interface ProspectCommunication {
  historyId?: string;
  messageId: string;
  recipientAddress: string;
  messageType: 'Email' | 'SMS';
  subject: string | null;
  status: string;
  sentDate: string;
  source: 'Sent' | 'Queued';
}

export interface ProspectProposal {
  kind: 'Proposal';
  id: string;
  name: string | null;
  sendMethod: string | null;
  pdfUrl: string | null;
  sentDate: string;
  documentName: string | null;
}

export interface ProspectQuote {
  kind: 'Quote';
  id: string;
  name: string | null;
  status: string;
  premium: number | null;
  sentDate: string;
}

export interface ProspectProposalsResult {
  proposals: ProspectProposal[];
  quotes: ProspectQuote[];
}

export interface CreateQuoteInput {
  prospectId?: string;
  prospectName?: string;
  prospectEmail?: string;
  prospectPhone?: string;
  status?: string;
  notes?: string;
  lineItems: Array<{ productId?: string; productName?: string; premium?: number; tier?: string }>;
}

export interface AgentApiKey {
  ApiKeyId: string;
  KeyName: string;
  PartialKey: string;
  Status: string;
  Scope: string | null;
  CreatedDate: string;
  LastUsedDate: string | null;
}

export interface CreatedApiKey {
  apiKeyId: string;
  name: string;
  partialKey: string;
  key: string; // full secret — shown once
  scope: string;
}

// --- Insights / stats ---
export interface ProspectStatsParams {
  agentId?: string;
  scope?: 'self' | 'downline' | 'agency' | 'direct';
  agencyId?: string;
  /** ISO date (yyyy-MM-dd). Defaults server-side to trailing 12 months. */
  from?: string;
  to?: string;
  /** Filter stats to a specific ProspectSource record (UUID). */
  sourceId?: string;
  /** Filter stats by built-in/free-text source value (e.g. 'Proposal', 'Quote'). */
  source?: string;
}

// --- Prospect Sources ---
export type SourceType = 'website' | 'landing' | 'api';

export interface ProspectSource {
  sourceId: string;
  name: string;
  tag: string | null;
  type: SourceType;
  color: string | null;
  destinationUrl: string | null;
  linkCode: string | null;
  link: string | null;
  apiPartialKey: string | null;
  leadCount: number;
  /** Leads from this source that reached enrollment (prospect Status = 'Closed'). */
  enrolledCount: number;
  isDefault?: boolean;
  createdDate: string;
}

export interface CreateSourceResult {
  sourceId: string;
  name: string;
  tag: string | null;
  type: SourceType;
  link: string | null;
  linkCode: string | null;
  apiKey: string | null;
}

export interface ProspectSourceMonthBucket {
  month: string; // 'yyyy-MM'
  source: string;
  count: number;
}

export interface ProspectSourceBucket {
  source: string;
  count: number;
  /** Leads from this source that reached enrollment (Status = 'Closed'). */
  enrolled: number;
}

export interface ProspectStatusBucket {
  status: string;
  count: number;
}

export interface ProspectStatsTotals {
  total: number;
  newThisMonth: number;
  sources: number;
  /** Leads in scope that reached enrollment (Status = 'Closed'). */
  enrolled: number;
}

export interface ProspectStats {
  bySourceMonth: ProspectSourceMonthBucket[];
  bySource: ProspectSourceBucket[];
  byStatus: ProspectStatusBucket[];
  totals: ProspectStatsTotals;
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
}

const BASE = '/api/prospects';

export const ProspectService = {
  async list(params: ProspectListParams): Promise<ProspectListResult> {
    const q = new URLSearchParams();
    if (params.agentId) q.set('agentId', params.agentId);
    if (params.scope) q.set('scope', params.scope);
    if (params.agencyId) q.set('agencyId', params.agencyId);
    if (params.status) q.set('status', params.status);
    if (params.source) q.set('source', params.source);
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    if (params.sortBy) q.set('sortBy', params.sortBy);
    if (params.sortDir) q.set('sortDir', params.sortDir);
    if (params.tags) q.set('tags', params.tags);
    if (params.followUp) q.set('followUp', params.followUp);
    if (params.sourceId) q.set('sourceId', params.sourceId);
    const query = q.toString() ? `?${q.toString()}` : '';
    const res = await apiService.get<ApiResponse<ProspectListResult>>(`${BASE}${query}`);
    return res.data ?? { prospects: [], total: 0, page: 1, pageSize: 25 };
  },

  async getStats(params: ProspectStatsParams = {}): Promise<ProspectStats> {
    const q = new URLSearchParams();
    if (params.agentId) q.set('agentId', params.agentId);
    if (params.scope) q.set('scope', params.scope);
    if (params.agencyId) q.set('agencyId', params.agencyId);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    if (params.sourceId) q.set('sourceId', params.sourceId);
    if (params.source) q.set('source', params.source);
    const query = q.toString() ? `?${q.toString()}` : '';
    const res = await apiService.get<ApiResponse<ProspectStats>>(`${BASE}/stats${query}`);
    return (
      res.data ?? {
        bySourceMonth: [],
        bySource: [],
        byStatus: [],
        totals: { total: 0, newThisMonth: 0, sources: 0, enrolled: 0 },
      }
    );
  },

  async downloadReport(params: ProspectListParams): Promise<void> {
    const q = new URLSearchParams();
    if (params.agentId) q.set('agentId', params.agentId);
    if (params.scope) q.set('scope', params.scope);
    if (params.agencyId) q.set('agencyId', params.agencyId);
    if (params.status) q.set('status', params.status);
    if (params.source) q.set('source', params.source);
    if (params.search) q.set('search', params.search);
    if (params.sortBy) q.set('sortBy', params.sortBy);
    if (params.sortDir) q.set('sortDir', params.sortDir);
    if (params.tags) q.set('tags', params.tags);
    if (params.followUp) q.set('followUp', params.followUp);
    const query = q.toString() ? `?${q.toString()}` : '';
    const today = new Date().toISOString().slice(0, 10);
    await apiService.downloadFile(`${BASE}/report${query}`, `prospects-report-${today}.csv`);
  },

  async get(prospectId: string): Promise<ProspectDetail | null> {
    const res = await apiService.get<ApiResponse<ProspectDetail>>(`${BASE}/${prospectId}`);
    return res.data ?? null;
  },

  async create(input: CreateProspectInput): Promise<{ prospect: Prospect; created: boolean }> {
    const res = await apiService.post<ApiResponse<{ prospect: Prospect; created: boolean }>>(BASE, input);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to create prospect');
    return res.data;
  },

  async update(prospectId: string, input: UpdateProspectInput): Promise<ProspectDetail> {
    const res = await apiService.put<ApiResponse<ProspectDetail>>(`${BASE}/${prospectId}`, input);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to update prospect');
    return res.data;
  },

  async confirmMemberLink(prospectId: string, memberId?: string): Promise<ProspectDetail> {
    const res = await apiService.post<ApiResponse<ProspectDetail>>(
      `${BASE}/${prospectId}/confirm-member-link`,
      memberId ? { memberId } : {}
    );
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to link member');
    return res.data;
  },

  async remove(prospectId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<never>>(`${BASE}/${prospectId}`);
    if (!res.success) throw new Error(res.message || 'Failed to delete prospect');
  },

  async communications(prospectId: string): Promise<ProspectCommunication[]> {
    const res = await apiService.get<ApiResponse<ProspectCommunication[]>>(`${BASE}/${prospectId}/communications`);
    return res.data ?? [];
  },

  async sendCommunication(
    prospectId: string,
    input: { channel: 'email' | 'sms'; subject?: string; body: string }
  ): Promise<{ messageId: string }> {
    const res = await apiService.post<ApiResponse<{ messageId: string }>>(
      `${BASE}/${prospectId}/communications`,
      input
    );
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to send message');
    return res.data;
  },

  async proposals(prospectId: string): Promise<ProspectProposalsResult> {
    const res = await apiService.get<ApiResponse<ProspectProposalsResult>>(`${BASE}/${prospectId}/proposals`);
    return res.data ?? { proposals: [], quotes: [] };
  },

  async createQuote(input: CreateQuoteInput): Promise<{ quoteId: string; prospectId: string }> {
    const res = await apiService.post<ApiResponse<{ quoteId: string; prospectId: string }>>('/api/quotes', input);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to create quote');
    return res.data;
  },

  // --- Agent lead-ingest API keys ---
  async listApiKeys(): Promise<AgentApiKey[]> {
    const res = await apiService.get<ApiResponse<AgentApiKey[]>>('/api/agent-api-keys');
    return res.data ?? [];
  },

  async createApiKey(name?: string): Promise<CreatedApiKey> {
    const res = await apiService.post<ApiResponse<CreatedApiKey>>('/api/agent-api-keys', name ? { name } : {});
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to create API key');
    return res.data;
  },

  async revokeApiKey(apiKeyId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<never>>(`/api/agent-api-keys/${apiKeyId}`);
    if (!res.success) throw new Error(res.message || 'Failed to revoke API key');
  },

  // --- Prospect Tags ---
  async listTags(): Promise<ProspectTagFull[]> {
    const res = await apiService.get<ApiResponse<ProspectTagFull[]>>('/api/prospect-tags');
    return res.data ?? [];
  },

  async createTag(input: { name: string; color: string }): Promise<ProspectTagFull> {
    const res = await apiService.post<ApiResponse<ProspectTagFull>>('/api/prospect-tags', input);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to create tag');
    return res.data;
  },

  async deleteTag(tagId: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<never>>(`/api/prospect-tags/${tagId}`);
    if (!res.success) throw new Error(res.message || 'Failed to delete tag');
  },

  async assignTag(prospectId: string, tagId: string): Promise<ProspectDetail> {
    const res = await apiService.post<ApiResponse<ProspectDetail>>(`${BASE}/${prospectId}/tags`, { tagId });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to assign tag');
    return res.data;
  },

  async removeTag(prospectId: string, tagId: string): Promise<ProspectDetail> {
    const res = await apiService.delete<ApiResponse<ProspectDetail>>(`${BASE}/${prospectId}/tags/${tagId}`);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to remove tag');
    return res.data;
  },

  // --- Reassign owning agent ---
  async reassign(prospectId: string, agentId: string): Promise<ProspectDetail> {
    const res = await apiService.post<ApiResponse<ProspectDetail>>(`${BASE}/${prospectId}/reassign`, { agentId });
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to reassign prospect');
    return res.data;
  },

  // --- Prospect Sources ---
  async listSources(): Promise<ProspectSource[]> {
    const res = await apiService.get<ApiResponse<ProspectSource[]>>('/api/prospect-sources');
    return res.data ?? [];
  },

  async createSource(body: {
    name: string;
    tag?: string;
    type: SourceType;
    color?: string;
    destinationLabel?: string;
  }): Promise<CreateSourceResult> {
    const res = await apiService.post<ApiResponse<CreateSourceResult>>('/api/prospect-sources', body);
    if (!res.success || !res.data) throw new Error(res.message || 'Failed to create source');
    return res.data;
  },

  async updateSource(id: string, body: { name: string; tag?: string; color?: string }): Promise<void> {
    const res = await apiService.patch<ApiResponse<never>>(`/api/prospect-sources/${id}`, body);
    if (!res.success) throw new Error(res.message || 'Failed to update source');
  },

  async archiveSource(id: string): Promise<void> {
    const res = await apiService.delete<ApiResponse<never>>(`/api/prospect-sources/${id}`);
    if (!res.success) throw new Error(res.message || 'Failed to archive source');
  },
};

// --- Standalone source functions (for direct import in hooks/components) ---
export async function listProspectSources(): Promise<ProspectSource[]> {
  return ProspectService.listSources();
}

export async function createProspectSource(body: {
  name: string;
  tag?: string;
  type: SourceType;
  color?: string;
  destinationLabel?: string;
}): Promise<CreateSourceResult> {
  return ProspectService.createSource(body);
}

export async function updateProspectSource(
  id: string,
  body: { name: string; tag?: string; color?: string }
): Promise<void> {
  return ProspectService.updateSource(id, body);
}

export async function archiveProspectSource(id: string): Promise<void> {
  return ProspectService.archiveSource(id);
}

export default ProspectService;
