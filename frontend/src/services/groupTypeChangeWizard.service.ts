/**
 * groupTypeChangeWizard.service.ts
 *
 * Service for the Group Type Conversion Wizard (Task 5.1+).
 *
 * Exposes:
 *   - getPreview(groupId)        — fetches the Step 1 preview from the backend
 *   - apply(groupId, payload)    — applies the type change (Step 2/3)
 *   - sendLinks(groupId, ids)    — Task 5.3 (stub)
 */

import { apiService } from './api.service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WizardAction = 'preserve' | 'reEnroll' | 'letFinishThenCancel';

export interface PreserveMapping {
  enrollmentId: string;
  newProductId: string;
}

export interface ApplyPayload {
  productIds: string[];
  memberIdsToReEnroll: string[];
  preserveMappings: PreserveMapping[];
  memberIdsToLetFinish: string[];
}

export interface ApplyResult {
  productsHidden: number;
  productsAdded: number;
  preservedEnrollmentsRepointed: number;
  enrollmentsTerminationScheduled: number;
  householdIdsCleared: number;
  enrollmentsCancelled: number;
  groupType: 'Standard' | 'ListBill';
}

export interface MatchingIndividualProduct {
  productId: string;
  name: string;
  salesType: 'Individual' | 'Both';
}

/** One enrollment row under a member; each enrollment has its own action. */
export interface PreviewEnrollment {
  enrollmentId: string;
  productId: string;
  productName: string;
  vendorId: string;
  productType: string;
  effectiveDate: string;
  status: string;
  matchingIndividualProduct: MatchingIndividualProduct | null;
  action: WizardAction;
}

/**
 * One entry per member. `action` is the most action-requiring outcome across
 * the member's enrollments (reEnroll > letFinishThenCancel > preserve), used
 * for top-level bucketing in the UI.
 */
export interface PreviewMember {
  memberId: string;
  displayName: string;
  action: WizardAction;
  enrollments: PreviewEnrollment[];
}

export interface TypeChangePreview {
  /**
   * The direction the wizard is converting toward. Drives Step 2's product
   * filter (ListBill → Individual/Both, Standard → Group/Both) and the
   * heading / description copy.
   */
  targetType: 'ListBill' | 'Standard';
  members: PreviewMember[];
  /**
   * Members in the group with no active/pending enrollments. Listed so the
   * agent can see they exist and know nothing is silently dropped — their
   * enrollment links auto-pick up the new product set after the wizard runs.
   */
  membersWithoutEnrollments: Array<{
    memberId: string;
    displayName: string;
    email: string | null;
    memberStatus: string | null;
  }>;
}

export interface SendLinksResult {
  sentCount: number;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Fetch the type-change preview for a group.
 *
 * Calls: GET /api/groups/:groupId/type-change/preview
 *
 * Returns the list of affected members bucketed by action:
 *   - 'preserve'            — individual product match found
 *   - 'reEnroll'            — no match, future effective date
 *   - 'letFinishThenCancel' — no match, past effective date
 */
export async function getPreview(groupId: string): Promise<TypeChangePreview> {
  const response = await apiService.get<{ success: boolean; data: TypeChangePreview }>(
    `/api/groups/${groupId}/type-change/preview`
  );
  return response.data;
}

/**
 * Fetch the wizard Step 2 product picker payload.
 *
 * Calls: GET /api/groups/:groupId/type-change/available-products
 *
 * Diverges from the standard /api/groups/:id/products endpoint by requiring
 * an explicit, active oe.ProductSubscriptions row for the tenant — no
 * marketplace fall-through. Available products are pre-narrowed to
 * SalesType IN ('Individual', 'Both') for List-Bill conversion.
 */
export async function getAvailableProducts(groupId: string): Promise<{
  groupProducts: any[];
  availableProducts: any[];
  group: { GroupId: string; Name: string; TenantId: string; Status: string };
}> {
  const response = await apiService.get<{
    success: boolean;
    data: {
      groupProducts: any[];
      availableProducts: any[];
      group: { GroupId: string; Name: string; TenantId: string; Status: string };
    };
  }>(`/api/groups/${groupId}/type-change/available-products`);
  return response.data;
}

/**
 * Apply the type conversion.
 *
 * Calls: POST /api/groups/:groupId/type-change/apply
 *
 * Transactionally:
 *   - Hides old group products not in the new list
 *   - Inserts/unhides GroupProducts rows for productIds
 *   - Clears HouseholdMemberId for memberIdsToReEnroll
 *   - Cancels future Pending/Pending Payment enrollments for those members
 */
export async function apply(
  groupId: string,
  payload: ApplyPayload
): Promise<ApplyResult> {
  const response = await apiService.post<{ success: boolean; data: ApplyResult; message?: string }>(
    `/api/groups/${groupId}/type-change/apply`,
    payload
  );
  if (!response.success) {
    throw new Error(response.message ?? 'Apply failed.');
  }
  return response.data;
}

/**
 * Send enrollment links to members who need re-enrollment.
 *
 * Calls: POST /api/groups/:groupId/send-enrollment-links
 *
 * Body: { memberIds, templateId, deliveryPreferences: { sendEmail: true, sendSMS: false } }
 * Response data: { sentCount, memberIds, createdLinks, templateName, emailResults, smsResults }
 */
export async function sendLinks(
  groupId: string,
  memberIds: string[],
  templateId: string
): Promise<SendLinksResult> {
  const response = await apiService.post<{
    success: boolean;
    data: { sentCount: number };
    message?: string;
  }>(
    `/api/groups/${groupId}/send-enrollment-links`,
    {
      memberIds,
      templateId,
      deliveryPreferences: { sendEmail: true, sendSMS: false },
      // Wizard scheduled letFinish members for termination at month-end. They
      // still look "Active" (with TerminationDate set) so the standard
      // IsEnrolled filter would skip them. This flag tells the route to
      // exclude scheduled-termination enrollments from the IsEnrolled check
      // so those members get their re-enrollment links.
      includeMembersScheduledForTermination: true
    }
  );
  if (!response.success) {
    throw new Error(response.message ?? 'Failed to send enrollment links.');
  }
  return { sentCount: response.data.sentCount };
}
