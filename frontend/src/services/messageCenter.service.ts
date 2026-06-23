// File: frontend/src/services/messageCenter.service.ts
// Path: frontend/src/services/messageCenter.service.ts

import { API_CONFIG } from '../config/api';
import { apiService } from './api.service';

// Types
export interface MessageTemplate {
  templateId: string;
  tenantId: string;
  /** Owner vendor. null/undefined = tenant-owned; non-null = vendor-owned. */
  vendorId?: string | null;
  templateName: string;
  messageType: 'Email' | 'SMS';
  /** Marketing = footer + unsubscribe; System = transactional (no marketing compliance extras). */
  messageCategory?: 'Marketing' | 'System';
  category?: string;
  subject?: string;
  body: string;
  replyTo?: string;
  variables?: string[];
  isActive: boolean;
  createdDate: string;
  createdBy: string;
  modifiedDate?: string;
  modifiedBy?: string;
}

export interface ScheduledMessage {
  scheduleId: string;
  tenantId: string;
  scheduleName: string;
  templateId: string;
  templateName?: string;
  messageType: 'Email' | 'SMS';
  recurrencePattern: 'Daily' | 'Weekly' | 'Monthly' | 'FirstOfMonth' | 'Annual';
  recurrenceTime?: string;
  lastRunDate?: string;
  nextRunDate?: string;
  isActive: boolean;
  createdDate: string;
  createdBy: string;
}

export interface MessageQueueItem {
  messageId: string;
  tenantId: string;
  recipientId: string;
  recipientAddress: string;
  messageType: 'Email' | 'SMS';
  subject?: string;
  body: string;
  status: 'Pending' | 'Processing' | 'Sent' | 'Failed';
  retryCount: number;
  errorMessage?: string;
  createdDate: string;
  processedDate?: string;
  batchId?: string | null;
}

/** One logical send (e.g. tenant message blast) with aggregate progress */
export interface MessageSendBatchRow {
  batchId: string;
  tenantId: string;
  tenantName?: string;
  label?: string | null;
  smsTotal: number;
  emailTotal: number;
  createdDate: string;
  smsPending: number;
  smsQueueFailed: number;
  smsSent: number;
  smsHistoryFailed: number;
  emailPending: number;
  emailQueueFailed: number;
  emailSent: number;
  emailHistoryFailed: number;
}

export interface MessageHistory {
  historyId: string;
  messageId: string;
  tenantId: string;
  recipientId: string;
  /** Display name when returned by list/history APIs */
  recipientName?: string;
  recipientAddress: string;
  messageType: 'Email' | 'SMS';
  subject?: string;
  status: 'Sent' | 'Sending' | 'Delivered' | 'Failed' | 'Bounced' | 'Opened' | 'Clicked';
  providerMessageId?: string;
  errorMessage?: string;
  sentDate: string;
  templateName?: string;
  scheduleName?: string;
  batchId?: string | null;
}

export interface Campaign {
  campaignId: string;
  tenantId: string;
  /** Owner vendor. null/undefined = tenant-owned; non-null = vendor-owned. */
  vendorId?: string | null;
  campaignName: string;
  triggerType: 'EnrollmentCompletion' | 'FirstDayOfCoverage' | 'DependentAdded' | 'PlanTermination';
  /** Who receives the campaign messages. 'Member' (default) = the enrolling member;
   *  'Agent' = the member's assigned agent (e.g. notify the agent of a new enrollment). */
  recipientType: 'Member' | 'Agent';
  isActive: boolean;
  stepCount?: number;
  activeEnrollments?: number;
  steps?: CampaignStep[];
  createdDate: string;
  createdBy?: string;
  modifiedDate?: string;
  modifiedBy?: string;
}

export interface CampaignStep {
  stepId: string;
  campaignId: string;
  stepOrder: number;
  delayDays: number;
  emailTemplateId: string | null;
  smsTemplateId: string | null;
  emailTemplateName?: string;
  smsTemplateName?: string;
  isActive: boolean;
  createdDate?: string;
  modifiedDate?: string;
}

