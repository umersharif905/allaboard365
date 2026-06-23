// frontend/src/services/proposal.service.ts
// Service for managing proposal documents and sending proposals

import { apiService } from './api.service';

export interface ProductSlot {
  slotNumber: number;
  productId: string;
  productName?: string;
  productType?: string;
  isPrimary?: boolean;
}

export interface ProposalDocument {
  proposalDocumentId: string;
  name: string;
  description?: string;
  category?: string;
  documentId: string;
  tenantIds?: string[]; // Array of tenant IDs that have access to this proposal
  isActive: boolean;
  createdBy?: string;
  createdDate: string;
  modifiedDate: string;
  documentUrl?: string;
  fileName?: string;
  fileSize?: number;
  fields?: ProposalField[];
  productSlots?: ProductSlot[]; // Product slots assigned to this template (for business proposals)
}

export interface ProposalField {
  fieldId?: string;
  proposalDocumentId?: string;
  fieldType: 'text' | 'image' | 'price' | 'whitespace' | 'link' | 'custom' | 'calculation';
  fieldName?: string;
  customLabel?: string; // For custom fields, the label shown in the send form
  customFieldId?: string; // For custom fields, a shared ID that links multiple fields together
  autoFillType?: 'AgentName' | 'AgentAddress' | 'AgentPhone' | 'AgentEmail' | 'AgentPhoto' | 'ClientName' | 'ClientAddress' | 'AgencyName' | 'TierDescription' | 'TodaysDate' | 'TodaysDateNumeric' | 'CustomText'
    | 'GroupContributionEE' | 'GroupContributionES' | 'GroupContributionEC' | 'GroupContributionEF'
    | 'EmployeeCostEE' | 'EmployeeCostES' | 'EmployeeCostEC' | 'EmployeeCostEF';
  addressFormat?: 'full' | 'streetOnly' | 'multiline'; // For AgentAddress and ClientAddress fields
  xPosition: number;
  yPosition: number;
  width: number;
  height: number;
  pageNumber: number;
  textColor?: string;
  backgroundColor?: string;
  fillBackground?: boolean; // Whether to fill the background (for text/price fields)
  imageShape?: 'circle' | 'square'; // Shape for image fields
  borderColor?: string; // Border color for image fields (persisted in ConfigValue JSON)
  borderWidth?: number; // Border width in pixels for image fields (persisted in ConfigValue JSON)
  productId?: string; // For price fields
  configValue?: string; // For price fields
  tier?: string; // Per-field tier override (null/"document" = use document tier)
  fontSize?: number; // Font size in points for text/price fields
  isBold?: boolean; // Whether text is bold
  textAlign?: 'left' | 'center' | 'right'; // Text alignment
  verticalAlign?: 'top' | 'middle' | 'bottom'; // Vertical alignment for text-based fields
  fontFamily?: string; // Font family persisted in ConfigValue JSON
  linkType?: 'static_url' | 'enrollment_link' | 'dynamic_url'; // For link fields
  linkUrl?: string; // For static_url type, stores the actual URL
  enrollmentLinkTemplateId?: string; // For enrollment_link type, stores the template ID
  // For calculation fields
  calculationType?:
    // Individual proposal calculation types
    'total_monthly' | 'total_yearly' | 'tier_monthly' | 'tier_yearly' | 'total_employee_count' | 'percentage' |

    // ===== NEW: Shared Calculations (S1–S26) =====
    'calcTotalMwEnrollees' |
    'calcTierMixPct_EE' | 'calcTierMixPct_E1' | 'calcTierMixPct_EF' |
    'calcMwEnrollmentPct' |
    'calcCurrentEnrollmentPct' |
    'calcNotEnrolledCount' |
    'calcMwTierPrice_EE' | 'calcMwTierPrice_E1' | 'calcMwTierPrice_EF' |
    'calcMwTierCost_EE' | 'calcMwTierCost_E1' | 'calcMwTierCost_EF' |
    'calcMwTotalMonthly' | 'calcMwTotalYearly' |
    'calcUnsharedAmountDisplay' |
    'calcEmployerContrib_EE' | 'calcEmployerContrib_E1' | 'calcEmployerContrib_EF' |
    'calcEmployeeCost_EE' | 'calcEmployeeCost_E1' | 'calcEmployeeCost_EF' |
    'calcTotalEmployerMwMonthly' | 'calcTotalEmployerMwYearly' |
    'calcTotalEmployeeCostMonthly' |
    'calcCurrentPremiumYearly' |
    'calcNetCostChangeMonthly' | 'calcNetCostChangeYearly' |
    'calcNetCostChangeMonthly_partial' | 'calcNetCostChangeYearly_partial' |
    'calcNetCostChangeMonthly_generic' | 'calcNetCostChangeYearly_generic' |
    'calcSavingsMonthly' | 'calcSavingsYearly' |
    'calcSavingsMonthly_partial' | 'calcSavingsYearly_partial' |
    'calcSavingsMonthly_generic' | 'calcSavingsYearly_generic' |
    'calcNetEnrollmentChangeCount' | 'calcNetEnrollmentChangePct' |
    'calcStepTierAlloc_EE' | 'calcStepTierAlloc_E1' | 'calcStepTierAlloc_EF' |
    'calcStepTierCost_EE' | 'calcStepTierCost_E1' | 'calcStepTierCost_EF' |
    'calcStepTotalCost' |
    'calcEnrollmentDatesDisplay' |

