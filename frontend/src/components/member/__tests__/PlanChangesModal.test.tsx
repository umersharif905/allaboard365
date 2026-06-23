import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemberEnrollmentService } from '../../../services/member/member-enrollments.service';
import { useMemberPricing } from '../../../hooks/useMemberPricing';
import { usePricingSimulation } from '../../../hooks/usePricingSimulation';
import PlanChangesModal from '../PlanChangesModal';

vi.mock('../../../services/member/member-enrollments.service', () => ({
  MemberEnrollmentService: {
    getAvailableProducts: vi.fn(),
    submitPlanChangesRequest: vi.fn(),
  },
}));

vi.mock('../../../hooks/useMemberPricing');
vi.mock('../../../hooks/usePricingSimulation');

const mockGetAvailableProducts = vi.mocked(MemberEnrollmentService.getAvailableProducts);
const mockSubmitPlanChangesRequest = vi.mocked(MemberEnrollmentService.submitPlanChangesRequest);
const mockUseMemberPricing = vi.mocked(useMemberPricing);
const mockUsePricingSimulation = vi.mocked(usePricingSimulation);

const mockEnrollment = {
  enrollmentId: 'ENROLLMENT123',
  memberId: 'MEMBER123',
  productId: 'PRODUCT123',
  status: 'Active' as const,
  effectiveDate: '2024-01-01',
  premiumAmount: 150.00,
  paymentFrequency: 'Monthly',
  enrollmentDetails: 'Test enrollment',
  createdDate: '2024-01-01',
  modifiedDate: '2024-01-01',
  product: {
    productId: 'PRODUCT123',
    name: 'Premium Health Plan',
    description: 'A comprehensive health plan',
    productType: 'Healthcare',
    productImageUrl: 'https://example.com/image.png',
    productLogoUrl: 'https://example.com/logo.png',
    productDocumentUrl: 'https://example.com/document.pdf',
    coverageDetails: 'Full coverage',
    features: ['Feature 1', 'Feature 2'],
    productOwnerName: 'Health Insurance Co',
    productOwnerEmail: 'contact@healthco.com',
    idCardData: null,
    requiredDataFields: [
      {
        fieldName: 'Deductible',
        fieldType: 'dropdown',
        fieldOptions: ['Low', 'Medium', 'High'],
        currentValue: 'Medium'
      },
      {
        fieldName: 'Coverage Level',
        fieldType: 'dropdown',
        fieldOptions: ['Basic', 'Standard', 'Premium'],
        currentValue: 'Standard'
      }
    ]
  },
  memberName: 'John Doe'
};

const mockAvailableProducts = [
  {
    productId: 'PRODUCT456',
    name: 'Dental Plan',
    description: 'Dental coverage',
    productType: 'Dental',
    basePrice: 25.00,
    canEnroll: true,
    features: [],
    allowedStates: ['CA', 'NY'],
    minAge: 18,
    maxAge: 65,
    salesType: 'Individual',
    requiresTobaccoInfo: false,
    effectiveDateLogic: 'Flexible',
    maxEffectiveDateDays: 90,
    requiredLicenses: [],
    requiredDataFields: [],
    acknowledgementQuestions: [],
    isEnrolled: false
  },
  {
    productId: 'PRODUCT789',
    name: 'Vision Plan',
    description: 'Vision coverage',
    productType: 'Vision',
    basePrice: 15.00,
    canEnroll: true,
    features: [],
    allowedStates: ['CA', 'NY'],
    minAge: 18,
    maxAge: 65,
    salesType: 'Individual',
    requiresTobaccoInfo: false,
    effectiveDateLogic: 'Flexible',
    maxEffectiveDateDays: 90,
    requiredLicenses: [],
    requiredDataFields: [],
    acknowledgementQuestions: [],
    isEnrolled: false
  }
];

const mockCurrentPricing = {
  products: [{
    productId: 'PRODUCT123',
    hasConfigurationFields: true,
    requiredDataFields: [
      {
        fieldName: 'Deductible',
        fieldType: 'dropdown',
        options: ['Low', 'Medium', 'High'],
        currentValue: 'Medium'
      },
      {
        fieldName: 'Coverage Level',
        fieldType: 'dropdown',
        options: ['Basic', 'Standard', 'Premium'],
        currentValue: 'Standard'
      }
    ]
  }],
  totals: { totalPremium: 150 }
};

const defaultProps = {
  enrollment: mockEnrollment,
  isOpen: true,
  onClose: vi.fn(),
  onSaveChanges: vi.fn().mockResolvedValue(undefined)
};

