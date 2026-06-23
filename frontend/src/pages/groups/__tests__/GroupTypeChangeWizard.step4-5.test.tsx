/**
 * GroupTypeChangeWizard — Step 4 (Links) + Step 5 (Done) tests
 *
 * Covers:
 *   - Step 4 shows the list of re-enroll members
 *   - Send button is disabled until a template is selected
 *   - Send calls sendLinks with correct groupId, memberIds, templateId
 *   - On success, advances to Step 5
 *   - On failure, shows inline error (no step change)
 *   - Step 5 renders summary with correct counts from apply + sendLinks results
 *   - "Back to group" CTA invalidates TanStack Query keys and navigates
 *
 * Run: npx vitest run src/pages/groups/__tests__/GroupTypeChangeWizard.step4-5.test.tsx
 */

import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Mocks (must come before component imports)
// ---------------------------------------------------------------------------
vi.mock('../../../services/groupTypeChangeWizard.service');
vi.mock('../../../services/enrollment-link-templates.service');

import * as svc from '../../../services/groupTypeChangeWizard.service';
import { EnrollmentLinkTemplatesService } from '../../../services/enrollment-link-templates.service';
import type {
  TypeChangePreview,
  PreviewMember,
  ApplyResult,
  SendLinksResult
} from '../../../services/groupTypeChangeWizard.service';

const mockGetPreview = vi.mocked(svc.getPreview);
const mockApply = vi.mocked(svc.apply);
const mockSendLinks = vi.mocked(svc.sendLinks);
const mockGetAvailableProducts = vi.mocked(svc.getAvailableProducts);
const mockGetTemplates = vi.mocked(EnrollmentLinkTemplatesService.getTemplates);

// ---------------------------------------------------------------------------
// Import component
// ---------------------------------------------------------------------------
import GroupTypeChangeWizard from '../GroupTypeChangeWizard';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReEnrollMember(overrides: Partial<PreviewMember> = {}): PreviewMember {
  return {
    memberId: 'member-reenroll-1',
    displayName: 'Bob ReEnroll',
    action: 'reEnroll',
    enrollments: [
      {
        enrollmentId: 'enroll-1',
        productId: 'product-1',
        productName: 'Group Dental Plan',
        vendorId: 'vendor-1',
        productType: 'Dental',
        effectiveDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'Pending',
        matchingIndividualProduct: null,
        action: 'reEnroll'
      }
    ],
    ...overrides
  };
}

function makePreviewWithReEnroll(members: PreviewMember[] = []): TypeChangePreview {
  return { targetType: 'ListBill', members, membersWithoutEnrollments: [] };
}

function makeProductsResponse() {
  return {
    group: { GroupId: 'group-123', Name: 'Test Group', TenantId: 'tenant-1', Status: 'Active' },
    groupProducts: [],
    availableProducts: [
      {
        ProductId: 'p1',
        Name: 'Individual Plan A',
        ProductType: 'Medical',
        Description: '',
        BasePrice: 10,
        ProductOwner: 'Acme Vendor',
        AllowedStates: [],
        MinAge: 18,
        MaxAge: 65,
        SalesType: 'Individual',
        IsActive: true
      }
    ]
  };
}

function makeApplyResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    productsHidden: 1,
    productsAdded: 2,
    preservedEnrollmentsRepointed: 2,
    enrollmentsTerminationScheduled: 0,
    householdIdsCleared: 3,
    enrollmentsCancelled: 4,
    groupType: 'ListBill',
    ...overrides
  };
}

function makeSendLinksResult(overrides: Partial<SendLinksResult> = {}): SendLinksResult {
  return { sentCount: 1, ...overrides };
}

function makeTemplatesResponse(templates: { TemplateId: string; TemplateName: string }[] = []) {
  return {
    success: true,
    data: {
      data: templates.map((t) => ({
        TemplateId: t.TemplateId,
        TemplateName: t.TemplateName,
        TemplateType: 'Group',
        IsActive: true,
        TenantId: 'tenant-1',
        LinkMetaData: '{}',
        CreatedDate: '',
        ModifiedDate: '',
        CreatedBy: '',
        ModifiedBy: '',
        ActiveLinksCount: 0,
        CreatedByName: '',
        ModifiedByName: '',
        TenantName: ''
      })),
      total: templates.length,
      page: 1,
      limit: 50
    }
  };
}

// ---------------------------------------------------------------------------
// Test wrapper
// ---------------------------------------------------------------------------