    // ===== NEW: Partial Switch (P2–P13) =====
    'calcAvgCurrentPerEmployee' |
    'calcCurrentRemainMonthly' | 'calcCurrentRemainYearly' |
    'calcTotalProjectedEnrolled' | 'calcProjectedEnrollmentPct' |
    'calcBlendedEmployerMonthly' | 'calcBlendedEmployerYearly' |
    'calcHeadlinePartialSwitch' |
    'calcPartMixMwCount' | 'calcPartMixRemainCount' | 'calcPartMixNotEnrolled' |
    'calcNetBusinessImpact' |

    // ===== NEW: Generic Quote (G3, G8) =====
    'calcHeadlineGenericQuote' |
    'calcStepEnrollment' |

    // ===== NEW: Employee Proposal (E1–E6) =====
    'calcEmployerContribDisplay_EE' | 'calcEmployerContribDisplay_E1' | 'calcEmployerContribDisplay_EF' |
    'calcEmployerSharePct_EE' | 'calcEmployerSharePct_E1' | 'calcEmployerSharePct_EF' |
    'calcEmployeeSharePct_EE' | 'calcEmployeeSharePct_E1' | 'calcEmployeeSharePct_EF' |
    'calcEmployeeMonthlyCost_EE' | 'calcEmployeeMonthlyCost_E1' | 'calcEmployeeMonthlyCost_EF' |
    'calcEmployeeAnnualCost_EE' | 'calcEmployeeAnnualCost_E1' | 'calcEmployeeAnnualCost_EF' |
    'calcEmployerAnnualContrib_EE' | 'calcEmployerAnnualContrib_E1' | 'calcEmployerAnnualContrib_EF' |

    // ===== LEGACY: Old bp_* keys (backward compat with existing templates) =====
    'bp_company_name' | 'bp_company_address' |
    'bp_headline_value' |
    'bp_product_title' |
    'bp_total_employees' | 'bp_currently_enrolled' | 'bp_not_enrolled' |
    'bp_current_enrollment_pct' | 'bp_current_premium_monthly' | 'bp_current_premium_yearly' |
    'bp_estimated_enrollment_count' | 'bp_estimated_enrollment_pct' |
    'bp_tier_count_ee' | 'bp_tier_count_es' | 'bp_tier_count_ef' |
    'bp_tier_pct_ee' | 'bp_tier_pct_es' | 'bp_tier_pct_ef' |
    'bp_tier_price_ee' | 'bp_tier_price_es' | 'bp_tier_price_ef' |
    'bp_unshared_amount' |
    'bp_projected_monthly' | 'bp_projected_yearly' |
    'bp_savings_monthly' | 'bp_savings_yearly' | 'bp_savings_pct' |
    'bp_calc_step_enrollment' | 'bp_calc_step_tier' | 'bp_calc_step_cost' | 'bp_calc_step_savings' |
    'bp_review_date' |
    'bp_net_increase_employees' | 'bp_net_increase_enrollment_pct' |
    'bp_participation_pct' | 'bp_mw_plan_count' |
    'bp_current_remain_count' | 'bp_not_enrolled_projected' | 'bp_total_enrolled_projected' |
    'bp_savings_monthly_amount' | 'bp_savings_yearly_amount' |
    'bp_calc_step_tier_io' | 'bp_calc_step_tier_es' | 'bp_calc_step_tier_ef' |
    'bp_calc_step_cost_io' | 'bp_calc_step_cost_es' | 'bp_calc_step_cost_ef' |

    // ===== Dynamic Fields =====
    'dynamicPrice' |

