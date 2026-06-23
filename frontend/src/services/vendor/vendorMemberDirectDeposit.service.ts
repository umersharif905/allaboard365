import { apiService } from '../api.service';
import type {
  MemberDirectDepositSummary,
  MemberDirectDepositRevealed
} from '../memberDirectDeposit.service';

export type {
  MemberDirectDepositSummary,
  MemberDirectDepositRevealed
};

const baseUrl = (memberId: string) =>
  `/api/me/vendor/members/${memberId}/direct-deposits`;

export const VendorMemberDirectDepositService = {
  list(memberId: string) {
    return apiService.get<{ success: boolean; data: MemberDirectDepositSummary[] }>(
      baseUrl(memberId)
    );
  },

  reveal(memberId: string, directDepositId: string) {
    return apiService.get<{ success: boolean; data: MemberDirectDepositRevealed }>(
      `${baseUrl(memberId)}/${directDepositId}/reveal`
    );
  }
};