export interface CampaignEnrollment {
  campaignEnrollmentId: string;
  memberId: string;
  triggerDate: string;
  currentStepOrder: number;
  status: 'Active' | 'Completed' | 'Cancelled';
  createdDate: string;
  completedDate?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}


export interface MessageAnalytics {
  totalSent: number;
  totalFailed: number;
  totalBounced: number;
  openRate: number;
  clickRate: number;
  byType: {
    email: number;
    sms: number;
  };
  byStatus: Record<string, number>;
  dailyStats: Array<{
    date: string;
    sent: number;
    failed: number;
    opened: number;
  }>;
}

// API Response types
interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
}


// Base API request function
const apiRequest = async <T>(
  endpoint: string,
  options?: { method?: string; body?: string }
): Promise<ApiResponse<T>> => {
  try {
    if (options?.method === 'POST') {
      return await apiService.post<ApiResponse<T>>(endpoint, options.body ? JSON.parse(options.body) : undefined);
    } else if (options?.method === 'PUT') {
      return await apiService.put<ApiResponse<T>>(endpoint, options.body ? JSON.parse(options.body) : undefined);
    } else if (options?.method === 'DELETE') {
      return await apiService.delete<ApiResponse<T>>(endpoint);
    } else {
      return await apiService.get<ApiResponse<T>>(endpoint);
    }
  } catch (error: any) {
    throw new Error(error.message || 'Request failed');
  }
};

// Welcome email template (per-tenant; default = global fallback)
export interface WelcomeEmailTemplateData {
  welcomeEmailTemplateId: string | null;
  defaultWelcomeTemplateId?: string | null; // SysAdmin: global default when tenant has no override
  templateName?: string;
  subject?: string;
}