    // ===== Combined Price (sum of multiple product slots) =====
    'combinedPrice';
  calculationConfig?: Record<string, any>; // e.g., { tier: 'EE' } for tier-specific calculations
  repeatOnAllPages?: boolean; // If true, field renders on every page of the PDF (stored in ConfigValue JSON)
  createdDate?: string;
  modifiedDate?: string;
}

export interface ProposalSend {
  proposalSendId: string;
  proposalDocumentId: string;
  prospectName: string;
  prospectEmail?: string;
  prospectPhone?: string;
  tier: string;
  tobaccoUse: boolean;
  age: number;
  generatedPdfUrl: string;
  sentDate: string;
  sendMethod: 'email' | 'text' | 'download';
  proposalDocumentName?: string;
}

export interface CreateProposalDocumentData {
  name: string;
  description?: string;
  category?: string;
  documentId: string;
  documentUrl?: string;
  fileName?: string;
  fileSize?: number;
  tenantIds?: string[]; // Array of tenant IDs (defaults to user's tenant if not provided)
  fields?: ProposalField[];
  productSlots?: ProductSlot[]; // Product slots for business proposal templates
  isActive?: boolean;
}

export interface UpdateProposalDocumentData extends Partial<CreateProposalDocumentData> {
  proposalDocumentId: string;
}

export interface GenerateProposalData {
  proposalDocumentId: string;
  // productId removed - pricing placeholders in the document determine which products to calculate
  prospectInfo: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    dateOfBirth?: string;
    hasSpouse?: boolean;
    childrenCount?: number;
  };
  tier: string;
  tobaccoUse: boolean;
  age: number;
  sendMethod: 'email' | 'text' | 'download';
  enrollmentLinkUrls?: Record<string, string>; // Map of EnrollmentLinkTemplateId to URL
  customFieldValues?: Record<string, string>; // Map of fieldId to value for custom fields
  existingPdfUrl?: string; // Optional: reuse existing PDF if provided
  emailMessage?: string; // Optional: custom message for email
  textMessage?: string; // Optional: custom message for text/SMS
}

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code: string;
  };
}

