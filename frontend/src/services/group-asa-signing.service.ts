import type { ApiResponse } from '../types/index';
import { apiService } from './api.service';

export interface ASASigningRequest {
  groupId: string;
  productId: string;
  signatureData: string;
  signerName: string;
  signerEmail: string;
}

export interface ASASigningResponse {
  signedAgreementId: string;
  signedDocumentUrl: string;
  signedDate: string;
  signerName: string;
  signerEmail: string;
}

export class GroupASASigningService {
  /**
   * Sign an ASA agreement for a specific product in a group
   * @param request The ASA signing request data
   */
  static async signASA(request: ASASigningRequest): Promise<ApiResponse<ASASigningResponse>> {
    try {
      return await apiService.post<ApiResponse<ASASigningResponse>>(
        `/api/groups/${request.groupId}/asa-sign`,
        request
      );
    } catch (error) {
      console.error(`Error signing ASA for product ${request.productId} in group ${request.groupId}:`, error);
      return { 
        success: false, 
        data: {
          signedAgreementId: '',
          signedDocumentUrl: '',
          signedDate: '',
          signerName: '',
          signerEmail: ''
        }, 
        message: `Failed to sign ASA agreement for product ${request.productId}` 
      };
    }
  }
}

export default GroupASASigningService;