// Template Management
export const messageTemplateService = {
  // Get effective welcome email template for a tenant (tenant-specific or default).
  // tenantId: optional context tenant (SysAdmin); omit to use current context from header.
  async getWelcomeEmailTemplate(tenantId?: string | null): Promise<ApiResponse<WelcomeEmailTemplateData>> {
    const url = tenantId != null && tenantId !== ''
      ? `/api/message-center/welcome-email-template?currentTenantId=${encodeURIComponent(tenantId)}`
      : '/api/message-center/welcome-email-template';
    return apiRequest(url);
  },

  // Set or clear the welcome email template. tenantId: which tenant (SysAdmin only); null = set global default (All Tenants template).
  async setWelcomeEmailTemplate(templateId: string | null, tenantId?: string | null): Promise<ApiResponse<WelcomeEmailTemplateData>> {
    const body: { templateId: string | null; tenantId?: string | null } = { templateId };
    // Always send tenantId when provided (including null) so backend can set global default
    if (tenantId !== undefined) {
      body.tenantId = tenantId;
    }
    return apiRequest('/api/message-center/welcome-email-template', {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  },

  // Get all templates with pagination and filters
  async getTemplates(params?: {
    page?: number;
    limit?: number;
    search?: string;
    category?: string;
    templateType?: string;
    isActive?: boolean;
    tenantId?: string;
    /** SysAdmin: only global templates (TenantId null) — legacy; superseded by `scope` */
    globalOnly?: boolean;
    /** SysAdmin: 'tenant' = VendorId IS NULL, 'vendor' = VendorId IS NOT NULL. Omit for all. */
    scope?: 'tenant' | 'vendor';
  }): Promise<ApiResponse<PaginatedResponse<MessageTemplate>>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) queryParams.append(key, value.toString());
      });
    }
    
    return apiRequest(`/api/message-center/templates?${queryParams}`);
  },

  // Get single template
  async getTemplate(templateId: string): Promise<ApiResponse<MessageTemplate>> {
    return apiRequest(`/api/message-center/templates/${templateId}`);
  },

  // Create new template
  // SysAdmin may pass `createForTenantId` (required) and optional `createForVendorId`
  // to explicitly own the new template. TenantAdmin/VendorAdmin paths ignore these
  // (backend forces scope from the caller's identity).
  async createTemplate(
    template: Omit<MessageTemplate, 'templateId' | 'createdDate' | 'createdBy'> & {
      createForTenantId?: string | null;
      createForVendorId?: string | null;
    }
  ): Promise<ApiResponse<MessageTemplate>> {
    return apiRequest('/api/message-center/templates', {
      method: 'POST',
      body: JSON.stringify(template),
    });
  },

  // Update template
  async updateTemplate(templateId: string, updates: Partial<MessageTemplate>): Promise<ApiResponse<MessageTemplate>> {
    return apiRequest(`/api/message-center/templates/${templateId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  // Delete template
  async deleteTemplate(templateId: string): Promise<ApiResponse<void>> {
    return apiRequest(`/api/message-center/templates/${templateId}`, {
      method: 'DELETE',
    });
  },

  // Test template with sample data
  async testTemplate(templateId: string, testData: Record<string, any>): Promise<ApiResponse<{ subject?: string; body: string }>> {
    return apiRequest(`/api/message-center/templates/${templateId}/test`, {
      method: 'POST',
      body: JSON.stringify({ testData }),
    });
  },
};

// Scheduled Messages
export const scheduledMessageService = {
  // Get all scheduled messages
  async getSchedules(params?: {
    page?: number;
    limit?: number;
    search?: string;
    messageType?: string;
    isActive?: boolean;
  }): Promise<ApiResponse<PaginatedResponse<ScheduledMessage>>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) queryParams.append(key, value.toString());
      });
    }
    
    return apiRequest(`/api/message-center/schedules?${queryParams}`);
  },

  // Get single schedule
  async getSchedule(scheduleId: string): Promise<ApiResponse<ScheduledMessage>> {
    return apiRequest(`/api/message-center/schedules/${scheduleId}`);
  },

  // Create new schedule
  async createSchedule(schedule: Omit<ScheduledMessage, 'scheduleId' | 'createdDate' | 'createdBy'>): Promise<ApiResponse<ScheduledMessage>> {
    return apiRequest('/api/message-center/schedules', {
      method: 'POST',
      body: JSON.stringify(schedule),
    });
  },

  // Update schedule
  async updateSchedule(scheduleId: string, updates: Partial<ScheduledMessage>): Promise<ApiResponse<ScheduledMessage>> {
    return apiRequest(`/api/message-center/schedules/${scheduleId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  // Delete schedule
  async deleteSchedule(scheduleId: string): Promise<ApiResponse<void>> {
    return apiRequest(`/api/message-center/schedules/${scheduleId}`, {
      method: 'DELETE',
    });
  },

  // Run schedule immediately
  async runSchedule(scheduleId: string): Promise<ApiResponse<{ messagesQueued: number }>> {
    return apiRequest(`/api/message-center/schedules/${scheduleId}/run`, {
      method: 'POST',
    });
  },
};

// Message Queue
export const messageQueueService = {
  /** Grouped send batches with progress (SMS/email counts) */
  async getBatches(params?: {
    page?: number;
    limit?: number;
    tenantId?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<ApiResponse<{ data: MessageSendBatchRow[]; total: number; page: number; limit: number; totalPages: number }>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) queryParams.append(key, value.toString());
      });
    }
    return apiRequest(`/api/message-center/batches?${queryParams}`);
  },

  // Get queue items
  async getQueueItems(params?: {
    page?: number;
    limit?: number;
    status?: string;
    messageType?: string;
  }): Promise<ApiResponse<PaginatedResponse<MessageQueueItem>>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) queryParams.append(key, value.toString());
      });
    }
    
    return apiRequest(`/api/message-center/queue?${queryParams}`);
  },

  // Retry failed message
  async retryMessage(messageId: string): Promise<ApiResponse<void>> {
    return apiRequest(`/api/message-center/queue/${messageId}/retry`, {
      method: 'POST',
    });
  },


  // Cancel pending message
  async cancelMessage(messageId: string): Promise<ApiResponse<void>> {
    return apiRequest(`/api/message-center/queue/${messageId}/cancel`, {
      method: 'POST',
    });
  },

  // Get queue statistics
  async getQueueStats(): Promise<ApiResponse<{
    pending: number;
    processing: number;
    failed: number;
    sent: number;
  }>> {
    return apiRequest('/api/message-center/queue/stats');
  },
};