function renderWizard(groupId = 'group-123') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  return { qc, ...render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/groups/${groupId}/type-change/wizard`]}>
        <Routes>
          <Route
            path="/groups/:identifier/type-change/wizard"
            element={<GroupTypeChangeWizard />}
          />
          <Route path="/groups/:groupId" element={<div data-testid="group-detail-page">Group Detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )};
}

/** Navigate Step1 → Step2 → Step3 → Step4
 *  Uses a preview with one reEnroll member.
 */
async function advanceToStep4(reEnrollMembers: PreviewMember[] = [makeReEnrollMember()]) {
  mockGetPreview.mockResolvedValue(makePreviewWithReEnroll(reEnrollMembers));
  mockGetAvailableProducts.mockResolvedValue(makeProductsResponse() as any);
  mockApply.mockResolvedValue(makeApplyResult());

  const { qc } = renderWizard();

  // --- Step 1 → 2 ---
  await waitFor(() => {
    expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
  });
  await userEvent.click(screen.getByRole('button', { name: /next/i }));

  // --- Step 2: select product → Next ---
  await waitFor(() => {
    expect(screen.getByTestId('product-checkbox-p1')).toBeInTheDocument();
  });
  await userEvent.click(screen.getByTestId('product-checkbox-p1'));
  await userEvent.click(screen.getByTestId('step2-next'));

  // --- Step 3: confirm → Apply ---
  await waitFor(() => {
    expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
  });
  const checkbox = screen.getByTestId('confirm-understood');
  await userEvent.click(checkbox);
  await userEvent.click(screen.getByTestId('step3-apply'));

  // --- Wait for Step 4 ---
  await waitFor(() => {
    expect(screen.getByText(/send enrollment links/i)).toBeInTheDocument();
  });

  return { qc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupTypeChangeWizard — Step 4 (Links)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the list of reEnroll members', async () => {
    mockGetTemplates.mockResolvedValue(makeTemplatesResponse() as any);

    await advanceToStep4([
      makeReEnrollMember({ memberId: 'm1', displayName: 'Alice Alpha' }),
      makeReEnrollMember({ memberId: 'm2', displayName: 'Bob Beta' })
    ]);

    await waitFor(() => {
      expect(screen.getByText('Alice Alpha')).toBeInTheDocument();
      expect(screen.getByText('Bob Beta')).toBeInTheDocument();
    });
  });

  it('shows member count in the list header', async () => {
    mockGetTemplates.mockResolvedValue(makeTemplatesResponse() as any);

    await advanceToStep4([
      makeReEnrollMember({ memberId: 'm1', displayName: 'Alice Alpha' }),
      makeReEnrollMember({ memberId: 'm2', displayName: 'Bob Beta' })
    ]);

    await waitFor(() => {
      expect(screen.getByTestId('reenroll-member-list')).toHaveTextContent('2');
    });
  });

  it('renders the template dropdown with available templates', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([
        { TemplateId: 'tpl-1', TemplateName: 'Main Enrollment Template' },
        { TemplateId: 'tpl-2', TemplateName: 'Secondary Template' }
      ]) as any
    );

    await advanceToStep4();

    await waitFor(() => {
      expect(screen.getByTestId('step4-template-select')).toBeInTheDocument();
      expect(screen.getByText('Main Enrollment Template')).toBeInTheDocument();
      expect(screen.getByText('Secondary Template')).toBeInTheDocument();
    });
  });

  it('auto-selects when there is exactly one template (no dropdown shown, Send enabled)', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );

    await advanceToStep4();

    // Auto-select panel is shown instead of a dropdown
    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toHaveTextContent('Template One');
    });
    expect(screen.queryByTestId('step4-template-select')).not.toBeInTheDocument();

    // Send button is enabled immediately — no agent click required
    expect(screen.getByTestId('step4-send')).not.toBeDisabled();
  });

  it('Send button is disabled with multiple templates until one is selected', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([
        { TemplateId: 'tpl-1', TemplateName: 'Template One' },
        { TemplateId: 'tpl-2', TemplateName: 'Template Two' }
      ]) as any
    );

    await advanceToStep4();

    await waitFor(() => {
      expect(screen.getByTestId('step4-template-select')).toBeInTheDocument();
    });
    expect(screen.getByTestId('step4-send')).toBeDisabled();

    await userEvent.selectOptions(screen.getByTestId('step4-template-select'), 'tpl-1');
    expect(screen.getByTestId('step4-send')).not.toBeDisabled();
  });

  it('calls sendLinks with groupId, memberIds, and templateId (auto-selected)', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );
    mockSendLinks.mockResolvedValue(makeSendLinksResult({ sentCount: 1 }));

    await advanceToStep4([makeReEnrollMember({ memberId: 'member-reenroll-1' })]);

    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('step4-send'));

    await waitFor(() => {
      expect(mockSendLinks).toHaveBeenCalledWith(
        'group-123',
        ['member-reenroll-1'],
        'tpl-1'
      );
    });
  });

  it('advances to Step 5 on successful send', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );
    mockSendLinks.mockResolvedValue(makeSendLinksResult({ sentCount: 1 }));

    await advanceToStep4();

    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('step4-send'));

    await waitFor(() => {
      expect(screen.getByText(/conversion complete/i)).toBeInTheDocument();
    });
  });

  it('shows inline error and stays on Step 4 when sendLinks throws', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );
    mockSendLinks.mockRejectedValue(new Error('Network error sending links.'));

    await advanceToStep4();

    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('step4-send'));

    await waitFor(() => {
      expect(screen.getByTestId('step4-error')).toHaveTextContent(/network error/i);
      // Still on Step 4
      expect(screen.getByText(/send enrollment links/i)).toBeInTheDocument();
    });
  });

  // ---------- Continue without sending ----------

  it('shows a "Continue" button (no Send) when there are zero recipients', async () => {
    mockGetTemplates.mockResolvedValue(makeTemplatesResponse([]) as any);

    // No reEnroll, no letFinish — happens on the reverse direction (every
    // member's enrollments are already cancelled by an earlier conversion)
    // or on a fresh group with no enrollments yet.
    await advanceToStep4([]);

    await waitFor(() => {
      expect(screen.getByTestId('step4-continue')).toBeInTheDocument();
    });

    // Send button is not rendered at all when there's nothing to send.
    expect(screen.queryByTestId('step4-send')).not.toBeInTheDocument();
    // Continue is the primary action — its label is just "Continue".
    expect(screen.getByTestId('step4-continue')).toHaveTextContent(/continue/i);
    expect(screen.getByTestId('step4-continue')).not.toHaveTextContent(/without sending/i);
  });

  it('Continue advances to Step 5 with sentCount=0, no API call', async () => {
    mockGetTemplates.mockResolvedValue(makeTemplatesResponse([]) as any);

    await advanceToStep4([]);

    await waitFor(() => {
      expect(screen.getByTestId('step4-continue')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('step4-continue'));

    await waitFor(() => {
      expect(screen.getByText(/conversion complete/i)).toBeInTheDocument();
    });
    expect(mockSendLinks).not.toHaveBeenCalled();
    // Summary shows 0 links sent.
    expect(screen.getByTestId('summary-links-sent')).toHaveTextContent('0');
  });

  it('shows BOTH Send and "Continue without sending" when there ARE recipients', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );

    await advanceToStep4([makeReEnrollMember()]);

    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toBeInTheDocument();
    });

    expect(screen.getByTestId('step4-send')).toBeInTheDocument();
    expect(screen.getByTestId('step4-continue')).toHaveTextContent(/continue without sending/i);
  });

  it('"Continue without sending" with recipients shows confirmation; "Skip anyway" advances with sentCount=0', async () => {
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );

    await advanceToStep4([makeReEnrollMember(), makeReEnrollMember({ memberId: 'm2', displayName: 'M2' })]);

    await waitFor(() => {
      expect(screen.getByTestId('step4-continue')).toBeInTheDocument();
    });

    // First click opens the skip-confirmation modal (recipients > 0).
    await userEvent.click(screen.getByTestId('step4-continue'));
    await waitFor(() => {
      expect(screen.getByTestId('step4-skip-confirm')).toBeInTheDocument();
    });
    expect(mockSendLinks).not.toHaveBeenCalled();

    // Confirm skip → advances to Step 5.
    await userEvent.click(screen.getByTestId('step4-skip-confirm-button'));

    await waitFor(() => {
      expect(screen.getByText(/conversion complete/i)).toBeInTheDocument();
    });
    expect(mockSendLinks).not.toHaveBeenCalled();
    expect(screen.getByTestId('summary-links-sent')).toHaveTextContent('0');
  });
});

describe('GroupTypeChangeWizard — Step 5 (Done)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Advance all the way to Step 5 */
  async function advanceToStep5(applyResult?: Partial<ApplyResult>, linksResult?: Partial<SendLinksResult>) {
    const fullApply = makeApplyResult(applyResult);
    const fullLinks = makeSendLinksResult(linksResult);

    mockGetPreview.mockResolvedValue(makePreviewWithReEnroll([makeReEnrollMember()]));
    mockGetAvailableProducts.mockResolvedValue(makeProductsResponse() as any);
    mockApply.mockResolvedValue(fullApply);
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );
    mockSendLinks.mockResolvedValue(fullLinks);

    renderWizard();

    // Step 1 → 2
    await waitFor(() => {
      expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2 → 3
    await waitFor(() => {
      expect(screen.getByTestId('product-checkbox-p1')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('product-checkbox-p1'));
    await userEvent.click(screen.getByTestId('step2-next'));

    // Step 3 → 4
    await waitFor(() => {
      expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('confirm-understood'));
    await userEvent.click(screen.getByTestId('step3-apply'));

    // Step 4 → 5 — single template auto-selects, no dropdown click needed
    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('step4-send'));

    await waitFor(() => {
      expect(screen.getByText(/conversion complete/i)).toBeInTheDocument();
    });
  }

  it('renders summary with correct counts from apply and sendLinks results', async () => {
    // The "Enrollments preserved" row was dropped along with the preserve
    // bucket; the summary now shows only termination / cancellation /
    // household-clear / links-sent counts.
    await advanceToStep5(
      {
        productsAdded: 2,
        enrollmentsTerminationScheduled: 0,
        enrollmentsCancelled: 4,
        householdIdsCleared: 3
      },
      { sentCount: 1 }
    );

    await waitFor(() => {
      expect(screen.getByTestId('summary-terminating')).toHaveTextContent('0');
      expect(screen.getByTestId('summary-cancelled')).toHaveTextContent('4');
      expect(screen.getByTestId('summary-ids-cleared')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-links-sent')).toHaveTextContent('1');
    });
    // Preserve row is gone — make sure we never accidentally re-add it.
    expect(screen.queryByTestId('summary-preserved')).not.toBeInTheDocument();
    expect(screen.queryByText(/enrollments preserved/i)).not.toBeInTheDocument();
  });

  it('shows the summary panel', async () => {
    await advanceToStep5();

    await waitFor(() => {
      expect(screen.getByTestId('step5-summary')).toBeInTheDocument();
      expect(screen.getByText(/active enrollments scheduled to terminate/i)).toBeInTheDocument();
      expect(screen.getByText(/pending enrollments cancelled/i)).toBeInTheDocument();
      expect(screen.getByText(/householdmemberids cleared/i)).toBeInTheDocument();
      expect(screen.getByText(/new enrollment links sent/i)).toBeInTheDocument();
    });
    // Preserve row is no longer rendered.
    expect(screen.queryByText(/enrollments preserved/i)).not.toBeInTheDocument();
  });

  it('"Back to group" CTA navigates to the group page', async () => {
    await advanceToStep5();

    const backBtn = screen.getByTestId('step5-back-to-group');
    await userEvent.click(backBtn);

    await waitFor(() => {
      expect(screen.getByTestId('group-detail-page')).toBeInTheDocument();
    });
  });

  it('"Back to group" CTA evicts group cache so destination page refetches fresh', async () => {
    // After a successful conversion, GroupType, GroupProducts, and member
    // enrollments have all changed server-side. The destination page must
    // NOT render the pre-wizard cache; otherwise an agent sees a stale
    // "Standard" badge / pre-conversion product list right after running a
    // ListBill conversion. We use removeQueries (synchronous evict) rather
    // than invalidateQueries (async stale-mark, allows brief stale render).
    mockGetPreview.mockResolvedValue(makePreviewWithReEnroll([makeReEnrollMember()]));
    mockGetAvailableProducts.mockResolvedValue(makeProductsResponse() as any);
    mockApply.mockResolvedValue(makeApplyResult());
    mockGetTemplates.mockResolvedValue(
      makeTemplatesResponse([{ TemplateId: 'tpl-1', TemplateName: 'Template One' }]) as any
    );
    mockSendLinks.mockResolvedValue(makeSendLinksResult());

    const { qc } = renderWizard();

    const removeSpy = vi.spyOn(qc, 'removeQueries');

    // Step 1 → 2
    await waitFor(() => {
      expect(screen.queryByText(/loading enrollment preview/i)).not.toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /next/i }));

    // Step 2 → 3
    await waitFor(() => {
      expect(screen.getByTestId('product-checkbox-p1')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('product-checkbox-p1'));
    await userEvent.click(screen.getByTestId('step2-next'));

    // Step 3 → 4
    await waitFor(() => {
      expect(screen.getByText(/confirm conversion/i)).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('confirm-understood'));
    await userEvent.click(screen.getByTestId('step3-apply'));

    // Step 4 → 5 — single template auto-selects, no dropdown click needed
    await waitFor(() => {
      expect(screen.getByTestId('step4-template-auto')).toBeInTheDocument();
    });
    await userEvent.click(screen.getByTestId('step4-send'));

    await waitFor(() => {
      expect(screen.getByTestId('step5-back-to-group')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByTestId('step5-back-to-group'));

    // All five group-scoped query keys must be evicted so the destination
    // page can't render stale data.
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['group', 'group-123'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['groupDetails', 'group-123'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['groupSetupStatus', 'group-123'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['groupProducts', 'group-123'] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ['groupContributions', 'group-123'] });
  });
});
