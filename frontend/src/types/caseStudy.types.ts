// types/caseStudy.types.ts
// Patient/Client Success Story case studies authored from completed share requests.

export type CaseStudyStatus = 'Draft' | 'Review' | 'Published' | 'Archived';
export type CaseStudyBrand = 'MightyWELL' | 'ShareWELL';

export interface SnapshotCell {
  label: string;
  value: string;
  subcaption?: string;
}

export interface HowItHappenedStep {
  title: string;
  description: string;
}

/** Editable fields shared by the create/update payload and the prefill draft. */
export interface CaseStudyDraft {
  shareRequestId?: string | null;
  headline: string;
  procedureType: string;
  cptCodes: string;
  storyDate: string | null;
  // The four figures shown in the simplified form
  totalBilledAmount: number | null;
  unsharedAmount: number | null;
  patientPaidAmount: number | null;
  percentValue: number | null; // Percent Saved
  percentLabel: string; // defaults to "SAVED" (not shown in form)
  // Narrative + quote
  briefDescription: string;
  outcomeParagraph: string;
  patientQuote: string;
  quoteAttribution: string;
  status: CaseStudyStatus;
  // Back-office-hidden fields (still in DB; not edited in the simplified form).
  heroLeftLabel?: string;
  heroLeftValue?: number | null;
  heroRightLabel?: string;
  heroRightValue?: number | null;
  percentSavedShared?: number | null;
  totalPaidToProvider?: number | null;
  amountSharedByPlan?: number | null;
  brand?: CaseStudyBrand;
  category?: string;
  snapshotCells?: SnapshotCell[];
  howItHappened?: HowItHappenedStep[];
}

/** Persisted case study returned by the API. */
export interface CaseStudy extends CaseStudyDraft {
  caseStudyId: string;
  vendorId: string;
  isPublished: boolean;
  publishedDate: string | null;
  createdBy: string | null;
  createdDate: string;
  modifiedBy: string | null;
  modifiedDate: string;
}

export interface CaseStudyResponse {
  success: boolean;
  data: CaseStudy;
  message?: string;
}

export interface CaseStudyDraftResponse {
  success: boolean;
  data: CaseStudyDraft;
  message?: string;
}

export interface CaseStudyListResponse {
  success: boolean;
  data: CaseStudy[];
  message?: string;
}