// Message History
export const messageHistoryService = {
  // Get message history
  async getHistory(params?: {
    page?: number;
    limit?: number;
    recipientId?: string;
    messageType?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<ApiResponse<PaginatedResponse<MessageHistory>>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) queryParams.append(key, value.toString());
      });
    }
    
    return apiRequest(`/api/message-center/history?${queryParams}`);
  },

  // Get delivery details
  async getDeliveryDetails(historyId: string): Promise<ApiResponse<MessageHistory & { events: Array<{ event: string; timestamp: string }> }>> {
    return apiRequest(`/api/message-center/history/${historyId}/details`);
  },

  // Export history
  async exportHistory(params: {
    format: 'csv' | 'excel';
    startDate?: string;
    endDate?: string;
    status?: string;
  }): Promise<Blob> {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) queryParams.append(key, value.toString());
    });

    const response = await apiService.get(`/api/message-center/history/export?${queryParams}`, {
      responseType: 'blob',
    });
    return response as unknown as Blob;
  },
};

// Message Analytics Types
export interface MessageAnalytics {
  totalSent: number;
  totalFailed: number;
  deliveryRate: number;
  byType: {
    email: number;
    sms: number;
  };
  byStatus: Record<string, number>;
  dailyStats: Array<{
    date: string;
    sent: number;
    failed: number;
    opened: number;
  }>;
  tenantSummaries: Array<{
    tenantId: string;
    tenantName: string;
    totalMessages: number;
    emailsSent: number;
    smsSent: number;
    failureRate: number;
    lastActivity: string;
  }>;
}



// Analytics (SysAdmin only)
export const messageAnalyticsService = {
  // Get analytics dashboard
  async getAnalytics(params?: {
    startDate?: string;
    endDate?: string;
    tenantId?: string; // SysAdmin can filter by tenant
    allTenants?: string | boolean; // SysAdmin: scope to all tenants
  }): Promise<ApiResponse<MessageAnalytics>> {
    const queryParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) queryParams.append(key, value.toString());
      });
    }
    
    return apiRequest(`/api/message-center/analytics?${queryParams}`);
  },

  // Get tenant summary (SysAdmin only)
  async getTenantSummary(): Promise<ApiResponse<Array<{
    tenantId: string;
    tenantName: string;
    totalMessages: number;
    emailsSent: number;
    smsSent: number;
    failureRate: number;
    lastActivity: string;
  }>>> {
    return apiRequest('/api/message-center/analytics/tenant-summary');
  },
};

// Utility functions
export const messageCenterUtils = {
  // Get available template variables
  getAvailableVariables(): string[] {
    return [
      'member.FirstName',
      'member.LastName',
      'member.Email',
      'member.Phone',
      'member.FullName',
      'member.Address',
      'member.City',
      'member.State',
      'member.ZipCode',
      'member.DateOfBirth',
      'member.MemberNumber',
      'member.EffectiveDate',
      'member.TerminationDate',
      'member.Age',
      'tenant.Name',
      'tenant.Phone',
      'tenant.Email',
      'tenant.Website',
      'system.CurrentDate',
      'system.CurrentYear',
      'system.CurrentMonth',
      'system.LoginUrl',
    ];
  },

  // Format variable for display
  formatVariable(variable: string): string {
    return `{[${variable}]}`;
  },

  // Preview template with sample data
  previewTemplate(template: string, sampleData: Record<string, any>): string {
    let preview = template;
    Object.entries(sampleData).forEach(([key, value]) => {
      const regex = new RegExp(`\\{\\[${key}\\]\\}`, 'g');
      preview = preview.replace(regex, value);
    });
    return preview;
  },
};

