// types/fap.types.ts
// Type definitions for Provider FAP (Financial Aid Application) Management

export type FAPSubmissionStatus = 
  | 'Draft'
  | 'Submitted'
  | 'AwaitingProviderResponse'
  | 'AdditionalDocsRequested'
  | 'Approved'
  | 'Denied'
  | 'Expired';

export type FAPDocumentType = 
  | 'FAP Application Form'
  | 'Financial Documentation'
  | 'Income Verification'
  | 'Medical Bills'
  | 'Letters of Hardship'
  | 'Provider-Specific Forms'
  | 'Other';

export type FAPNoteType = 'Note' | 'Communication' | 'SystemActivity';

export type FAPContactMethod = 'Phone' | 'Email' | 'Fax' | 'Portal' | 'Other';

export interface ProviderFAPSettings {
  fapSettingsId?: string;
  providerId: string;
  vendorId: string;
  fapWebsiteUrl?: string;
  fapFormUrl?: string;
  fapInstructionsUrl?: string;
  primaryContactName?: string;
  primaryContactPhone?: string;
  primaryContactEmail?: string;
  faxNumber?: string;
  officeHours?: string;
  expectedProcessingTimeDays?: number;
  requiredDocumentation?: string; // JSON array
  providerSpecificRules?: string;
  createdDate?: string;
  createdBy?: string;
  createdByFirstName?: string;
  createdByLastName?: string;
  modifiedDate?: string;
  modifiedBy?: string;
  modifiedByFirstName?: string;
  modifiedByLastName?: string;
}

export interface FAPSubmission {
  submissionId: string;
  providerId: string;
  vendorId: string;
  memberId?: string;
  submissionNumber: string;
  status: FAPSubmissionStatus;
  submittedDate?: string;
  providerResponseDate?: string;
  approvalDate?: string;
  denialDate?: string;
  expirationDate?: string;
  originalBillAmount?: number;
  discountedAmount?: number;
  discountPercentage?: number;
  finalAmount?: number;
  submissionNotes?: string;
  providerResponseNotes?: string;
  internalNotes?: string;
  nextFollowUpDate?: string;
  daysPending?: number;
  createdDate: string;
  createdBy?: string;
  createdByFirstName?: string;
  createdByLastName?: string;
  modifiedDate?: string;
  modifiedBy?: string;
  modifiedByFirstName?: string;
  modifiedByLastName?: string;
  memberNumber?: string;
  memberFirstName?: string;
  memberLastName?: string;
}

export interface FAPDocument {
  documentId: string;
  providerId?: string;
  submissionId?: string;
  vendorId: string;
  documentName: string;
  documentType?: FAPDocumentType;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  blobUrl?: string;
  blobPath?: string;
  authenticatedUrl?: string;
  description?: string;
  isActive: boolean;
  createdDate: string;
  createdBy?: string;
  createdByFirstName?: string;
  createdByLastName?: string;
}

export interface FAPNote {
  noteId: string;
  providerId?: string;
  submissionId?: string;
  vendorId: string;
  noteType: FAPNoteType;
  contactMethod?: FAPContactMethod;
  personContacted?: string;
  note: string;
  nextFollowUpDate?: string;
  isInternal: boolean;
  createdDate: string;
  createdBy?: string;
  createdByFirstName?: string;
  createdByLastName?: string;
  createdByName?: string;
}

export interface ProviderRanking {
  rankingId?: string;
  providerId: string;
  vendorId: string;
  shareRequestId?: string; // Link to ShareRequest
  shareRequestNumber?: string; // For display
  fairPricingRating?: number; // 1-5 stars
  communicationRating?: number; // 1-5 stars
  negotiationRating?: number; // 1-5 stars
  fairPricingNotes?: string; // Notes for Fair Pricing
  communicationNotes?: string; // Notes for Communication
  negotiationNotes?: string; // Notes for Negotiation
  overallRating?: number; // Calculated average
  createdDate?: string;
  createdBy?: string;
  createdByFirstName?: string;
  createdByLastName?: string;
  modifiedDate?: string;
  modifiedBy?: string;
  modifiedByFirstName?: string;
  modifiedByLastName?: string;
  rankedBy?: 'Vendor' | 'Member'; // Who created this ranking
  memberId?: string; // If ranked by member
}

export interface FAPAnalytics {
  totalSubmissions: number;
  approvedSubmissions: number;
  deniedSubmissions: number;
  pendingSubmissions: number;
  averageDiscountPercentage?: number;
  averageProcessingTimeDays?: number;
  totalBillAmount?: number;
  totalDiscountedAmount?: number;
  approvalRate?: number;
  denialRate?: number;
}

export interface ProviderFAPSummary {
  providerId: string;
  providerName: string;
  vendorId: string;
  totalSubmissions: number;
  approvedSubmissions: number;
  deniedSubmissions: number;
  pendingSubmissions: number;
  averageDiscountPercentage?: number;
  averageBillAmount?: number;
  averageDiscountedAmount?: number;
  totalBillAmount?: number;
  totalDiscountedAmount?: number;
  averageProcessingTimeDays?: number;
  fairPricingScore?: number;
  communicationScore?: number;
  negotiationScore?: number;
  overallScore?: number;
  lastActivityDate?: string;
  lastSubmissionDate?: string;
}

// Status constants
export const FAP_SUBMISSION_STATUSES: FAPSubmissionStatus[] = [
  'Draft',
  'Submitted',
  'AwaitingProviderResponse',
  'AdditionalDocsRequested',
  'Approved',
  'Denied',
  'Expired'
];

export const FAP_DOCUMENT_TYPES: FAPDocumentType[] = [
  'FAP Application Form',
  'Financial Documentation',
  'Income Verification',
  'Medical Bills',
  'Letters of Hardship',
  'Provider-Specific Forms',
  'Other'
];

export const FAP_NOTE_TYPES: FAPNoteType[] = ['Note', 'Communication', 'SystemActivity'];

export const FAP_CONTACT_METHODS: FAPContactMethod[] = ['Phone', 'Email', 'Fax', 'Portal', 'Other'];

// Status color mapping
export const FAP_STATUS_COLORS: Record<FAPSubmissionStatus, { bg: string; text: string }> = {
  'Draft': { bg: 'bg-gray-100', text: 'text-gray-800' },
  'Submitted': { bg: 'bg-blue-100', text: 'text-blue-800' },
  'AwaitingProviderResponse': { bg: 'bg-yellow-100', text: 'text-yellow-800' },
  'AdditionalDocsRequested': { bg: 'bg-orange-100', text: 'text-orange-800' },
  'Approved': { bg: 'bg-green-100', text: 'text-green-800' },
  'Denied': { bg: 'bg-red-100', text: 'text-red-800' },
  'Expired': { bg: 'bg-gray-100', text: 'text-gray-800' }
};

