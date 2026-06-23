import type { ApiResponse } from '../types/api.types';
import { apiService } from './api.service';

export interface ASAAgreement {
  documentId: string;
  documentName: string;
  documentUrl: string;
  productId?: string;
}

export interface ASASignatureInfo {
  signedAgreementId: string;
  signedByEmail: string;
  signedByName: string;
  signedDate: string;
  status: string;
  signedDocumentUrl: string;
}

export interface BundleProductASAStatus {
  productId: string;
  productName: string;
  productType: string;
  vendorId: string;
  vendorName: string;
  sortOrder: number;
  isRequired: boolean;
  requiresASA: boolean;
  asaAgreement: ASAAgreement | null;
  isSigned: boolean;
  signatureInfo: ASASignatureInfo | null;
}

export interface ProductASAStatus {
  productId: string;
  productName: string;
  productType: string;
  vendorId: string;
  vendorName: string;
  isBundle: boolean;
  requiresASA: boolean;
  asaAgreement: ASAAgreement | null;
  isSigned: boolean;
  signatureInfo: ASASignatureInfo | null;
  bundleProducts: BundleProductASAStatus[];
}

export interface GroupASAStatusSummary {
  totalProducts: number;
  productsRequiringASA: number;
  signedASAAgreements: number;
  pendingASAAgreements: number;
  asaCompletionPercentage: number;
}

export interface GroupASAStatusResponse {
  groupId: string;
  groupName: string;
  summary: GroupASAStatusSummary;
  products: ProductASAStatus[];
}

export class GroupASAStatusService {
  /**
   * Get ASA signature status for all products in a group
   * @param groupId The ID of the group
   */
  static async getGroupASAStatus(groupId: string): Promise<ApiResponse<GroupASAStatusResponse>> {
    try {
      return await apiService.get<ApiResponse<GroupASAStatusResponse>>(`/api/groups/${groupId}/asa-status`);
    } catch (error: unknown) {
      console.error(`Error fetching ASA status for group ${groupId}:`, error);
      const ax = error as { response?: { data?: { message?: string } }; message?: string };
      const message =
        ax?.response?.data?.message ||
        ax?.message ||
        `Failed to fetch ASA status for group ${groupId}`;
      return { 
        success: false, 
        data: {
          groupId: '',
          groupName: '',
          summary: {
            totalProducts: 0,
            productsRequiringASA: 0,
            signedASAAgreements: 0,
            pendingASAAgreements: 0,
            asaCompletionPercentage: 0
          },
          products: []
        }, 
        message
      };
    }
  }

  /**
   * Get ASA signature status for a specific product in a group
   * @param groupId The ID of the group
   * @param productId The ID of the product
   */
  static async getProductASAStatus(groupId: string, productId: string): Promise<ApiResponse<ProductASAStatus>> {
    try {
      return await apiService.get<ApiResponse<ProductASAStatus>>(`/api/groups/${groupId}/asa-status/${productId}`);
    } catch (error) {
      console.error(`Error fetching ASA status for product ${productId} in group ${groupId}:`, error);
      return { 
        success: false, 
        data: {
          productId: '',
          productName: '',
          productType: '',
          vendorId: '',
          vendorName: '',
          isBundle: false,
          requiresASA: false,
          asaAgreement: null,
          isSigned: false,
          signatureInfo: null,
          bundleProducts: []
        }, 
        message: `Failed to fetch ASA status for product ${productId}` 
      };
    }
  }
}

export default GroupASAStatusService;