export const campaignService = {
  async getCampaigns(params?: { triggerType?: string; isActive?: string; search?: string; tenantId?: string; scope?: 'tenant' | 'vendor' }): Promise<ApiResponse<Campaign[]>> {
    const queryParams = new URLSearchParams();
    if (params?.triggerType) queryParams.set('triggerType', params.triggerType);
    if (params?.isActive !== undefined) queryParams.set('isActive', params.isActive);
    if (params?.search) queryParams.set('search', params.search);
    if (params?.tenantId) queryParams.set('tenantId', params.tenantId);
    if (params?.scope) queryParams.set('scope', params.scope);
    const qs = queryParams.toString();
    return apiRequest<Campaign[]>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns${qs ? `?${qs}` : ''}`);
  },

  async getCampaign(campaignId: string): Promise<ApiResponse<Campaign>> {
    return apiRequest<Campaign>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}`);
  },

  // SysAdmin may pass `createForTenantId` (required) and optional `createForVendorId`
  // to explicitly own the new campaign. TenantAdmin/VendorAdmin paths ignore these
  // (backend forces scope from the caller's identity).
  async createCampaign(data: {
    campaignName: string;
    triggerType: string;
    recipientType?: 'Member' | 'Agent';
    isActive?: boolean;
    tenantId?: string;
    createForTenantId?: string | null;
    createForVendorId?: string | null;
  }): Promise<ApiResponse<{ campaignId: string }>> {
    return apiRequest<{ campaignId: string }>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateCampaign(campaignId: string, data: Partial<Campaign>): Promise<ApiResponse<void>> {
    return apiRequest<void>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  async deleteCampaign(campaignId: string): Promise<ApiResponse<void>> {
    return apiRequest<void>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}`, { method: 'DELETE' });
  },

  async duplicateCampaign(campaignId: string): Promise<ApiResponse<{ campaignId: string }>> {
    return apiRequest<{ campaignId: string }>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}/duplicate`, { method: 'POST' });
  },

  async addStep(campaignId: string, data: { delayDays: number; emailTemplateId?: string | null; smsTemplateId?: string | null }): Promise<ApiResponse<{ stepId: string; stepOrder: number }>> {
    return apiRequest<{ stepId: string; stepOrder: number }>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}/steps`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
  },

  async updateStep(campaignId: string, stepId: string, data: Partial<CampaignStep>): Promise<ApiResponse<void>> {
    return apiRequest<void>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}/steps/${stepId}`, {
      method: 'PUT',
      body: JSON.stringify(data)
    });
  },

  async deleteStep(campaignId: string, stepId: string): Promise<ApiResponse<void>> {
    return apiRequest<void>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}/steps/${stepId}`, { method: 'DELETE' });
  },

  async reorderSteps(campaignId: string, steps: { stepId: string; stepOrder: number }[]): Promise<ApiResponse<void>> {
    return apiRequest<void>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}/steps/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ steps })
    });
  },

  async getCampaignEnrollments(campaignId: string): Promise<ApiResponse<CampaignEnrollment[]>> {
    return apiRequest<CampaignEnrollment[]>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/${campaignId}/enrollments`);
  },

  async getTemplateUsage(templateId: string): Promise<ApiResponse<{ campaignId: string; campaignName: string }[]>> {
    return apiRequest<{ campaignId: string; campaignName: string }[]>(`${API_CONFIG.ENDPOINTS.MESSAGE_CENTER}/campaigns/templates/${templateId}/usage`);
  }
};