export class ProposalService {
  /**
   * Transform PascalCase database fields to camelCase
   */
  private static transformProposalDocument(doc: any): ProposalDocument {
    // Transform fields if they exist
    let transformedFields: ProposalField[] | undefined;
    if (doc.fields && Array.isArray(doc.fields)) {
      transformedFields = doc.fields.map((field: any) => {
        const fontSizeRaw = field.FontSize ?? field.fontSize;
        const fontSizeNum = Number(fontSizeRaw);
        const isBoldRaw = field.IsBold ?? field.isBold;
        const configValueRaw = field.ConfigValue || field.configValue;
        const parsedConfig = (() => {
          if (!configValueRaw || typeof configValueRaw !== 'string') return undefined;
          try {
            const parsed = JSON.parse(configValueRaw);
            return parsed && typeof parsed === 'object' ? parsed : undefined;
          } catch {
            return undefined;
          }
        })();
        const isBoldBool =
          isBoldRaw === undefined || isBoldRaw === null
            ? false
            : typeof isBoldRaw === 'boolean'
              ? isBoldRaw
              : isBoldRaw === 1 || isBoldRaw === '1' || String(isBoldRaw).toLowerCase() === 'true';

        return {
          fieldId: field.FieldId || field.fieldId,
          proposalDocumentId: field.ProposalDocumentId || field.proposalDocumentId,
          fieldType: (field.FieldType || field.fieldType) as ProposalField['fieldType'],
          fieldName: field.FieldName || field.fieldName || undefined,
          autoFillType: field.AutoFillType || field.autoFillType || undefined,
          xPosition: field.XPosition !== undefined ? field.XPosition : field.xPosition,
          yPosition: field.YPosition !== undefined ? field.YPosition : field.yPosition,
          width: field.Width !== undefined ? field.Width : field.width,
          height: field.Height !== undefined ? field.Height : field.height,
          pageNumber: field.PageNumber !== undefined ? field.PageNumber : (field.pageNumber || 1),
          textColor: field.TextColor || field.textColor || undefined,
          backgroundColor: field.BackgroundColor || field.backgroundColor || undefined,
          fillBackground: field.FillBackground !== undefined ? field.FillBackground : (field.fillBackground !== undefined ? field.fillBackground : undefined),
          imageShape: field.ImageShape || field.imageShape || undefined,
          borderColor: typeof parsedConfig?.borderColor === 'string' ? parsedConfig.borderColor : undefined,
          borderWidth: typeof parsedConfig?.borderWidth === 'number' ? parsedConfig.borderWidth : undefined,
          productId: field.ProductId || field.productId || undefined,
          configValue: configValueRaw || undefined,
          tier: field.Tier || field.tier || undefined,
          fontSize: Number.isFinite(fontSizeNum) ? fontSizeNum : undefined,
          isBold: isBoldBool,
          addressFormat: field.AddressFormat || field.addressFormat || undefined,
          textAlign: field.TextAlign || field.textAlign || 'left',
          verticalAlign: (() => {
            const raw = field.VerticalAlign || field.verticalAlign || parsedConfig?.verticalAlign;
            if (!raw) return undefined;
            const normalized = String(raw).toLowerCase();
            return normalized === 'top' || normalized === 'middle' || normalized === 'bottom'
              ? normalized
              : undefined;
          })(),
          fontFamily: field.FontFamily || field.fontFamily || (typeof parsedConfig?.fontFamily === 'string' ? parsedConfig.fontFamily : undefined),
          linkType: field.LinkType || field.linkType || undefined,
          linkUrl: field.LinkUrl || field.linkUrl || undefined,
          enrollmentLinkTemplateId: field.EnrollmentLinkTemplateId || field.enrollmentLinkTemplateId || undefined,
          customLabel: field.CustomLabel || field.customLabel || undefined,
          customFieldId: field.CustomFieldId || field.customFieldId || undefined,
          // For calculation fields: calculationType is stored in FieldName, calculationConfig in ConfigValue
          calculationType: (field.FieldType || field.fieldType) === 'calculation'
            ? (field.FieldName || field.fieldName || undefined)
            : undefined,
          calculationConfig: (() => {
            if ((field.FieldType || field.fieldType) !== 'calculation') return undefined;
            return parsedConfig;
          })(),
          // repeatOnAllPages: stored in ConfigValue JSON for all field types
          repeatOnAllPages: (() => {
            return parsedConfig && parsedConfig.repeatOnAllPages === true ? true : undefined;
          })(),
          createdDate: field.CreatedDate || field.createdDate,
          modifiedDate: field.ModifiedDate || field.modifiedDate
        };
      });
    }
    
    // Parse TenantIds - can be comma-separated string from backend or array
    let tenantIds: string[] | undefined;
    if (doc.TenantIds) {
      if (Array.isArray(doc.TenantIds)) {
        tenantIds = doc.TenantIds;
      } else if (typeof doc.TenantIds === 'string') {
        tenantIds = doc.TenantIds.split(',').filter((id: string) => id && id.trim());
      }
    }
    
    // Transform product slots if they exist
    let transformedProductSlots: ProductSlot[] | undefined;
    if (doc.productSlots && Array.isArray(doc.productSlots)) {
      transformedProductSlots = doc.productSlots.map((slot: any) => ({
        slotNumber: slot.SlotNumber ?? slot.slotNumber,
        productId: slot.ProductId || slot.productId,
        productName: slot.ProductName || slot.productName || undefined,
        productType: slot.ProductType || slot.productType || undefined,
        isPrimary: slot.IsPrimary || slot.isPrimary || false
      }));
    }
    
    return {
      proposalDocumentId: doc.ProposalDocumentId || doc.proposalDocumentId,
      name: doc.Name || doc.name || '',
      description: doc.Description || doc.description || undefined,
      category: doc.Category || doc.category || undefined,
      documentId: doc.DocumentId || doc.documentId,
      tenantIds: tenantIds,
      isActive: doc.IsActive !== undefined ? doc.IsActive : (doc.isActive !== undefined ? doc.isActive : true),
      createdBy: doc.CreatedBy || doc.createdBy || undefined,
      createdDate: doc.CreatedDate || doc.createdDate || '',
      modifiedDate: doc.ModifiedDate || doc.modifiedDate || '',
      documentUrl: doc.DocumentUrl || doc.documentUrl || undefined,
      fileName: doc.FileName || doc.fileName || undefined,
      fileSize: doc.FileSize !== undefined ? doc.FileSize : (doc.fileSize !== undefined ? doc.fileSize : undefined),
      fields: transformedFields,
      productSlots: transformedProductSlots
    };
  }

