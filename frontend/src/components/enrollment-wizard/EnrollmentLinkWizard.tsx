// frontend/src/components/enrollment-wizard/EnrollmentLinkWizard.tsx
import { Activity, AlertTriangle, CheckCircle, Cross, Eye, FileText, Heart, Info, Phone } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useAvailableProductTypes } from '../../hooks/useAvailableProductTypes';
import { apiService } from '../../services/api.service';
import {
    CreateTemplateRequest,
    EnrollmentLinkTemplate,
    UpdateTemplateRequest
} from '../../services/enrollment-link-templates.service';
import { type LicenseValidationProduct } from './components/PerProductLicenseValidationSummary';
import BasicInfoStep from './steps/BasicInfoStep';
import CategoryStep from './steps/CategoryStep';
import ReviewStep from './steps/ReviewStep';
import { EnrollmentWizardData, WizardStep } from './types/wizard.types';

interface ProductCategory {
  id: WizardStep;
  label: string;
  productType: string;
  description: string;
  defaultPage: string;
  icon: React.ReactElement;
}

const PRODUCT_CATEGORIES: ProductCategory[] = [
  {
    id: 'healthcare',
    label: 'Healthcare',
    productType: 'Healthcare',
    description: 'Health insurance plans covering medical services',
    defaultPage: 'Healthcare Plans',
    icon: <Cross className="h-5 w-5" />
  },
  {
    id: 'dental',
    label: 'Dental',
    productType: 'Dental',
    description: 'Dental insurance plans for preventive and restorative care',
    defaultPage: 'Dental Plans',
    icon: <Activity className="h-5 w-5" />
  },
  {
    id: 'vision',
    label: 'Vision',
    productType: 'Vision',
    description: 'Vision insurance plans covering eye exams and eyewear',
    defaultPage: 'Vision Plans',
    icon: <Eye className="h-5 w-5" />
  },
  {
    id: 'life',
    label: 'Life Insurance',
    productType: 'Life Insurance',
    description: 'Life insurance policies for financial protection',
    defaultPage: 'Life Insurance',
    icon: <Heart className="h-5 w-5" />
  },
  {
    id: 'telemedicine',
    label: 'Telemedicine',
    productType: 'Telemedicine',
    description: 'Virtual healthcare consultation services',
    defaultPage: 'Telemedicine Services',
    icon: <Phone className="h-5 w-5" />
  },
  {
    id: 'other-products',
    label: 'Other Products',
    productType: 'Other',
    description: 'Additional coverage for specific medical events',
    defaultPage: 'Other Products',
    icon: <FileText className="h-5 w-5" />
  }
];

interface EnrollmentLinkWizardProps {
  template?: EnrollmentLinkTemplate;
  onSave: (formData: CreateTemplateRequest | UpdateTemplateRequest) => void;
  onCancel: () => void;
  onFixLicenses?: () => void;
  isEditing?: boolean;
  staticLinkMode?: boolean; // NEW: Indicates if wizard is in static link creation/edit mode
  marketingLinkMode?: boolean; // NEW: Indicates if wizard is in marketing link creation/edit mode
}

interface AgentLicenseValidationResponse {
  traceId?: string;
  validatedAt: string;
  totalProducts: number;
  unresolvedCount: number;
  allProductsValid: boolean;
  products: LicenseValidationProduct[];
}

interface StoredAgentLicenseValidation {
  userId?: string;
  tenantId?: string;
  summary: AgentLicenseValidationResponse;
  storedAt: string;
}

const AGENT_LICENSE_VALIDATION_STORAGE_KEY = 'agent-license-validation-summary-v1';

const createValidationTraceId = (): string => {
  if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const randomNibble = Math.floor(Math.random() * 16);
    const value = char === 'x' ? randomNibble : ((randomNibble & 0x3) | 0x8);
    return value.toString(16);
  });
};