describe('PlanChangesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseMemberPricing.mockReturnValue({
      data: mockCurrentPricing,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useMemberPricing>);

    mockUsePricingSimulation.mockReturnValue({
      data: { totals: { totalPremium: 175 } },
      isLoading: false,
      error: null,
    } as ReturnType<typeof usePricingSimulation>);

    mockGetAvailableProducts.mockResolvedValue({
      success: true,
      data: mockAvailableProducts
    });

    mockSubmitPlanChangesRequest.mockResolvedValue({
      success: true,
      data: { changeRequestId: 'CHANGE123' }
    });
  });

  it('renders when isOpen is true', () => {
    render(<PlanChangesModal {...defaultProps} />);

    expect(screen.getByText('Make Changes to Premium Health Plan')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByText('Add/Remove Products')).toBeInTheDocument();
    expect(screen.getByText('Summary')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<PlanChangesModal {...defaultProps} isOpen={false} />);

    expect(screen.queryByText('Make Changes to Premium Health Plan')).not.toBeInTheDocument();
  });

  it('loads and displays configuration fields', async () => {
    render(<PlanChangesModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText('Deductible')).toBeInTheDocument();
      expect(screen.getByText('Coverage Level')).toBeInTheDocument();
    });
  });

  it('allows changing configuration field values', async () => {
    render(<PlanChangesModal {...defaultProps} />);

    await waitFor(() => {
      const deductibleSelect = screen.getByDisplayValue('Medium');
      fireEvent.change(deductibleSelect, { target: { value: 'High' } });

      expect(deductibleSelect).toHaveValue('High');
    });
  });

  it('switches between tabs correctly', () => {
    render(<PlanChangesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Add/Remove Products'));

    expect(screen.getByText('Add Products')).toBeInTheDocument();
    expect(screen.getByText('Remove Products')).toBeInTheDocument();
  });

  it('loads available products for adding', async () => {
    render(<PlanChangesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Add/Remove Products'));

    await waitFor(() => {
      expect(screen.getByText('Dental Plan')).toBeInTheDocument();
      expect(screen.getByText('Vision Plan')).toBeInTheDocument();
    });
  });

  it('allows adding products', async () => {
    render(<PlanChangesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Add/Remove Products'));

    await waitFor(() => {
      const addButtons = screen.getAllByText('Add');
      fireEvent.click(addButtons[0]);
    });

    fireEvent.click(screen.getByText('Summary'));

    await waitFor(() => {
      expect(screen.getByText('Products to Add:')).toBeInTheDocument();
    });
  });

  it('allows removing the current product', () => {
    render(<PlanChangesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Add/Remove Products'));

    const removeButton = screen.getByText('Remove');
    fireEvent.click(removeButton);

    fireEvent.click(screen.getByText('Summary'));

    expect(screen.getByText('Products to Remove:')).toBeInTheDocument();
  });

  it('displays pricing impact when configuration changes', async () => {
    render(<PlanChangesModal {...defaultProps} />);

    await waitFor(() => {
      const deductibleSelect = screen.getByDisplayValue('Medium');
      fireEvent.change(deductibleSelect, { target: { value: 'High' } });
    });

    await waitFor(() => {
      expect(screen.getByText('Pricing Impact')).toBeInTheDocument();
      expect(screen.getByText('+$25.00/month')).toBeInTheDocument();
    });
  });

  it('submits plan changes request successfully', async () => {
    const onSaveChanges = vi.fn().mockResolvedValue(undefined);
    render(<PlanChangesModal {...defaultProps} onSaveChanges={onSaveChanges} />);

    await waitFor(() => {
      const deductibleSelect = screen.getByDisplayValue('Medium');
      fireEvent.change(deductibleSelect, { target: { value: 'High' } });
    });

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(mockSubmitPlanChangesRequest).toHaveBeenCalledWith({
        enrollmentId: 'ENROLLMENT123',
        configFieldChanges: { 'Deductible': 'High' },
        addProducts: [],
        removeProducts: [],
        effectiveDate: undefined
      });
    });

    await waitFor(() => {
      expect(onSaveChanges).toHaveBeenCalled();
      expect(defaultProps.onClose).toHaveBeenCalled();
    });
  });

  it('handles API errors gracefully', async () => {
    mockSubmitPlanChangesRequest.mockResolvedValue({
      success: false,
      message: 'Failed to submit changes',
      data: null
    });

    render(<PlanChangesModal {...defaultProps} />);

    await waitFor(() => {
      const deductibleSelect = screen.getByDisplayValue('Medium');
      fireEvent.change(deductibleSelect, { target: { value: 'High' } });
    });

    fireEvent.click(screen.getByText('Save Changes'));

    await waitFor(() => {
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  it('disables save button when no changes are made', () => {
    render(<PlanChangesModal {...defaultProps} />);

    const saveButton = screen.getByText('Save Changes');
    expect(saveButton).toBeDisabled();
  });

  it('enables save button when changes are made', async () => {
    render(<PlanChangesModal {...defaultProps} />);

    await waitFor(() => {
      const deductibleSelect = screen.getByDisplayValue('Medium');
      fireEvent.change(deductibleSelect, { target: { value: 'High' } });
    });

    const saveButton = screen.getByText('Save Changes');
    expect(saveButton).not.toBeDisabled();
  });

  it('calls onClose when cancel button is clicked', () => {
    render(<PlanChangesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('displays effective date input in summary tab', () => {
    render(<PlanChangesModal {...defaultProps} />);

    fireEvent.click(screen.getByText('Summary'));

    expect(screen.getByText('Effective Date (Optional)')).toBeInTheDocument();
  });

  it('handles products without configuration fields', () => {
    mockUseMemberPricing.mockReturnValue({
      data: {
        products: [{
          productId: 'PRODUCT123',
          hasConfigurationFields: false,
          requiredDataFields: []
        }],
        totals: { totalPremium: 150 }
      },
      isLoading: false,
      error: null,
    } as ReturnType<typeof useMemberPricing>);

    render(<PlanChangesModal {...defaultProps} />);

    expect(screen.getByText('No configuration fields available for this product.')).toBeInTheDocument();
  });
});

