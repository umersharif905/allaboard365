// frontend/src/services/caseForwarding.service.ts
import { apiService } from './api.service';

const BASE = '/api/me/vendor/case-forwarding';

interface ApiResponse<T> { success: boolean; data: T; message?: string }

export interface ForwardingTarget {
  TargetId: string;
  PlanVendorId: string;
  PlanVendorName?: string;
  Label: string;
  ForwardingEmails: string;
  TemplateId: string | null;
  TemplateName?: string | null;
  IsActive: boolean;
}

export interface PreviewDocument { DocumentId: string; DocumentName: string; FileName: string; MimeType?: string; FileSize?: number }
export interface PriorSend { RecipientAddress: string; Subject: string; SentDate: string; Status: string }
export interface ForwardingPreview {
  target: { targetId: string; label: string };
  recipients: string[];
  subject: string;
  body: string;
  documents: PreviewDocument[];
  priorSends: PriorSend[];
}

export const caseForwardingService = {
  listTargets: () => apiService.get<ApiResponse<ForwardingTarget[]>>(`${BASE}/targets`),
  createTarget: (body: { planVendorId: string; label: string; forwardingEmails: string; templateId?: string | null }) =>
    apiService.post<ApiResponse<ForwardingTarget>>(`${BASE}/targets`, body),
  updateTarget: (id: string, body: { label: string; forwardingEmails: string; templateId?: string | null; isActive: boolean }) =>
    apiService.put<ApiResponse<ForwardingTarget>>(`${BASE}/targets/${id}`, body),
  deleteTarget: (id: string) => apiService.delete<ApiResponse<null>>(`${BASE}/targets/${id}`),
  createStarterTemplate: (variant: 'arm' | 'tallTree') =>
    apiService.post<ApiResponse<{ TemplateId: string; TemplateName: string }>>(`${BASE}/starter-template`, { variant }),
  getPreview: (caseId: string) => apiService.get<ApiResponse<ForwardingPreview>>(`${BASE}/cases/${caseId}/preview`),
  send: (caseId: string, body: { to: string[]; subject: string; body: string; documentIds: string[] }) =>
    apiService.post<ApiResponse<{ messageId: string; recipients: string[] }>>(`${BASE}/cases/${caseId}/send`, body),
};