  /**
   * Get proposal documents
   */
  static async getProposalDocuments(params?: {
    tenantIds?: string[]; // Array of tenant IDs to filter by
    category?: string;
    search?: string;
    includeInactive?: boolean; // If true, return inactive documents (e.g. for admin list)
  }): Promise<ApiResponse<ProposalDocument[]>> {
    const queryParams = new URLSearchParams();
    if (params?.tenantIds && Array.isArray(params.tenantIds) && params.tenantIds.length > 0) {
      // Send as comma-separated string
      queryParams.append('tenantIds', params.tenantIds.join(','));
    }
    if (params?.category) queryParams.append('category', params.category);
    if (params?.search) queryParams.append('search', params.search);
    if (params?.includeInactive === true) queryParams.append('includeInactive', 'true');
    
    const queryString = queryParams.toString();
    const response = await apiService.get<ApiResponse<any[]>>(
      `/api/proposal-documents${queryString ? `?${queryString}` : ''}`
    );
    
    // Transform PascalCase to camelCase
    if (response.success && response.data) {
      return {
        ...response,
        data: response.data.map(doc => this.transformProposalDocument(doc))
      };
    }
    
    return response as ApiResponse<ProposalDocument[]>;
  }

  /**
   * Get a single proposal document with fields
   */
  static async getProposalDocument(proposalDocumentId: string): Promise<ApiResponse<ProposalDocument>> {
    const response = await apiService.get<ApiResponse<any>>(
      `/api/proposal-documents/${proposalDocumentId}`
    );
    
    // Transform PascalCase to camelCase
    if (response.success && response.data) {
      return {
        ...response,
        data: this.transformProposalDocument(response.data)
      };
    }
    
    return response as ApiResponse<ProposalDocument>;
  }

  /**
   * Create a new proposal document
   */
  static async createProposalDocument(data: CreateProposalDocumentData): Promise<ApiResponse<ProposalDocument>> {
    const response = await apiService.post<ApiResponse<any>>(
      '/api/proposal-documents',
      data
    );
    
    // Transform PascalCase to camelCase
    if (response.success && response.data) {
      return {
        ...response,
        data: this.transformProposalDocument(response.data)
      };
    }
    
    return response as ApiResponse<ProposalDocument>;
  }

  /**
   * Update a proposal document
   */
  static async updateProposalDocument(data: UpdateProposalDocumentData): Promise<ApiResponse<ProposalDocument>> {
    const { proposalDocumentId, fields, productSlots, ...rest } = data;
    
    // Build updateData - include fields if provided (for PDF editor saves)
    // The backend PUT endpoint accepts fields and will save them
    const updateData: any = {
      ...rest
    };
    
    // Include fields if provided (for PDF editor saves)
    // If fields is undefined, don't include it (for metadata-only updates)
    if (fields !== undefined) {
      updateData.fields = fields;
    }
    
    // Include product slots if provided
    if (productSlots !== undefined) {
      updateData.productSlots = productSlots;
    }
    
    return await apiService.put<ApiResponse<ProposalDocument>>(
      `/api/proposal-documents/${proposalDocumentId}`,
      updateData
    );
  }

  /**
   * Delete a proposal document
   */
  static async deleteProposalDocument(proposalDocumentId: string): Promise<ApiResponse<void>> {
    return await apiService.delete<ApiResponse<void>>(
      `/api/proposal-documents/${proposalDocumentId}`
    );
  }

  /**
   * Get fields for a proposal document
   */
  static async getProposalFields(proposalDocumentId: string): Promise<ApiResponse<ProposalField[]>> {
    return await apiService.get<ApiResponse<ProposalField[]>>(
      `/api/proposal-documents/${proposalDocumentId}/fields`
    );
  }

  /**
   * Save fields for a proposal document
   */
  static async saveProposalFields(
    proposalDocumentId: string,
    fields: ProposalField[]
  ): Promise<ApiResponse<ProposalField[]>> {
    return await apiService.post<ApiResponse<ProposalField[]>>(
      `/api/proposal-documents/${proposalDocumentId}/fields`,
      { fields }
    );
  }

  /**
   * Generate and send a proposal
   */
  static async generateProposal(data: GenerateProposalData): Promise<ApiResponse<{
    proposalSendId: string;
    pdfUrl: string;
    sendMethod: string;
    sentAt: string;
  }>> {
    return await apiService.post<ApiResponse<{
      proposalSendId: string;
      pdfUrl: string;
      sendMethod: string;
      sentAt: string;
    }>>(
      '/api/proposal-sends',
      data
    );
  }

  /**
   * Get proposal sending history
   */
  static async getProposalSends(): Promise<ApiResponse<ProposalSend[]>> {
    return await apiService.get<ApiResponse<ProposalSend[]>>(
      '/api/proposal-sends'
    );
  }
}

export default ProposalService;