const EnrollmentLinkWizard: React.FC<EnrollmentLinkWizardProps> = ({
  template,
  onSave,
  onCancel,
  onFixLicenses,
  isEditing = false,
  staticLinkMode = false,
  marketingLinkMode = false
}) => {
  const { user } = useAuth();
  const [currentStep, setCurrentStep] = useState<WizardStep>('basic-info');
  const [mustBeSoldWithByProductId, setMustBeSoldWithByProductId] = useState<Record<string, { mustBeSoldWithProductIds: string[]; mustBeSoldWithProductNames: string[] }>>({});
  const [licenseValidationSummary, setLicenseValidationSummary] = useState<AgentLicenseValidationResponse | null>(null);
  const [isLicenseValidationLoading, setIsLicenseValidationLoading] = useState(false);
  const [licenseValidationError, setLicenseValidationError] = useState<string | null>(null);
  const [licenseValidationRefreshToken, setLicenseValidationRefreshToken] = useState(0);
  const isLicenseValidationDebugEnabled = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('debug') === '1' || import.meta.env.DEV;
  }, []);
  
  console.log('🔍 EnrollmentLinkWizard props:', { template, isEditing, user: user?.currentRole });
  
  // Initialize wizard data
  // Store template for access to AgentName
  const [editingTemplate] = useState(template);
  
  const [wizardData, setWizardData] = useState<EnrollmentWizardData>(() => {
    if (template) {
      console.log('🔍 Editing template:', template);
      console.log('🔍 Template metadata:', template.LinkMetaData);
      console.log('🔍 Template AgentId:', template.AgentId);
      console.log('🔍 Template AgencyId:', template.AgencyId);
      console.log('🔍 Template AgentName:', template.AgentName);
      
      // Parse existing template data
      let parsedMetadata;
      try {
        parsedMetadata = JSON.parse(template.LinkMetaData);
        console.log('✅ Parsed metadata:', parsedMetadata);
      } catch (error) {
        console.error('❌ Error parsing metadata:', error);
        parsedMetadata = { household: {}, products: [] };
      }

      // Ensure we have the correct data structure
      const householdData = parsedMetadata.household || {};
      const productsData = parsedMetadata.products || [];

      console.log('🏠 Household data:', householdData);
      console.log('🛍️ Products data:', productsData);

      const templateGroupId = (template as any).GroupId;
      console.log('🔍 Template GroupId:', templateGroupId, 'Type:', typeof templateGroupId);
      // Normalize template type (list/API may return TemplateType or templateType; ensure 'Group'|'Individual')
      const rawType = (template as any).TemplateType ?? (template as any).templateType ?? '';
      const normalizedTemplateType: 'Individual' | 'Group' =
        rawType === 'Group' || String(rawType).toLowerCase() === 'group' ? 'Group' : 'Individual';

      return {
        templateName: template.TemplateName || '',
        templateType: normalizedTemplateType,
        description: template.Description || '',
        tenantId: template.TenantId || '',
        agentId: template.AgentId || template.AgencyId || '', // Load AgencyId if AgentId is empty
        groupId: templateGroupId || '', // Load GroupId for Group templates (null/undefined becomes '')
        household: {
          collectSSN: true, // Always collect SSN
          collectDOB: householdData.collectDOB || false,
          collectGender: householdData.collectGender || false,
          collectAddress: householdData.collectAddress || false,
          collectPhone: householdData.collectPhone || false,
        },
        products: productsData.map((p: any, index: number) => ({
          id: `product-${index}`,
          page: p.page || '',
          productType: p.productType || '',
          description: p.description || '',
          specificProducts: p.specificProducts || [],
          includeAllProducts: p.includeAllProducts !== false,
          specificBundles: p.specificBundles || [],
          includeAllBundles: p.includeAllBundles || false,
          sectionType: p.sectionType || 'products'
        }))
      };
    }

    // Default data for new templates with Healthcare section by default
    console.log('🔍 Initializing new template with role:', user?.currentRole, 'tenantId:', user?.tenantId);
    
    return {
      templateName: '',
      templateType: marketingLinkMode ? 'Individual' : 'Individual',
      description: '',
      tenantId: user?.currentTenantId || user?.tenantId || '',
      agentId: '',
      household: {
        collectSSN: true, // Always collect SSN
        collectDOB: false,
        collectGender: false,
        collectAddress: false,
        collectPhone: false,
      },
      products: [
        // Default Healthcare section
        {
          id: 'default-healthcare',
          page: 'Healthcare Plans',
          productType: 'Healthcare',
          description: 'Select from available healthcare insurance options',
          specificProducts: [],
          includeAllProducts: false,
          sectionType: 'products'
        }
      ],
      touched: {
        templateName: false,
        templateType: false,
        tenantId: false,
        agentId: false,
      }
    };
  });

  // Sync wizard tenant with multi-tenant context (currentTenantId)
  useEffect(() => {
    const active = user?.currentTenantId || user?.tenantId;
    if ((user?.currentRole === 'TenantAdmin' || user?.currentRole === 'Agent') && active && !template) {
      console.log('Updating wizard tenantId from active context:', active);
      setWizardData(prev => ({ ...prev, tenantId: active }));
    }
  }, [user?.currentRole, user?.tenantId, user?.currentTenantId, template]);

  // Load mustBeSoldWith map for template flow warning under products
  useEffect(() => {
    const tenantId = wizardData.tenantId;
    if (!tenantId) {
      setMustBeSoldWithByProductId({});
      return;
    }
    let cancelled = false;
    const run = async () => {
      try {
        let list: any[] = [];
        if (user?.currentRole === 'SysAdmin') {
          const res = await apiService.get<{ success: boolean; data: any[] }>(`/api/tenants/${tenantId}/products`);
          if (res?.success && Array.isArray(res.data)) list = res.data;
        } else {
          const res = await apiService.get<{ success: boolean; data: any[] }>('/api/me/tenant-admin/my-products?filter=all');
          if (res?.success && Array.isArray(res.data)) list = res.data;
        }
        if (cancelled) return;
        const map: Record<string, { mustBeSoldWithProductIds: string[]; mustBeSoldWithProductNames: string[] }> = {};
        list.forEach((p: any) => {
          const id = p.ProductId ?? p.productId;
          if (!id) return;
          const ids = p.mustBeSoldWithProductIds ?? p.MustBeSoldWithProductIds;
          const names = p.mustBeSoldWithProductNames ?? p.MustBeSoldWithProductNames;
          const arrIds = Array.isArray(ids) ? ids : [];
          const arrNames = Array.isArray(names) ? names : [];
          if (arrIds.length > 0) map[String(id)] = { mustBeSoldWithProductIds: arrIds, mustBeSoldWithProductNames: arrNames };
        });
        setMustBeSoldWithByProductId(map);
      } catch (e) {
        if (!cancelled) setMustBeSoldWithByProductId({});
      }
    };
    run();
    return () => { cancelled = true; };
  }, [wizardData.tenantId, user?.currentRole]);

  const isAgentRole = user?.currentRole === 'Agent';

  const hasAnyProductSelection = useMemo(() => {
    return wizardData.products.some((section) =>
      section.includeAllProducts === true ||
      section.includeAllBundles === true ||
      (Array.isArray(section.specificProducts) && section.specificProducts.length > 0) ||
      (Array.isArray(section.specificBundles) && section.specificBundles.length > 0)
    );
  }, [wizardData.products]);

  useEffect(() => {
    if (!isAgentRole || !user?.userId) {
      setLicenseValidationSummary(null);
      setLicenseValidationError(null);
      return;
    }

    try {
      const raw = window.localStorage.getItem(AGENT_LICENSE_VALIDATION_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredAgentLicenseValidation;
      if (!parsed?.summary) return;
      if (parsed.userId && parsed.userId !== user.userId) return;
      if (parsed.tenantId && user.tenantId && parsed.tenantId !== user.tenantId) return;
      setLicenseValidationSummary(parsed.summary);
    } catch (_) {
      // Ignore malformed storage payloads
    }
  }, [isAgentRole, user?.userId, user?.tenantId]);

  useEffect(() => {
    if (!isAgentRole) return;

    const handleRevalidate = () => {
      setLicenseValidationRefreshToken((prev) => prev + 1);
    };

    window.addEventListener('agent-validation-revalidate', handleRevalidate);
    return () => {
      window.removeEventListener('agent-validation-revalidate', handleRevalidate);
    };
  }, [isAgentRole]);

  useEffect(() => {
    if (!isAgentRole) return;

    if (!hasAnyProductSelection) {
      setLicenseValidationSummary(null);
      setLicenseValidationError(null);
      setIsLicenseValidationLoading(false);
      window.localStorage.removeItem(AGENT_LICENSE_VALIDATION_STORAGE_KEY);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(async () => {
      let requestTraceId = '';
      try {
        setIsLicenseValidationLoading(true);
        setLicenseValidationError(null);

        requestTraceId = createValidationTraceId();
        const payload = {
          traceId: requestTraceId,
          templateType: wizardData.templateType,
          linkMetaData: {
            household: wizardData.household,
            products: wizardData.products
          }
        };

        if (isLicenseValidationDebugEnabled) {
          console.info('[AGENT-LICENSE-VALIDATION][CLIENT] request', {
            traceId: requestTraceId,
            templateType: wizardData.templateType,
            productSections: wizardData.products.map((section) => ({
              productType: section.productType,
              sectionType: section.sectionType,
              includeAllProducts: section.includeAllProducts === true,
              includeAllBundles: section.includeAllBundles === true,
              specificProductsCount: Array.isArray(section.specificProducts) ? section.specificProducts.length : 0,
              specificBundlesCount: Array.isArray(section.specificBundles) ? section.specificBundles.length : 0
            }))
          });
        }

        const response = await apiService.post<{
          success: boolean;
          data?: AgentLicenseValidationResponse;
          message?: string;
          traceId?: string;
        }>('/api/me/agent/licenses/validate-products', payload, {
          headers: {
            'x-trace-id': requestTraceId
          }
        });

        if (cancelled) return;

        if (!response?.success || !response.data) {
          throw new Error(response?.message || 'Failed to validate licenses for selected products.');
        }

        setLicenseValidationSummary(response.data);

        if (isLicenseValidationDebugEnabled) {
          console.info('[AGENT-LICENSE-VALIDATION][CLIENT] response', {
            requestedTraceId: requestTraceId,
            responseTraceId: response?.data?.traceId || response?.traceId || null,
            totalProducts: response.data.totalProducts,
            unresolvedCount: response.data.unresolvedCount,
            allProductsValid: response.data.allProductsValid,
            products: (response.data.products || []).map((item) => ({
              productId: item.productId,
              productName: item.productName,
              productType: item.productType,
              requiredLicenses: item.requiredLicenses,
              missingLicenses: item.missingLicenses,
              isValid: item.isValid
            }))
          });
        }

        const unresolvedCount = response.data.unresolvedCount || 0;
        if (unresolvedCount > 0) {
          const toStore: StoredAgentLicenseValidation = {
            userId: user?.userId,
            tenantId: user?.tenantId,
            summary: response.data,
            storedAt: new Date().toISOString()
          };
          window.localStorage.setItem(AGENT_LICENSE_VALIDATION_STORAGE_KEY, JSON.stringify(toStore));
        } else {
          window.localStorage.removeItem(AGENT_LICENSE_VALIDATION_STORAGE_KEY);
        }
      } catch (error: any) {
        if (cancelled) return;
        if (isLicenseValidationDebugEnabled) {
          console.error('[AGENT-LICENSE-VALIDATION][CLIENT] error', {
            traceId: requestTraceId || null,
            message: error?.message || 'License validation failed.'
          });
        }
        setLicenseValidationError(error?.message || 'License validation failed.');
      } finally {
        if (!cancelled) {
          setIsLicenseValidationLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [
    isAgentRole,
    user?.userId,
    user?.tenantId,
    wizardData.templateType,
    wizardData.household,
    wizardData.products,
    hasAnyProductSelection,
    licenseValidationRefreshToken,
    isLicenseValidationDebugEnabled
  ]);

  const unresolvedLicenseProducts = useMemo(() => {
    return (licenseValidationSummary?.products || []).filter((item) => !item.isValid);
  }, [licenseValidationSummary]);

  const hasLicenseValidationIssues = isAgentRole && unresolvedLicenseProducts.length > 0;
  const isCreateBlockedByLicenseValidation = isAgentRole && (
    isLicenseValidationLoading ||
    hasLicenseValidationIssues ||
    !!licenseValidationError
  );

  // Fetch available product types for the tenant, filtered by template type
  const { data: availableProductTypes = [] } = useAvailableProductTypes(wizardData.tenantId, wizardData.templateType);

  // Build wizard steps dynamically based on available products
  const WIZARD_STEPS = useMemo(() => {
    const steps: { id: WizardStep; title: string; icon: React.ReactElement; productCount?: number }[] = [
      { id: 'basic-info', title: 'Basic Info', icon: <Info className="h-4 w-4" /> }
    ];

    // Show a category step when: (1) there are available products for that type, OR
    // (2) the template already has a section for that type (e.g. editing a group template, or default Healthcare).
    // This ensures group templates and edit flows always show their product sections.
    PRODUCT_CATEGORIES.forEach(category => {
      const hasAvailableProducts = availableProductTypes.some(pt => pt.productType === category.productType && pt.count > 0);
      const hasSelectedProducts = wizardData.products.some(p => p.productType === category.productType);
      
      if (hasAvailableProducts || hasSelectedProducts) {
        // Get the section for this category and count selected products
        const section = wizardData.products.find(p => p.productType === category.productType);
        const productCount = section?.specificProducts?.length || 0;
        
        steps.push({
          id: category.id,
          title: category.label,
          icon: category.icon,
          productCount
        });
      }
    });

    steps.push({ id: 'review', title: 'Review', icon: <CheckCircle className="h-4 w-4" /> });

    return steps;
  }, [availableProductTypes, wizardData.products]);

  const handleDataChange = (updates: Partial<EnrollmentWizardData>) => {
    setWizardData(prev => ({ ...prev, ...updates }));
  };

  const getCurrentStepIndex = () => {
    return WIZARD_STEPS.findIndex(step => step.id === currentStep);
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    const newStep = WIZARD_STEPS[newValue].id;
    // Only allow navigation to valid steps
    if (canNavigateToStep(newStep)) {
      setCurrentStep(newStep);
    }
  };

  const canNavigateToStep = (targetStep: WizardStep): boolean => {
    const targetIndex = WIZARD_STEPS.findIndex(step => step.id === targetStep);
    const currentIndex = getCurrentStepIndex();
    
    // Can always go to current or previous steps
    if (targetIndex <= currentIndex) return true;
    
    // Can go to next step if current step is valid
    if (targetIndex === currentIndex + 1 && isStepValid(currentStep)) return true;
    
    return false;
  };

  const isStepValid = (step: WizardStep): boolean => {
    switch (step) {
      case 'basic-info': {
        const nameOk = wizardData.templateName.trim().length > 0;
        const role = user?.currentRole;
        const agentOk = !wizardData.agencyHasNoAgent; // In marketing/static mode, agency must have an assigned agent
        if (role === 'SysAdmin') {
          return nameOk && !!wizardData.tenantId && !!wizardData.agentId && agentOk;
        }
        if (role === 'TenantAdmin') {
          return nameOk && !!wizardData.agentId && agentOk;
        }
        return nameOk && agentOk; // Agent role auto-selects
      }
      case 'healthcare':
      case 'dental':
      case 'vision':
      case 'life':
      case 'telemedicine':
      case 'supplemental':
      case 'other-products':
        // Category steps are always valid - users can select 0 or more products
        return true;
      case 'review':
        // Review step is always valid - users can select any combination of products
        return true;
      default:
        return false;
    }
  };

  const handleFinish = () => {
    // Convert wizard data to the format expected by the API
    const linkMetaData = JSON.stringify({
      household: wizardData.household,
      products: wizardData.products.map(({ id, ...product }) => ({
        ...product,
        // Handle product selection
        ...(product.sectionType === 'products' && {
          // Only include specific product selection if not including all products
          ...(product.includeAllProducts === false && {
            specificProducts: product.specificProducts || [],
            includeAllProducts: false
          }),
          // If including all products, don't include the specific products array
          ...(product.includeAllProducts === true && {
            includeAllProducts: true
          })
        }),
        // Handle bundle selection
        ...(product.sectionType === 'bundles' && {
          // Only include specific bundle selection if not including all bundles
          ...(product.includeAllBundles === false && {
            specificBundles: product.specificBundles || [],
            includeAllBundles: false
          }),
          // If including all bundles, don't include the specific bundles array
          ...(product.includeAllBundles === true && {
            includeAllBundles: true
          })
        })
      }))
    });

    const submitData: CreateTemplateRequest | UpdateTemplateRequest = {
      templateName: wizardData.templateName,
      templateType: wizardData.templateType,
      linkMetaData,
      description: wizardData.description || undefined,
      ...(user?.currentRole === 'SysAdmin' && { tenantId: wizardData.tenantId }),
      ...((['SysAdmin', 'TenantAdmin', 'Agent'] as string[]).includes(user?.currentRole || '') && { agentId: wizardData.agentId || '' }),
      // For Group templates, always include groupId (backend will convert empty string to null)
      ...(wizardData.templateType === 'Group' && { groupId: wizardData.groupId }),
      ...(isEditing && { isActive: template?.IsActive !== false })
    };

    console.log('🔍 Submitting enrollment link template data:', {
      templateType: submitData.templateType,
      groupId: (submitData as any).groupId,
      hasGroupId: 'groupId' in submitData,
      wizardDataGroupId: wizardData.groupId,
      wizardDataType: typeof wizardData.groupId
    });

    onSave(submitData);
  };

  const renderStepContent = (stepIndex: number) => {
    const step = WIZARD_STEPS[stepIndex];
    const commonProps = {
      data: wizardData,
      onDataChange: handleDataChange,
      onNext: () => {},
      onPrevious: () => {},
      isValid: isStepValid(step.id),
      isFirstStep: stepIndex === 0,
      isLastStep: stepIndex === WIZARD_STEPS.length - 1,
      editingAgentName: editingTemplate?.AgentName
    };

    // Handle basic info and review steps
    if (step.id === 'basic-info') {
      return <BasicInfoStep {...commonProps} staticLinkMode={staticLinkMode} marketingLinkMode={marketingLinkMode} />;
    }
    
    if (step.id === 'review') {
      return <ReviewStep {...commonProps} staticLinkMode={staticLinkMode} />;
    }

    // Handle category steps (medical, dental, vision, etc.)
    const category = PRODUCT_CATEGORIES.find(cat => cat.id === step.id);
    if (category) {
      return (
        <CategoryStep
          {...commonProps}
          categoryId={category.id}
          categoryLabel={category.label}
          categoryEmoji=""
          categoryDescription={category.description}
          productType={category.productType}
          defaultPage={category.defaultPage}
          availableProductTypes={availableProductTypes}
          tenantId={wizardData.tenantId}
          groupId={wizardData.groupId}
          mustBeSoldWithByProductId={mustBeSoldWithByProductId}
          licenseValidationProducts={licenseValidationSummary?.products || []}
          isLicenseValidationLoading={isLicenseValidationLoading}
          onFixLicenses={onFixLicenses}
        />
      );
    }

    return null;
  };

  const currentStepIndex = getCurrentStepIndex();
  const canSubmitEnrollmentLink = isStepValid(currentStep) && !isCreateBlockedByLicenseValidation;

  return (
    <div className="w-full">
      <div className="bg-white rounded-lg border border-gray-200 overflow-visible">
        <div className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
          <div className="flex overflow-x-auto">
            {WIZARD_STEPS.map((step, index) => {
              const isActive = currentStepIndex === index;
              const isEnabled = canNavigateToStep(step.id);
              return (
                <button
                  key={step.id}
                  onClick={() => isEnabled && handleTabChange({} as any, index)}
                  className={
                    'flex items-center gap-2 px-4 py-4 text-sm whitespace-nowrap border-r border-gray-200 ' +
                    (isActive ? 'font-semibold text-oe-primary bg-white' : 'text-gray-600 hover:text-gray-900') + ' ' +
                    (!isEnabled ? 'opacity-60 cursor-not-allowed' : '')
                  }
                  aria-controls={`wizard-tabpanel-${index}`}
                  aria-selected={isActive}
                >
                  {step.icon}
                  <span>
                    {step.title}
                    {step.productCount !== undefined && step.productCount > 0 && (
                      <span className="ml-1 text-gray-500">({step.productCount})</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-6">
          {renderStepContent(currentStepIndex)}
        </div>
      </div>

      <div className="sticky bottom-0 bg-white border-t border-gray-200 mt-4 py-4 flex items-center justify-between">
        <button
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
        >
          Cancel
        </button>

        <div className="flex items-center gap-2">
          {currentStepIndex > 0 && (
            <button
              onClick={() => {
                const prevIndex = currentStepIndex - 1;
                setCurrentStep(WIZARD_STEPS[prevIndex].id);
              }}
              className="px-4 py-2 border border-oe-primary text-oe-primary rounded-lg text-sm font-medium hover:bg-blue-50"
            >
              Previous
            </button>
          )}

          {currentStepIndex < WIZARD_STEPS.length - 1 ? (
            <button
              onClick={() => {
                const nextIndex = currentStepIndex + 1;
                setCurrentStep(WIZARD_STEPS[nextIndex].id);
              }}
              disabled={!isStepValid(currentStep)}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-oe-primary hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next
            </button>
          ) : (
            <button
              onClick={handleFinish}
              disabled={!canSubmitEnrollmentLink}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {staticLinkMode 
                ? (isEditing ? 'Update Static Link' : 'Create Static Link')
                : (isEditing ? 'Update Enrollment Link' : 'Create Enrollment Link')
              }
            </button>
          )}
        </div>
      </div>

      {isAgentRole && (
        <div className="mt-2">
          {!isLicenseValidationLoading && hasLicenseValidationIssues && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />

              <p className="text-sm font-medium">
                Resolve license validation issues before you can create this enrollment link.
              </p>
            </div>
          )}
          {!isLicenseValidationLoading && !hasLicenseValidationIssues && licenseValidationError && (
            <p className="text-sm text-red-700">
              Unable to validate licenses right now: {licenseValidationError}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default EnrollmentLinkWizard;
