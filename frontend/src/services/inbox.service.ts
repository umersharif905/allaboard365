// Back Office inbox API client.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

import { apiService } from './api.service';
import type { EmailThread, EmailThreadDetail, EmailAttachment, LinkSuggestions, MatchSuggestion, CustomerHistory, EmailThreadNote } from '../types/email.types';

export type HistoryScope = 'member' | 'address' | 'both';

interface ListResp {
  success: boolean;
  data: EmailThread[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
interface OneResp<T> { success: boolean; data: T; message?: string }
export interface PresenceEntry { userId: string; name: string | null }
export interface ThreadPresence { viewers: PresenceEntry[]; repliers: PresenceEntry[] }

export interface ThreadListParams {
  page?: number;
  limit?: number;
  needsReply?: boolean;
  unlinked?: boolean;
  members?: boolean;
  shareRequestId?: string;
  caseId?: string;
  memberId?: string;
  q?: string;
  owner?: 'mine' | 'unassigned' | 'all';
}

const BASE = '/api/me/vendor/inbox';

export const inboxService = {
  async listThreads(params: ThreadListParams, opts?: { signal?: AbortSignal }): Promise<ListResp> {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.needsReply) qs.set('needsReply', 'true');
    if (params.unlinked) qs.set('unlinked', 'true');
    if (params.members) qs.set('members', 'true');
    if (params.shareRequestId) qs.set('shareRequestId', params.shareRequestId);
    if (params.caseId) qs.set('caseId', params.caseId);
    if (params.memberId) qs.set('memberId', params.memberId);
    if (params.q) qs.set('q', params.q);
    if (params.owner && params.owner !== 'all') qs.set('owner', params.owner);
    return apiService.get<ListResp>(`${BASE}?${qs.toString()}`, opts);
  },

  async assignThread(threadId: string, ownerUserId: string | null): Promise<OneResp<EmailThreadDetail>> {
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}/assign`, { ownerUserId });
  },

  async getThread(threadId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<EmailThreadDetail>> {
    return apiService.get<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}`, opts);
  },

  async markRead(threadId: string): Promise<OneResp<EmailThreadDetail>> {
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}/read`, {});
  },

  async suggestLinks(threadId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<LinkSuggestions>> {
    return apiService.get<OneResp<LinkSuggestions>>(`${BASE}/${threadId}/suggest-links`, opts);
  },

  async matchSuggestion(threadId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<MatchSuggestion | null>> {
    return apiService.get<OneResp<MatchSuggestion | null>>(`${BASE}/${threadId}/match-suggestion`, opts);
  },

  async dismissSuggestion(threadId: string): Promise<OneResp<unknown>> {
    return apiService.post<OneResp<unknown>>(`${BASE}/${threadId}/dismiss-suggestion`, {});
  },

  async linkThread(threadId: string, body: { memberId?: string; caseId?: string; shareRequestId?: string }): Promise<OneResp<EmailThreadDetail>> {
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}/link`, body);
  },

  async unlinkThread(threadId: string): Promise<OneResp<EmailThreadDetail>> {
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}/unlink`, {});
  },

  async sendReply(threadId: string, body: { bodyHtml: string; replyAll?: boolean; files?: File[] }): Promise<OneResp<unknown>> {
    const fd = new FormData();
    fd.append('bodyHtml', body.bodyHtml);
    if (body.replyAll) fd.append('replyAll', 'true');
    (body.files || []).forEach((f) => fd.append('files', f));
    return apiService.post<OneResp<unknown>>(`${BASE}/${threadId}/reply`, fd);
  },

  async threadAttachments(threadId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<EmailAttachment[]>> {
    return apiService.get<OneResp<EmailAttachment[]>>(`${BASE}/${threadId}/attachments`, opts);
  },

  // Internal notes + "Handled" resolution
  async threadNotes(threadId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<EmailThreadNote[]>> {
    return apiService.get<OneResp<EmailThreadNote[]>>(`${BASE}/${threadId}/notes`, opts);
  },
  async addThreadNote(threadId: string, body: { note: string; mentionedUserIds?: string[] }): Promise<OneResp<EmailThreadNote>> {
    return apiService.post<OneResp<EmailThreadNote>>(`${BASE}/${threadId}/notes`, body);
  },
  async resolveThread(threadId: string, note?: string): Promise<OneResp<EmailThreadDetail>> {
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}/resolve`, note ? { note } : {});
  },
  async unresolveThread(threadId: string): Promise<OneResp<EmailThreadDetail>> {
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/${threadId}/unresolve`, {});
  },

  async sync(): Promise<OneResp<{ ingested: number }>> {
    return apiService.post<OneResp<{ ingested: number }>>(`${BASE}/sync`, {});
  },

  // Collision presence (viewing / replying)
  async presence(threadId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<ThreadPresence>> {
    return apiService.get<OneResp<ThreadPresence>>(`${BASE}/${threadId}/presence`, opts);
  },
  async heartbeatPresence(threadId: string, state: 'viewing' | 'replying'): Promise<OneResp<ThreadPresence>> {
    return apiService.post<OneResp<ThreadPresence>>(`${BASE}/${threadId}/presence`, { state });
  },
  async stopPresence(threadId: string): Promise<OneResp<unknown>> {
    return apiService.post<OneResp<unknown>>(`${BASE}/${threadId}/presence/stop`, {});
  },

  async compose(body: {
    to: string; toName?: string; subject: string; bodyHtml: string;
    memberId?: string; caseId?: string; shareRequestId?: string; files?: File[];
  }): Promise<OneResp<EmailThreadDetail>> {
    const fd = new FormData();
    fd.append('to', body.to);
    if (body.toName) fd.append('toName', body.toName);
    fd.append('subject', body.subject);
    fd.append('bodyHtml', body.bodyHtml);
    if (body.memberId) fd.append('memberId', body.memberId);
    if (body.caseId) fd.append('caseId', body.caseId);
    if (body.shareRequestId) fd.append('shareRequestId', body.shareRequestId);
    (body.files || []).forEach((f) => fd.append('files', f));
    return apiService.post<OneResp<EmailThreadDetail>>(`${BASE}/compose`, fd);
  },

  async customerHistory(
    params: { memberId?: string | null; address?: string | null; scope?: HistoryScope; caseId?: string | null; shareRequestId?: string | null },
    opts?: { signal?: AbortSignal }
  ): Promise<OneResp<CustomerHistory>> {
    const qs = new URLSearchParams();
    if (params.memberId) qs.set('memberId', params.memberId);
    if (params.address) qs.set('address', params.address);
    if (params.scope) qs.set('scope', params.scope);
    if (params.caseId) qs.set('caseId', params.caseId);
    if (params.shareRequestId) qs.set('shareRequestId', params.shareRequestId);
    return apiService.get<OneResp<CustomerHistory>>(`${BASE}/customer-history?${qs.toString()}`, opts);
  },

  async memberLinkOptions(memberId: string, opts?: { signal?: AbortSignal }): Promise<OneResp<{
    shareRequests: { ShareRequestId: string; RequestNumber: string; Status: string }[];
    cases: { CaseId: string; CaseNumber: string; Status: string }[];
  }>> {
    return apiService.get(`${BASE}/member-link-options?memberId=${encodeURIComponent(memberId)}`, opts);
  },
};
