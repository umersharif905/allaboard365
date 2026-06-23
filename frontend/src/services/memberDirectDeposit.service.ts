import { apiService, withTenantScope } from './api.service';

export interface MemberDirectDepositSummary {
  DirectDepositId: string;
  MemberId: string;
  TenantId: string;
  AccountHolderName: string;
  BankName: string;
  BankAccountType: 'Checking' | 'Savings';
  AccountNumberLast4: string;
  RoutingNumberLast4: string;
  IsActive: boolean | number;
  Source: string;
  SourceSubmissionId: string | null;
  DeactivatedDate: string | null;
  DeactivatedBy: string | null;
  CreatedDate: string;
  CreatedBy: string | null;
  ModifiedDate: string | null;
  ModifiedBy: string | null;
}

export interface MemberDirectDepositRevealed extends MemberDirectDepositSummary {
  AccountNumber: string;
  RoutingNumber: string;
}

export interface CreateDirectDepositInput {
  accountHolderName: string;
  bankName: string;
  bankAccountType: 'Checking' | 'Savings';
  routingNumber: string;
  accountNumber: string;
}

const baseUrl = (memberId: string) =>
  `/api/me/tenant-admin/members/${memberId}/direct-deposits`;

export const MemberDirectDepositService = {
  list(memberId: string, tenantId?: string | null) {
    return apiService.get<{ success: boolean; data: MemberDirectDepositSummary[] }>(
      baseUrl(memberId),
      withTenantScope(tenantId ?? undefined)
    );
  },

  create(memberId: string, payload: CreateDirectDepositInput, tenantId?: string | null) {
    return apiService.post<{ success: boolean; data: { directDepositId: string; memberId: string; isActive: true } }>(
      baseUrl(memberId),
      payload,
      withTenantScope(tenantId ?? undefined)
    );
  },

  activate(memberId: string, directDepositId: string, tenantId?: string | null) {
    return apiService.patch<{ success: boolean; data: MemberDirectDepositSummary }>(
      `${baseUrl(memberId)}/${directDepositId}/activate`,
      {},
      withTenantScope(tenantId ?? undefined)
    );
  },

  deactivate(memberId: string, directDepositId: string, tenantId?: string | null) {
    return apiService.patch<{ success: boolean; data: MemberDirectDepositSummary }>(
      `${baseUrl(memberId)}/${directDepositId}/deactivate`,
      {},
      withTenantScope(tenantId ?? undefined)
    );
  },

  reveal(memberId: string, directDepositId: string, tenantId?: string | null) {
    return apiService.get<{ success: boolean; data: MemberDirectDepositRevealed }>(
      `${baseUrl(memberId)}/${directDepositId}/reveal`,
      withTenantScope(tenantId ?? undefined)
    );
  }
};
