import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Eye, FileText, Info, Loader2, Star, Undo2, Users, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { US_STATES_FORMATTED } from '../../components/common/geographic-data';
import { DetectedCardBrandLine } from '../../components/payment/DetectedCardBrandLine';
import ContributionBreakdown from '../../components/enrollment-wizard/ContributionBreakdown';
import EnrollmentCompletionWizard from '../../components/shared/EnrollmentCompletionWizard';
import ProductInfoModal from '../../components/shared/ProductInfoModal';
import { useGroupedMemberEnrollments } from '../../hooks/member/useMemberEnrollments';
import { useMemberHousehold } from '../../hooks/member/useMemberHousehold';
import { useAddPaymentMethod, useMemberPaymentMethods } from '../../hooks/member/useMemberPaymentMethods';
import { useMemberProfile } from '../../hooks/member/useMemberProfile';
import { useMemberPricing } from '../../hooks/useMemberPricing';
import { apiService } from '../../services/api.service';
import { ContributionCalculator } from '../../services/ContributionCalculator';
import { CreatePaymentMethodData } from '../../services/member-payment-methods.service';
import { MemberProductManagementService } from '../../services/member-product-management.service';
import { PricingService } from '../../services/pricing.service';
import { ProductChangesCompleteService, type ProductAcknowledgement } from '../../services/product-changes-complete.service';
import { getCardBrand } from '../../utils/payment-validation';

// Debug utility function (reusing existing pattern)
const isDebugMode = () => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('debug') === '1';
};

interface Product {
  productId: string;
  name: string;
  description: string;
  productType: string;
  productImageUrl: string;
  productLogoUrl: string;
  productDocumentUrl: string;
  basePrice: number;
  effectiveDateLogic: string;
  isEnrolled: boolean;
  canEnroll: boolean;
  isGroupAuthorized: boolean;
  requiredDataFields: Array<{
    id: string;
    fieldName: string;
    fieldOptions: string[];
  }>;
  acknowledgementQuestions: any[];
  existingEnrollmentId?: string;
  currentConfiguration?: string;
  currentPrice?: number;
  isBundle?: boolean;
  // Contribution-related fields
  monthlyPremium?: number;
  employerContribution?: number;
  employeeContribution?: number;
  contributionRules?: Array<{
    type: string;
    amount: number;
    description: string;
    appliesTo: string;
  }>;
  includedProducts?: Array<{
    productId: string;
    productName: string;
    description: string;
    productType: string;
    productDocumentUrl?: string;
    monthlyPremium: number;
    requiredDataFields?: Array<{
      id: string;
      fieldName: string;
      fieldOptions: string[];
    }>;
  }>;
}

interface MemberEnrollment {
  enrollmentId: string;
  memberId: string;
  productId: string;
  status: string;
  effectiveDate: string;
  terminationDate?: string;
  premiumAmount: number;
  paymentFrequency: string;
  enrollmentDetails: string;
  createdDate: string;
  modifiedDate: string;
  memberName: string;
  product: {
    productId: string;
    name: string;
    description: string;
    productType: string;
    productImageUrl: string;
    productLogoUrl: string;
    productDocumentUrl: string;
    coverageDetails: string;
    features: any[];
    productOwnerName: string;
    productOwnerEmail: string;
    idCardData: any;
  };
}

interface ProductChangePageProps {
  onClose?: () => void;
  memberId?: string; // Optional member ID for admin/agent use
  memberName?: string; // Member name for display when managing on behalf
  memberEmail?: string; // Member email for display when managing on behalf
}

const ProductChangePage: React.FC<ProductChangePageProps> = ({ onClose, memberId, memberName, memberEmail }) => {
  const navigate = useNavigate();
  
  // NOTE: memberId parameter allows admin/agent to modify plans on behalf of another member
  // Currently uses current user's profile hooks - future enhancement: pass memberId to hooks
  console.log('ProductChangePage: Managing products for member:', memberId || 'current user');
  
  // Check if managing on behalf of another member (admin/agent mode)
  const isManagingForMember = !!memberId && !!memberName;
  const [products, setProducts] = useState<Product[]>([]);
  const [enrollments, setEnrollments] = useState<MemberEnrollment[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  // Removed productsToRemove - no longer needed
  const [removedProducts, setRemovedProducts] = useState<string[]>([]); // Track removed products for undo
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [productPrices, setProductPrices] = useState<Record<string, number>>({});
  const [includedProductPrices, setIncludedProductPrices] = useState<Record<string, number>>({});
  const [currentTotal, setCurrentTotal] = useState(0);
  const [newTotal, setNewTotal] = useState(0);
  const [isPricingLoading, setIsPricingLoading] = useState(true);
  const [showRemoveConfirm, setShowRemoveConfirm] = useState<string | null>(null);
  const [initialSelectedProducts, setInitialSelectedProducts] = useState<string[]>([]);
  const [initialConfigValues, setInitialConfigValues] = useState<Record<string, string>>({});
  const [frontendPricing, setFrontendPricing] = useState<Array<{
    productId: string;
    productName: string;
    monthlyPremium: number;
    selectedConfig: string | null;
  }>>([]);
  const [showProductInfoModal, setShowProductInfoModal] = useState(false);
  const [selectedProductForInfo, setSelectedProductForInfo] = useState<Product | null>(null);
  const [showCompletionWizard, setShowCompletionWizard] = useState(false);
  const [productAcknowledgements, setProductAcknowledgements] = useState<ProductAcknowledgement[]>([]);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isGroupMember, setIsGroupMember] = useState(false);
  // Removed payment processing states - now only handling recurring payment setup
  // Removed acknowledgementsLoading - no longer needed
  const [showPdfModal, setShowPdfModal] = useState(false);
  // Contribution-related state
  // Removed allProductsRules - no longer needed
  const [selectedConfigs, setSelectedConfigs] = useState<Record<string, string>>({});
  // Payment method selection state (for completion wizard)
  const [availablePaymentMethods, setAvailablePaymentMethods] = useState<Array<{
    id: string;
    type: string;
    last4: string;
    cardBrand?: string;
    isDefault: boolean;
  }>>([]);
  const [selectedPaymentMethodId, setSelectedPaymentMethodId] = useState<string>('');
  const [showAddPaymentMethod, setShowAddPaymentMethod] = useState(false);
  const [paymentMethodLoading, setPaymentMethodLoading] = useState(false);
  
  // Auto-navigation trigger for wizard
  const [shouldAutoAdvance, setShouldAutoAdvance] = useState(false);
  
  // Payment method form state
  const [paymentMethodData, setPaymentMethodData] = useState<CreatePaymentMethodData>({
    paymentMethodType: 'CreditCard',
    cardNumber: '',
    expiryMonth: undefined,
    expiryYear: undefined,
    cvv: '',
    cardholderName: '',
    bankName: '',
    accountType: 'Checking',
    routingNumber: '',
    accountNumber: '',
    accountHolderName: '',
    billingAddress: '',
    billingAddress2: '',
    billingCity: '',
    billingState: '',
    billingZip: '',
    billingCountry: 'US',
    phoneNumber: '',
    isDefault: true
  });
  const [paymentMethodErrors, setPaymentMethodErrors] = useState<Record<string, string>>({});
  const [showCardNumber, setShowCardNumber] = useState(false);
  const [showAccountNumber, setShowAccountNumber] = useState(false);
  const [isUpdatingPayment, setIsUpdatingPayment] = useState(false);
  
  // Payment method hooks
  const { data: allPaymentMethods = [] } = useMemberPaymentMethods();
  const addPaymentMethodMutation = useAddPaymentMethod();

  const { data: householdData } = useMemberHousehold();
  const { profile: memberProfile } = useMemberProfile();
  const { data: pricingData } = useMemberPricing();
  const { data: groupedEnrollments } = useGroupedMemberEnrollments();
  
  // Get group contribution rules if member is part of a group
  const { data: groupContributionRules } = useQuery({
    queryKey: ['groupContributionRules', memberProfile?.groupId],
    queryFn: async () => {
      if (!memberProfile?.groupId) return null;
      const response = await apiService.get<{ success: boolean; data: any[] }>(`/api/groups/${memberProfile.groupId}/contributions`);
      return response.success ? response.data : [];
    },
    enabled: !!memberProfile?.groupId,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
  
  // Check if enrollment is for a future effective date (cannot be modified)
  const isFutureEnrollment = (productId: string): boolean => {
    const enrollment = groupedEnrollments?.find(ge => 
      (ge.type === 'bundle' && ge.bundleId === productId) ||
      (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
    );
    
    if (!enrollment) return false;
    
    const effectiveDate = enrollment.type === 'bundle' 
      ? enrollment.enrollments?.[0]?.effectiveDate
      : enrollment.primaryEnrollment?.effectiveDate;
    
    if (!effectiveDate) return false;
    
    const effective = new Date(effectiveDate);
    const today = new Date();
    effective.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    
    return effective > today;
  };

  // Check if there are any changes to enable/disable the submit button
  const hasChanges = () => {
    // Check if selected products have changed (excluding removed products from comparison)
    const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
    const selectedChanged = JSON.stringify(currentSelected.sort()) !== JSON.stringify(initialSelectedProducts.sort());
    
    // Check if any products are being removed
    const hasRemovals = removedProducts.length > 0;
    
    // Check if configuration values have changed
    const configChanged = Object.keys(configValues).some(key => {
      return configValues[key] !== initialConfigValues[key];
    });
    
    return selectedChanged || hasRemovals || configChanged;
  };

  useEffect(() => {
    loadData();
  }, []);

  // Update selected products when groupedEnrollments becomes available (fixes bundle selection on page refresh)
  useEffect(() => {
    if (groupedEnrollments && products.length > 0) {
      console.log('🔍 DEBUG: groupedEnrollments became available, updating selected products');
      
      const enrolledProductIds: string[] = [];
      
      groupedEnrollments.forEach(groupedEnrollment => {
        if (groupedEnrollment.status === 'Active') {
          if (groupedEnrollment.type === 'bundle' && groupedEnrollment.bundleId) {
            // For bundles, add the bundle product ID (not individual components)
            enrolledProductIds.push(groupedEnrollment.bundleId);
            console.log(`🔍 DEBUG: Updated - Added bundle product ID: ${groupedEnrollment.bundleId} (${groupedEnrollment.bundleName})`);
          } else if (groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment) {
            // For individual products, add the product ID
            enrolledProductIds.push(groupedEnrollment.primaryEnrollment.productId);
            console.log(`🔍 DEBUG: Updated - Added individual product ID: ${groupedEnrollment.primaryEnrollment.productId}`);
          }
        }
      });
      
      console.log('🔍 DEBUG: Updated enrolled product IDs from groupedEnrollments:', enrolledProductIds);
      
      // Only update if the selection has changed
      const currentSelection = selectedProducts.sort().join(',');
      const newSelection = enrolledProductIds.sort().join(',');
      
      if (currentSelection !== newSelection) {
        console.log('🔍 DEBUG: Selection changed, updating selectedProducts');
        setSelectedProducts(enrolledProductIds);
        setInitialSelectedProducts([...enrolledProductIds]);
      }
    }
  }, [groupedEnrollments, products]);

  // Calculate included product pricing when member profile, household data, or products change
  useEffect(() => {
    if (memberProfile && householdData && products.length > 0) {
      calculateIncludedProductPricing();
    }
  }, [memberProfile, householdData, products, configValues]);

  useEffect(() => {
    const calculatePrices = async () => {
      if (products.length > 0 && memberProfile && householdData) {
        setIsPricingLoading(true);
        const prices: Record<string, number> = {};
        for (const product of products) {
          // Use the default configuration value for initial pricing calculation
          const defaultConfigValue = product.requiredDataFields && product.requiredDataFields.length > 0 ? 
            product.requiredDataFields[0].fieldOptions[0] : 'Default';
          const price = await getProductPricing(product, defaultConfigValue);
          prices[product.productId] = price ?? 0; // Use 0 as fallback for loading state
        }
        setProductPrices(prices);
        setIsPricingLoading(false);
      }
    };
    calculatePrices();
  }, [products, pricingData, householdData, memberProfile, configValues]);

  useEffect(() => {
    const calculateTotals = async () => {
      const current = await getCurrentEnrollmentsTotalCost();
      const newTotal = await getSelectedProductsTotalCost();
      setCurrentTotal(current);
      setNewTotal(newTotal);
    };
    calculateTotals();
  }, [enrollments, selectedProducts, productPrices, groupedEnrollments, groupContributionRules, initialConfigValues, configValues]);

  // Calculate frontend pricing for validation
  useEffect(() => {
    const calculateFrontendPricing = async () => {
      if (selectedProducts.length > 0 && products.length > 0) {
        const pricing: Array<{
          productId: string;
          productName: string;
          monthlyPremium: number;
          selectedConfig: string | null;
        }> = [];

        for (const productId of selectedProducts) {
          // Skip products that are being removed
          if (removedProducts.includes(productId)) {
            continue;
          }
          
          const product = products.find(p => p.productId === productId);
          if (product) {
            let price;
            let selectedConfig = null;
            
            if (product.isBundle) {
              // For bundles, use the bundle total that accounts for configuration values
              price = getBundleTotalPrice(product);
              // For bundles, we don't have a single selectedConfig, so we'll use null
              selectedConfig = null;
            } else {
              // For individual products, use the calculated pricing
              price = await getProductPricing(product);
              selectedConfig = configValues[productId] || null;
            }
            
            pricing.push({
              productId: product.productId,
              productName: product.name,
              monthlyPremium: price ?? 0,
              selectedConfig: selectedConfig
            });
          }
        }

        setFrontendPricing(pricing);
      } else {
        setFrontendPricing([]);
      }
    };

    calculateFrontendPricing();
  }, [selectedProducts, configValues, products, productPrices]);

  // Fetch acknowledgements when selected products change
  useEffect(() => {
    if (selectedProducts.length > 0) {
      fetchProductAcknowledgements(selectedProducts);
    } else {
      setProductAcknowledgements([]);
    }
  }, [selectedProducts]);

  // Calculate contributions for products using the new contribution system
  const calculateProductContributions = async (productsData: Product[], configs: Record<string, string>) => {
    if (!memberProfile || !householdData) return;

    try {
      // For each product, calculate contributions
      const updatedProducts = await Promise.all(productsData.map(async (product) => {
        const configValue = configs[product.productId] || product.requiredDataFields[0]?.fieldOptions[0] || 'Default';
        
        // Use the new contribution system to calculate pricing and contributions
        const contributionResult = ContributionCalculator.calculateProductContributions(
          {
            productId: product.productId,
            productName: product.name,
            isBundle: product.isBundle || false,
            pricingVariations: [{
              configValue,
              monthlyPremium: product.basePrice
            }],
            contributionRules: [] // Will be populated by backend
          },
          configValue
        );

        return {
          ...product,
          monthlyPremium: contributionResult.employer + contributionResult.employee,
          employerContribution: contributionResult.employer,
          employeeContribution: contributionResult.employee,
          contributionRules: [] // Will be populated by backend
        };
      }));

      setProducts(updatedProducts);
    } catch (error) {
      console.warn('Failed to calculate product contributions:', error);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Use unified service that routes to correct endpoint based on memberId
      // - If memberId provided: Admin managing member (uses /api/members/{memberId}/...)
      // - If no memberId: Member managing themselves (uses /api/me/member/...)
      console.log('🔍 ProductChangePage: Loading product data for member:', memberId || 'current user');
      
      const [productsResponse, enrollmentsResponse] = await Promise.all([
        MemberProductManagementService.getAvailableProducts(memberId),
        MemberProductManagementService.getMemberEnrollments(memberId)
      ]);

      if (productsResponse.success && enrollmentsResponse.success) {
        const productsData = productsResponse.data;
        const enrollmentsData = enrollmentsResponse.data;

        // Set up initial state
        const currentEnrollments = enrollmentsData.filter(e => e.status === 'Active');
        
        // Use grouped enrollments to determine which products are enrolled
        // This handles bundles correctly by showing the bundle product as enrolled
        // instead of showing individual bundle components as separate enrolled products
        const enrolledProductIds: string[] = [];
        
        console.log('🔍 DEBUG: loadData - determining enrolled products', {
          hasGroupedEnrollments: !!groupedEnrollments,
          groupedEnrollmentsLength: groupedEnrollments?.length || 0,
          currentEnrollmentsLength: currentEnrollments.length
        });
        
        if (groupedEnrollments) {
          console.log('🔍 DEBUG: Processing grouped enrollments:', groupedEnrollments.map(ge => ({
            type: ge.type,
            status: ge.status,
            bundleId: ge.bundleId,
            primaryProductId: ge.primaryEnrollment?.productId,
            bundleName: ge.bundleName
          })));
          
          groupedEnrollments.forEach(groupedEnrollment => {
            if (groupedEnrollment.status === 'Active') {
              if (groupedEnrollment.type === 'bundle' && groupedEnrollment.bundleId) {
                // For bundles, add the bundle product ID (not individual components)
                enrolledProductIds.push(groupedEnrollment.bundleId);
                console.log(`🔍 DEBUG: Added bundle product ID: ${groupedEnrollment.bundleId} (${groupedEnrollment.bundleName})`);
              } else if (groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment) {
                // For individual products, add the product ID
                enrolledProductIds.push(groupedEnrollment.primaryEnrollment.productId);
                console.log(`🔍 DEBUG: Added individual product ID: ${groupedEnrollment.primaryEnrollment.productId}`);
              }
            }
          });
        } else {
          // Fallback to old logic if grouped enrollments not available
          console.log('🔍 DEBUG: Using fallback logic - adding all individual enrollment product IDs');
          const fallbackEnrolledIds = currentEnrollments.map(e => e.productId);
          enrolledProductIds.push(...fallbackEnrolledIds);
          console.log('🔍 DEBUG: Fallback enrolled product IDs:', fallbackEnrolledIds);
        }
        
        console.log('🔍 DEBUG: Final enrolled product IDs:', enrolledProductIds);
        
        // Set up configuration values for enrolled products and default configs for all products
        const initialConfigs: Record<string, string> = {};
        
        // First, set up configs for enrolled products from enrollment details
        currentEnrollments.forEach(enrollment => {
          if (enrollment.enrollmentDetails) {
            try {
              const details = JSON.parse(enrollment.enrollmentDetails);
              if (details.configuration) {
                // Set component config
                initialConfigs[enrollment.productId] = details.configuration;
                
                // If this is a bundle component, ALSO set the bundle-component key
                if (enrollment.productBundleID) {
                  const bundleComponentKey = `${enrollment.productBundleID}-${enrollment.productId}`;
                  initialConfigs[bundleComponentKey] = details.configuration;
                  console.log(`🔍 DEBUG: Set bundle component config: ${bundleComponentKey} = ${details.configuration}`);
                }
              }
              
              // Also check for bundle included product configurations
              if (details.bundleConfigurations) {
                Object.keys(details.bundleConfigurations).forEach(bundleConfigKey => {
                  initialConfigs[bundleConfigKey] = details.bundleConfigurations[bundleConfigKey];
                });
              }
            } catch (e) {
              console.warn('Failed to parse enrollment details:', e);
            }
          }
        });
        
        // Then, set default configs for all products that have configuration options
        productsData.forEach(product => {
          if (product.requiredDataFields && product.requiredDataFields.length > 0) {
            // If no config is set for this product, use the first option as default
            if (!initialConfigs[product.productId]) {
              const firstField = product.requiredDataFields[0];
              if (firstField.fieldOptions && firstField.fieldOptions.length > 0) {
                initialConfigs[product.productId] = firstField.fieldOptions[0];
              }
            }
          }
          
          // Also set up configs for included products within bundles
          if (product.isBundle && product.includedProducts) {
            product.includedProducts.forEach((includedProduct: any) => {
              if (includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0) {
                const bundleConfigKey = `${product.productId}-${includedProduct.productId}`;
                if (!initialConfigs[bundleConfigKey]) {
                  const firstField = includedProduct.requiredDataFields[0];
                  if (firstField.fieldOptions && firstField.fieldOptions.length > 0) {
                    initialConfigs[bundleConfigKey] = firstField.fieldOptions[0];
                  }
                }
              }
            });
          }
        });
        
        setConfigValues(initialConfigs);
        setInitialConfigValues({ ...initialConfigs }); // Store initial config state
        setSelectedConfigs(initialConfigs); // Set selected configs for contribution calculation

        // Set products and other state
        setProducts(productsData);
        setEnrollments(enrollmentsData);
        setSelectedProducts(enrolledProductIds);
        setInitialSelectedProducts([...enrolledProductIds]); // Store initial state

        // Calculate contributions for loaded products
        await calculateProductContributions(productsData, initialConfigs);
      } else {
        setError('Failed to load product data');
      }
    } catch (err) {
      console.error('Error loading data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  const getProductPricing = async (product: Product, overrideConfigValue?: string): Promise<number | null> => {
    if (!pricingData || !memberProfile || !householdData) return null; // Return null instead of basePrice to indicate loading

    try {
      // Use the unified pricing service with actual member data
      const memberCriteria = {
        age: memberProfile.age || 35,
        tobaccoUse: memberProfile.tobaccoUse || 'No',
        tier: memberProfile.tier || 'EE',
        householdSize: householdData.householdMembers?.length || 1
      };

      // Use override config value if provided, otherwise use current config value, otherwise use default
      const configValue = overrideConfigValue || configValues[product.productId] || 
        (product.requiredDataFields && product.requiredDataFields.length > 0 ? 
          product.requiredDataFields[0].fieldOptions[0] : 'Default');

      console.log('🔍 DEBUG: ProductChangePage pricing criteria:', {
        memberId: memberProfile.id,
        groupId: memberProfile.groupId,
        memberCriteria,
        productId: product.productId,
        configValue,
        overrideConfigValue: !!overrideConfigValue,
        hasConfigValues: !!configValues[product.productId]
      });

      const productConfigValues = { configValue1: configValue };

      const pricing = await PricingService.calculatePricing({
        memberId: memberProfile.id || '',
        calculationType: 'enrollment',
        memberCriteria,
        groupId: memberProfile.groupId, // Add groupId for group pricing
        productSelections: [{ 
          productId: product.productId,
          configValues: productConfigValues
        }]
      });

      // Find the pricing for this specific product
      const productPricing = pricing.products?.find(p => p.productId === product.productId);
      const monthlyPremium = productPricing?.monthlyPremium || product.basePrice;
      
      console.log(`🔍 DEBUG: ProductChangePage pricing result for ${product.name}:`, {
        productId: product.productId,
        configValue,
        monthlyPremium,
        basePrice: product.basePrice,
        found: !!productPricing,
        productPricingDetails: productPricing ? {
          monthlyPremium: productPricing.monthlyPremium,
          basePremium: productPricing.basePremium,
          configAdjustment: productPricing.configAdjustment
        } : null
      });
      
      return monthlyPremium;
    } catch (error) {
      console.warn('Pricing calculation failed:', error);
      return null; // Return null instead of basePrice to indicate error
    }
  };

  // Calculate pricing for included products within bundles
  const getIncludedProductPricing = async (includedProduct: any, bundleProductId: string, overrideConfigValue?: string): Promise<number | null> => {
    if (!memberProfile || !householdData) return null;

    try {
      const memberCriteria = {
        age: memberProfile.age || 35,
        tobaccoUse: memberProfile.tobaccoUse || 'No',
        tier: memberProfile.tier || 'EE',
        householdSize: householdData.householdMembers?.length || 1
      };

      // Create a unique config key for this included product within the bundle
      const bundleConfigKey = `${bundleProductId}-${includedProduct.productId}`;
      
      // Use override config value if provided, otherwise use current config value, otherwise use default
      const configValue = overrideConfigValue || configValues[bundleConfigKey] || 
        (includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0 ? 
          includedProduct.requiredDataFields[0].fieldOptions[0] : 'Default');

      console.log('🔍 DEBUG: Included product pricing criteria:', {
        bundleProductId,
        includedProductId: includedProduct.productId,
        includedProductName: includedProduct.productName,
        bundleConfigKey,
        configValue,
        overrideConfigValue: !!overrideConfigValue,
        hasConfigValues: !!configValues[bundleConfigKey],
        memberId: memberProfile.id,
        groupId: memberProfile.groupId,
        memberCriteria
      });

      const productConfigValues = { configValue1: configValue };

      const pricing = await PricingService.calculatePricing({
        memberId: memberProfile.id || '',
        calculationType: 'enrollment',
        memberCriteria,
        groupId: memberProfile.groupId, // Add groupId for group pricing
        productSelections: [{ 
          productId: includedProduct.productId,
          configValues: productConfigValues
        }]
      });

      const productPricing = pricing.products?.find(p => p.productId === includedProduct.productId);
      const monthlyPremium = productPricing?.monthlyPremium || 0;
      
      console.log(`🔍 DEBUG: Included product pricing result for ${includedProduct.productName}:`, {
        includedProductId: includedProduct.productId,
        configValue,
        monthlyPremium,
        found: !!productPricing,
        productPricingDetails: productPricing ? {
          monthlyPremium: productPricing.monthlyPremium,
          basePremium: productPricing.basePremium,
          configAdjustment: productPricing.configAdjustment
        } : null
      });
      
      return monthlyPremium;
    } catch (error) {
      console.warn('Included product pricing calculation failed:', error);
      return null;
    }
  };

  // Calculate pricing for all included products in bundles
  const calculateIncludedProductPricing = async () => {
    if (!memberProfile || !householdData || !products.length) return;

    const newIncludedProductPrices: Record<string, number> = {};
    const newBundlePrices: Record<string, number> = {};

    for (const product of products) {
      if (product.isBundle && product.includedProducts) {
        let bundleTotal = 0;
        for (const includedProduct of product.includedProducts) {
          const bundleConfigKey = `${product.productId}-${includedProduct.productId}`;
          // Use default configuration value for initial pricing calculation
          const defaultConfigValue = includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0 ? 
            includedProduct.requiredDataFields[0].fieldOptions[0] : 'Default';
          const pricing = await getIncludedProductPricing(includedProduct, product.productId, defaultConfigValue);
          newIncludedProductPrices[bundleConfigKey] = pricing ?? 0;
          bundleTotal += pricing ?? 0;
        }
        newBundlePrices[product.productId] = bundleTotal;
      }
    }

    setIncludedProductPrices(newIncludedProductPrices);
    setProductPrices(prev => ({
      ...prev,
      ...newBundlePrices
    }));
  };

  // Calculate total bundle price from included products
  const getBundleTotalPrice = (bundleProduct: Product) => {
    if (!bundleProduct.isBundle || !bundleProduct.includedProducts) {
      return bundleProduct.basePrice;
    }

    let total = 0;
    let hasLoadingPrices = false;
    
    for (const includedProduct of bundleProduct.includedProducts) {
      const bundleConfigKey = `${bundleProduct.productId}-${includedProduct.productId}`;
      const price = includedProductPrices[bundleConfigKey] || 0;
      total += price;
      
      // Check if any included product is still loading (price is 0)
      if (price === 0) {
        hasLoadingPrices = true;
      }
    }

    // Return 0 if any included product is still loading
    return hasLoadingPrices ? 0 : total;
  };

  // Transform group contribution rules to ContributionCalculator format
  const transformContributionRules = (rules: any[]) => {
    return rules.map((rule: any) => ({
      type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
      amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
      description: rule.Name || '',
      appliesTo: rule.ProductId ? 'product' : 'all_products'
    }));
  };

  // Transform product data to ContributionCalculator format
  const transformProductForContributionCalculator = async (product: Product, selectedConfig: string) => {
    let monthlyPremium = 0;
    
    if (product.isBundle) {
      monthlyPremium = getBundleTotalPrice(product);
    } else {
      const price = await getProductPricing(product);
      monthlyPremium = price ?? 0;
    }

    // Get product-specific contribution rules
    const productRules = groupContributionRules?.filter(rule => rule.ProductId === product.productId && rule.Status === 'Active') || [];
    const transformedRules = transformContributionRules(productRules);

    return {
      productId: product.productId,
      productName: product.name,
      description: product.description,
      productType: product.productType,
      isBundle: product.isBundle || false,
      contributionRules: transformedRules,
      pricingVariations: [{
        configValue: selectedConfig,
        monthlyPremium: monthlyPremium,
        employerContribution: 0,
        employeeContribution: monthlyPremium
      }]
    };
  };

  // Calculate total cost for selected products using ContributionCalculator
  const getSelectedProductsTotalCost = async () => {
    console.log('🔍 DEBUG: getSelectedProductsTotalCost called', {
      selectedProducts: selectedProducts,
      removedProducts: removedProducts,
      productsCount: products.length
    });
    
    if (!selectedProducts.length) {
      return 0;
    }

    // Transform selected products to ContributionCalculator format
    const selectedProductsData = [];
    const selectedConfigs: Record<string, string> = {};
    
    for (const productId of selectedProducts) {
      // Skip products that are being removed
      if (removedProducts.includes(productId)) {
        console.log(`🔍 DEBUG: Skipping removed product ${productId}`);
        continue;
      }
      
      const product = products.find(p => p.productId === productId);
      if (product) {
        const selectedConfig = configValues[productId] || (product.isBundle ? '1500' : 'Default');
        selectedConfigs[productId] = selectedConfig;
        
        const transformedProduct = await transformProductForContributionCalculator(product, selectedConfig);
        selectedProductsData.push(transformedProduct);
        
        console.log(`🔍 DEBUG: Transformed product ${product.name} for ContributionCalculator:`, {
          productId: transformedProduct.productId,
          monthlyPremium: transformedProduct.pricingVariations[0].monthlyPremium,
          contributionRules: transformedProduct.contributionRules
        });
      }
    }

    // Get all-products rules
    const allProductsRules = groupContributionRules?.filter((rule: any) => !rule.ProductId && rule.Status === 'Active') || [];
    const transformedAllProductsRules = transformContributionRules(allProductsRules);

    console.log('🔍 DEBUG: Using ContributionCalculator with:', {
      selectedProductsData: selectedProductsData.map(p => ({ productId: p.productId, productName: p.productName })),
      selectedConfigs,
      allProductsRules: transformedAllProductsRules
    });

    // Use ContributionCalculator for consistent calculation
    const contributionResult = ContributionCalculator.calculateTotalContributions(
      selectedProductsData,
      selectedConfigs,
      transformedAllProductsRules
    );

    console.log('🔍 DEBUG: ContributionCalculator result:', contributionResult);

    return contributionResult.totals.totalEmployeeContribution; // Return the employee contribution (what they actually pay)
  };

  // Calculate current enrollments total cost using ContributionCalculator
  const getCurrentEnrollmentsTotalCost = async () => {
    console.log('🔍 DEBUG: getCurrentEnrollmentsTotalCost called', {
      hasGroupedEnrollments: !!groupedEnrollments,
      groupedEnrollmentsLength: groupedEnrollments?.length || 0,
      enrollmentsLength: enrollments?.length || 0
    });
    
    // Transform current enrollments to ContributionCalculator format
    const currentProductsData = [];
    const currentConfigs: Record<string, string> = {};
    
    if (groupedEnrollments) {
      console.log('🔍 DEBUG: Using grouped enrollments for current total calculation');
      
      const activeGroupedEnrollments = groupedEnrollments.filter(ge => ge.status === 'Active');
      console.log('🔍 DEBUG: Active grouped enrollments:', activeGroupedEnrollments.map(ge => ({
        type: ge.type,
        bundleId: ge.bundleId,
        bundleName: ge.bundleName,
        totalPremium: ge.totalPremium,
        productCount: ge.enrollments?.length || 0
      })));
      
      for (const groupedEnrollment of activeGroupedEnrollments) {
        const productId = groupedEnrollment.bundleId || groupedEnrollment.primaryEnrollment?.productId;
        
        // Use actual enrollment amounts, not calculated totals
        let premium = 0;
        if (groupedEnrollment.type === 'bundle') {
          // For bundles, use the total premium from the grouped enrollment
          premium = groupedEnrollment.totalPremium || 0;
        } else if (groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment) {
          // For individual products, use the actual PremiumAmount from the enrollment
          premium = groupedEnrollment.primaryEnrollment.premiumAmount || 0;
        }
        
        if (productId) {
          // Find the product in our products list
          const product = products.find(p => p.productId === productId);
          if (product) {
            const selectedConfig = initialConfigValues[productId] || (product.isBundle ? '1500' : 'Default');
            currentConfigs[productId] = selectedConfig;
            
            // Get product-specific contribution rules
            const productRules = groupContributionRules?.filter(rule => rule.ProductId === productId && rule.Status === 'Active') || [];
            const transformedRules = transformContributionRules(productRules);

            currentProductsData.push({
              productId: product.productId,
              productName: product.name,
              description: product.description,
              productType: product.productType,
              isBundle: product.isBundle || false,
              contributionRules: transformedRules,
              pricingVariations: [{
                configValue: selectedConfig,
                monthlyPremium: premium
              }]
            });
            
            console.log(`🔍 DEBUG: Added current enrollment ${product.name} for ContributionCalculator:`, {
              productId: product.productId,
              monthlyPremium: premium,
              contributionRules: transformedRules
            });
          }
        }
      }
    } else {
      // Fallback to individual enrollments
      console.log('🔍 DEBUG: Using fallback logic (individual enrollments) for current total calculation');
      const activeEnrollments = enrollments.filter(e => e.status === 'Active');
      
      for (const enrollment of activeEnrollments) {
        const product = products.find(p => p.productId === enrollment.productId);
        if (product) {
          // Use the actual PremiumAmount from the enrollment record
          const premium = enrollment.premiumAmount || 0;
          const selectedConfig = initialConfigValues[enrollment.productId] || (product.isBundle ? '1500' : 'Default');
          currentConfigs[enrollment.productId] = selectedConfig;
          
          const productRules = groupContributionRules?.filter(rule => rule.ProductId === enrollment.productId && rule.Status === 'Active') || [];
          const transformedRules = transformContributionRules(productRules);

          currentProductsData.push({
            productId: product.productId,
            productName: product.name,
            description: product.description,
            productType: product.productType,
            isBundle: product.isBundle || false,
            contributionRules: transformedRules,
            pricingVariations: [{
              configValue: selectedConfig,
              monthlyPremium: premium
            }]
          });
        }
      }
    }

    // Get all-products rules
    const allProductsRules = groupContributionRules?.filter((rule: any) => !rule.ProductId && rule.Status === 'Active') || [];
    const transformedAllProductsRules = transformContributionRules(allProductsRules);

    console.log('🔍 DEBUG: Using ContributionCalculator for current enrollments with:', {
      currentProductsData: currentProductsData.map(p => ({ productId: p.productId, productName: p.productName })),
      currentConfigs,
      allProductsRules: transformedAllProductsRules
    });

    // Use ContributionCalculator for consistent calculation
    const contributionResult = ContributionCalculator.calculateTotalContributions(
      currentProductsData,
      currentConfigs,
      transformedAllProductsRules
    );

    console.log('🔍 DEBUG: ContributionCalculator result for current enrollments:', contributionResult);

    return contributionResult.totals.totalEmployeeContribution; // Return the employee contribution (what they actually pay)
  };

  // Calculate next billing date based on effective date and payment frequency
  const calculateNextBillingDate = (effectiveDate: string, paymentFrequency: string) => {
    const effective = new Date(effectiveDate);
    const today = new Date();
    
    // For monthly billing, find the next billing date
    if (paymentFrequency.toLowerCase().includes('monthly') || paymentFrequency.toLowerCase().includes('month')) {
      let nextBilling = new Date(effective);
      
      // Find the next billing date from today
      while (nextBilling <= today) {
        nextBilling.setMonth(nextBilling.getMonth() + 1);
      }
      
      return nextBilling;
    }
    
    // For other frequencies, use the effective date as fallback
    return effective;
  };

  const handleProductToggle = (productId: string) => {
    // Use grouped enrollments to check if product is enrolled
    const isCurrentlyEnrolled = groupedEnrollments?.some(ge => 
      ge.status === 'Active' && (
        (ge.type === 'bundle' && ge.bundleId === productId) ||
        (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
      )
    ) || false;
    
    if (isCurrentlyEnrolled) {
      // This is an existing enrollment - show confirmation dialog
      setShowRemoveConfirm(productId);
    } else {
      // This is a new product - toggle selection normally
      setSelectedProducts(prev => {
        if (prev.includes(productId)) {
          return prev.filter(id => id !== productId);
        } else {
          return [...prev, productId];
        }
      });
    }
  };

  const handleConfirmRemove = (productId: string) => {
    setSelectedProducts(prev => prev.filter(id => id !== productId));
    setRemovedProducts(prev => [...prev, productId]);
    setShowRemoveConfirm(null);
  };

  const handleUndoRemove = (productId: string) => {
    setSelectedProducts(prev => [...prev, productId]);
    setRemovedProducts(prev => prev.filter(id => id !== productId));
  };

  const handleProductInfoClick = (product: Product) => {
    setSelectedProductForInfo(product);
    setShowProductInfoModal(true);
  };

  // Fetch acknowledgements for selected products
  const fetchProductAcknowledgements = async (selectedProductIds: string[]) => {
    if (selectedProductIds.length === 0) {
      setProductAcknowledgements([]);
      return;
    }

    try {
      const response = await ProductChangesCompleteService.getProductAcknowledgements(selectedProductIds);
      
      if (response.success) {
        setProductAcknowledgements(response.data.productAcknowledgements || []);
        console.log('✅ Fetched product acknowledgements:', response.data.productAcknowledgements);
      } else {
        console.error('❌ Failed to fetch acknowledgements:', response.message);
        setProductAcknowledgements([]);
      }
    } catch (error) {
      console.error('❌ Error fetching acknowledgements:', error);
      setProductAcknowledgements([]);
    }
  };

  const handleConfigChange = async (productId: string, configValue: string) => {
    // Block changes to future enrollments
    if (isFutureEnrollment(productId)) {
      setError('Cannot modify plans that have not started yet. Please wait until the plan becomes effective.');
      return;
    }
    
    // Update configuration values
    const newConfigValues = {
      ...configValues,
      [productId]: configValue
    };
    setConfigValues(newConfigValues);
    
    // Update selected configs for contribution calculation
    const newSelectedConfigs = {
      ...selectedConfigs,
      [productId]: configValue
    };
    setSelectedConfigs(newSelectedConfigs);
    
    // Immediately recalculate pricing for this product
    const product = products.find(p => p.productId === productId);
    if (product && memberProfile && householdData) {
      try {
        const memberCriteria = {
          age: memberProfile.age || 35,
          tobaccoUse: memberProfile.tobaccoUse || 'No',
          tier: memberProfile.tier || 'EE',
          householdSize: householdData.householdMembers?.length || 1
        };

        console.log('🔍 DEBUG: ProductChangePage config change pricing criteria:', {
          productId,
          configValue,
          memberId: memberProfile.id,
          groupId: memberProfile.groupId,
          memberCriteria,
          productName: product.name
        });

        const newPrice = await getProductPricing(product, configValue);
        
        console.log(`🔍 DEBUG: ProductChangePage config change pricing result for ${product.name}:`, {
          productId,
          configValue,
          newPrice,
          basePrice: product.basePrice
        });
        
        // Update the price immediately
        if (newPrice !== null) {
          setProductPrices(prev => ({
            ...prev,
            [productId]: newPrice
          }));
        }
      } catch (error) {
        console.warn('Pricing calculation failed:', error);
        // Keep the current price if calculation fails
      }
    }
  };

  // Handle configuration changes for included products within bundles
  const handleBundleConfigChange = async (bundleProductId: string, includedProductId: string, configValue: string) => {
    // Create unique config key for this included product within the bundle
    const bundleConfigKey = `${bundleProductId}-${includedProductId}`;
    
    // Update configuration values
    const newConfigValues = {
      ...configValues,
      [bundleConfigKey]: configValue
    };
    setConfigValues(newConfigValues);
    
    // Update selected configs for contribution calculation
    const newSelectedConfigs = {
      ...selectedConfigs,
      [bundleConfigKey]: configValue
    };
    setSelectedConfigs(newSelectedConfigs);
    
    // Immediately recalculate pricing for this included product
    const bundleProduct = products.find(p => p.productId === bundleProductId);
    const includedProduct = bundleProduct?.includedProducts?.find(p => p.productId === includedProductId);
    
    if (includedProduct && memberProfile && householdData) {
      try {
        const memberCriteria = {
          age: memberProfile.age || 35,
          tobaccoUse: memberProfile.tobaccoUse || 'No',
          tier: memberProfile.tier || 'EE',
          householdSize: householdData.householdMembers?.length || 1
        };

        console.log('🔍 DEBUG: Bundle config change pricing criteria:', {
          bundleProductId,
          includedProductId,
          configValue,
          bundleConfigKey,
          memberId: memberProfile.id,
          groupId: memberProfile.groupId,
          memberCriteria,
          includedProductName: includedProduct.productName
        });

        const newPrice = await getIncludedProductPricing(includedProduct, bundleProductId, configValue);
        
        console.log(`🔍 DEBUG: Bundle config change pricing result for ${includedProduct.productName}:`, {
          includedProductId,
          configValue,
          newPrice
        });
        
        // Update the included product price immediately
        if (newPrice !== null) {
          setIncludedProductPrices(prev => ({
            ...prev,
            [bundleConfigKey]: newPrice
          }));
        }

        // Also update the main bundle product price to reflect the new total
        // Calculate the new total with the updated included product price
        let updatedBundleTotal = 0;
        if (bundleProduct && bundleProduct.includedProducts) {
          for (const includedProduct of bundleProduct.includedProducts) {
            const includedBundleConfigKey = `${bundleProductId}-${includedProduct.productId}`;
            const includedPrice = includedBundleConfigKey === bundleConfigKey 
              ? (newPrice ?? 0)
              : (includedProductPrices[includedBundleConfigKey] || 0);
            updatedBundleTotal += includedPrice;
          }
        }
        
        setProductPrices(prev => ({
          ...prev,
          [bundleProductId]: updatedBundleTotal
        }));
      } catch (error) {
        console.warn('Bundle pricing calculation failed:', error);
        // Keep the current price if calculation fails
      }
    }
  };


  // Fetch available payment methods for recurring payment setup
  const fetchAvailablePaymentMethods = async () => {
    try {
      setPaymentMethodLoading(true);
      
      if (allPaymentMethods.length > 0) {
        // Show all available payment methods for recurring payment setup
        const allMethods = allPaymentMethods.map(pm => ({
          id: pm.paymentMethodId,
          type: pm.paymentMethodType,
          last4: pm.paymentMethodType === 'ACH' 
            ? (pm.accountNumberLast4 || '****')
            : (pm.cardLast4 || '****'),
          cardBrand: pm.paymentMethodType === 'CreditCard' 
            ? (pm.cardBrand || 'Card') 
            : undefined,
          isDefault: pm.isDefault || false
        }));
        
        setAvailablePaymentMethods(allMethods);
        
        // Auto-select payment method - prefer default, otherwise first available
        const defaultMethod = allMethods.find(pm => pm.isDefault);
        const firstAvailable = allMethods[0];
        
        if (defaultMethod) {
          setSelectedPaymentMethodId(defaultMethod.id);
        } else if (firstAvailable) {
          setSelectedPaymentMethodId(firstAvailable.id);
        }
        
        console.log('🔍 DEBUG: Payment method selection:', {
          allMethods: allMethods.map(m => ({ id: m.id, type: m.type, last4: m.last4 })),
          selectedPaymentMethodId,
          defaultMethod: defaultMethod?.id
        });
      } else {
        setAvailablePaymentMethods([]);
      }
    } catch (error) {
      console.warn('Failed to fetch payment methods:', error);
      setAvailablePaymentMethods([]);
    } finally {
      setPaymentMethodLoading(false);
    }
  };

  // Removed fetchCurrentPaymentMethod - no longer needed for recurring payment setup

  // Payment method form functions
  const resetPaymentMethodData = () => {
    setPaymentMethodData({
      paymentMethodType: 'CreditCard',
      cardNumber: '',
      expiryMonth: undefined,
      expiryYear: undefined,
      cvv: '',
      cardholderName: '',
      bankName: '',
      accountType: 'Checking',
      routingNumber: '',
      accountNumber: '',
      accountHolderName: '',
      billingAddress: '',
      billingAddress2: '',
      billingCity: '',
      billingState: '',
      billingZip: '',
      billingCountry: 'US',
      phoneNumber: '',
      isDefault: true
    });
    setPaymentMethodErrors({});
  };

  const handleAddPaymentMethod = async () => {
    if (!validatePaymentMethodForm()) {
      return;
    }

    setIsUpdatingPayment(true);
    try {
      await addPaymentMethodMutation.mutateAsync(paymentMethodData);
      
      // No need to store raw payment data for recurring payment setup
      
      setShowAddPaymentMethod(false);
      resetPaymentMethodData();
      
      // Refresh payment methods
      await fetchAvailablePaymentMethods();
      
      // Payment method added successfully - auto-advance to next step
      if (showCompletionWizard) {
        setShouldAutoAdvance(true);
      }
    } catch (error) {
      console.error('Error adding payment method:', error);
    } finally {
      setIsUpdatingPayment(false);
    }
  };

  const validatePaymentMethodForm = (): boolean => {
    const newErrors: any = {};

    // Common validation
    if (!paymentMethodData.paymentMethodType) {
      newErrors.paymentMethodType = 'Payment method type is required';
    }

    if (paymentMethodData.paymentMethodType === 'CreditCard') {
      if (!paymentMethodData.cardNumber) {
        newErrors.cardNumber = 'Card number is required';
      } else {
        const clean = paymentMethodData.cardNumber.replace(/\D/g, '');
        if (!/^\d{13,21}$/.test(clean)) {
          newErrors.cardNumber = 'Card number must be 13-21 digits';
        } else if (getCardBrand(clean) === 'Unknown') {
          newErrors.cardNumber = 'Card type not recognized';
        }
      }

      if (!paymentMethodData.cardholderName) {
        newErrors.cardholderName = 'Cardholder name is required';
      }

      if (!paymentMethodData.expiryMonth) {
        newErrors.expiryMonth = 'Expiry month is required';
      }

      if (!paymentMethodData.expiryYear) {
        newErrors.expiryYear = 'Expiry year is required';
      }

      if (!paymentMethodData.cvv) {
        newErrors.cvv = 'CVV is required';
      } else if (!/^\d{3,4}$/.test(paymentMethodData.cvv)) {
        newErrors.cvv = 'CVV must be 3-4 digits';
      }

      // Check expiry date
      if (paymentMethodData.expiryMonth && paymentMethodData.expiryYear) {
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1;
        const expiryYear = paymentMethodData.expiryYear || 0;
        const expiryMonth = paymentMethodData.expiryMonth || 0;
        
        if (expiryYear < currentYear || (expiryYear === currentYear && expiryMonth < currentMonth)) {
          newErrors.expiryMonth = 'Card has expired';
        }
      }
    } else if (paymentMethodData.paymentMethodType === 'ACH') {
      if (!paymentMethodData.bankName) {
        newErrors.bankName = 'Bank name is required';
      }

      if (!paymentMethodData.routingNumber) {
        newErrors.routingNumber = 'Routing number is required';
      } else if (!/^\d{9}$/.test(paymentMethodData.routingNumber)) {
        newErrors.routingNumber = 'Routing number must be 9 digits';
      }

      if (!paymentMethodData.accountNumber) {
        newErrors.accountNumber = 'Account number is required';
      }

      if (!paymentMethodData.accountHolderName) {
        newErrors.accountHolderName = 'Account holder name is required';
      }
    }

    setPaymentMethodErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // Update payment methods when allPaymentMethods changes
  useEffect(() => {
    if (allPaymentMethods.length > 0) {
      fetchAvailablePaymentMethods();
    }
  }, [allPaymentMethods]);

  const handleSubmit = async () => {
    try {
      setSubmitting(true);
      setError(null);

      // Get new products (products being added)
      const newProducts = selectedProducts.filter(productId => !removedProducts.includes(productId));
      
      let acknowledgements = [];
      
      if (newProducts.length > 0) {
        // Check if any new products require acknowledgements
        console.log('🔍 Checking acknowledgements for new products:', newProducts);
        
        const acknowledgementsResponse = await ProductChangesCompleteService.getProductAcknowledgements(newProducts);
        
        if (acknowledgementsResponse.success && acknowledgementsResponse.data.productAcknowledgements.length > 0) {
          console.log('🔍 Products require acknowledgements');
          acknowledgements = acknowledgementsResponse.data.productAcknowledgements;
        }
      }

      // Fetch available payment methods for recurring payment setup
      await fetchAvailablePaymentMethods();

      // Always show completion wizard for confirmation
      console.log('🔍 Showing completion wizard with acknowledgements:', acknowledgements.length);
      setProductAcknowledgements(acknowledgements);
      setShowCompletionWizard(true);
      setSubmitting(false);
    } catch (err) {
      console.error('Error checking acknowledgements:', err);
      setError(err instanceof Error ? err.message : 'Failed to check product requirements');
      setSubmitting(false);
    }
  };

  // Removed submitProductChanges - now handled by completion wizard

  const handleCompletionWizardComplete = async (data: { acknowledgements: any[]; digitalSignature: string }) => {
    try {
      setCompletionLoading(true);
      setError(null);

      // Get selected payment method info for recurring payment setup
      const selectedPaymentMethod = availablePaymentMethods.find(pm => pm.id === selectedPaymentMethodId);
      
      // Prepare completion data
      const completionData = {
        selectedProducts,
        removedProducts,
        configValues,
        effectiveDate: new Date().toISOString().split('T')[0], // Backend will calculate actual next effective date
        frontendPricing,
        acknowledgements: data.acknowledgements,
        digitalSignature: data.digitalSignature,
        // Payment method information for recurring payment setup
        paymentMethod: selectedPaymentMethod ? {
          id: selectedPaymentMethod.id,
          type: selectedPaymentMethod.type,
          last4: selectedPaymentMethod.last4,
          cardBrand: selectedPaymentMethod.cardBrand
        } : null,
        memberInfo: {
          firstName: memberProfile?.firstName || '',
          lastName: memberProfile?.lastName || '',
          email: memberProfile?.email || '',
          phone: memberProfile?.phone || '',
          dateOfBirth: memberProfile?.dateOfBirth || '',
          gender: memberProfile?.gender || '',
          tobaccoUse: memberProfile?.tobaccoUse || 'No',
          address: memberProfile?.address || '',
          city: memberProfile?.city || '',
          state: memberProfile?.state || '',
          zip: memberProfile?.zip || memberProfile?.zipCode || '',
          hasSpouse: householdData?.householdMembers?.some((m: any) => m.relationshipType === 'S') || false,
          childrenCount: householdData?.householdMembers?.filter((m: any) => m.relationshipType === 'C').length || 0
        }
      };

      console.log('🔍 DEBUG: Completing product changes with acknowledgements:', completionData);

      // Submit using the completion service
      const response = await ProductChangesCompleteService.completeProductChanges(completionData);

      if (response.success) {
        console.log('Product changes completed successfully:', response.data);
        
        // Extract group membership info from response
        if (response.data.paymentInfo) {
          setIsGroupMember(response.data.paymentInfo.isGroupMember || false);
        }
        
        // Set PDF URL if provided
        if (response.data.pdfUrl) {
          setPdfUrl(response.data.pdfUrl);
          // Automatically show PDF modal if document was generated
          setShowPdfModal(true);
        }
        setShowCompletionWizard(false);
        if (onClose) {
          onClose();
        } else {
          navigate('/member/plans');
        }
      } else {
        // Handle pricing validation failures specifically
        if (response.error && response.error.code === 'PRICING_VALIDATION_FAILED') {
          console.error('🚨 PRICING VALIDATION FAILED:', response.error);
          setError(`Pricing validation failed: ${response.error.message}. Please refresh the page and try again.`);
          return;
        }
        
        // Handle missing frontend pricing data
        if (response.error && (response.error.code === 'MISSING_FRONTEND_PRICING' || response.error.code === 'MISSING_FRONTEND_PRICING_DATA')) {
          console.error('🚨 MISSING PRICING DATA:', response.error);
          setError(`Pricing data synchronization error: ${response.error.message}. Please refresh the page and try again.`);
          return;
        }
        
        // Handle other errors
        throw new Error(response.message || 'Failed to complete product changes');
      }
    } catch (err) {
      console.error('Error completing product changes:', err);
      setError(err instanceof Error ? err.message : 'Failed to complete product changes');
    } finally {
      setCompletionLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-oe-primary" />
          <p className="text-gray-600">Loading products...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <X className="h-8 w-8 mx-auto mb-4 text-red-600" />
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={loadData}
            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 -m-6">
      {/* Sticky Header Container */}
      <div className="sticky top-0 z-50">
        {/* Managing Member Banner - Shows when admin/agent is managing on behalf of a member */}
        {isManagingForMember && (
          <div className="bg-oe-primary text-white">
            <div className="px-4 sm:px-6 lg:px-8 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <Users className="h-6 w-6 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wider opacity-90">Managing Plan For</p>
                    <p className="text-xl font-semibold truncate">{memberName}</p>
                  </div>
                </div>
                <div className="text-sm ml-4 flex-shrink-0">
                  <p className="opacity-90">{memberEmail}</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="bg-white border-b border-gray-200 shadow-sm">
          <div className="px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <div className="flex items-center">
                <button
                  onClick={() => onClose ? onClose() : navigate('/member/plans')}
                  className="mr-4 p-2 text-gray-400 hover:text-gray-600"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div>
                  <h1 className="text-xl font-semibold text-gray-900">
                    {isManagingForMember ? 'Modify Member Plan' : 'Modify Your Plan'}
                  </h1>
                  <p className="text-sm text-gray-600">Select and configure your benefits</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Products List */}
          <div className="lg:col-span-2">
            <div className="space-y-4">
              {products
                .sort((a, b) => {
                  // Use grouped enrollments to check if products are enrolled
                  const aEnrolled = groupedEnrollments?.some(ge => 
                    ge.status === 'Active' && (
                      (ge.type === 'bundle' && ge.bundleId === a.productId) ||
                      (ge.type === 'individual' && ge.primaryEnrollment?.productId === a.productId)
                    )
                  ) || false;
                  const bEnrolled = groupedEnrollments?.some(ge => 
                    ge.status === 'Active' && (
                      (ge.type === 'bundle' && ge.bundleId === b.productId) ||
                      (ge.type === 'individual' && ge.primaryEnrollment?.productId === b.productId)
                    )
                  ) || false;
                  
                  // Enrolled products first
                  if (aEnrolled && !bEnrolled) return -1;
                  if (!aEnrolled && bEnrolled) return 1;
                  
                  // Then sort by name
                  return a.name.localeCompare(b.name);
                })
                .map((product) => {
                const isSelected = selectedProducts.includes(product.productId);
                
                // Use grouped enrollments to check if product is currently enrolled and get enrollment details
                const currentGroupedEnrollment = groupedEnrollments?.find(ge => 
                  ge.status === 'Active' && (
                    (ge.type === 'bundle' && ge.bundleId === product.productId) ||
                    (ge.type === 'individual' && ge.primaryEnrollment?.productId === product.productId)
                  )
                );
                
                const isCurrentlyEnrolled = !!currentGroupedEnrollment;
                
                // Get enrollment details for termination date calculation
                const enrollment = currentGroupedEnrollment?.primaryEnrollment || 
                                 enrollments.find(e => e.productId === product.productId);
                const isBeingRemoved = removedProducts.includes(product.productId);
                const currentConfig = configValues[product.productId] || (product.requiredDataFields[0]?.fieldOptions[0] || '');
                const productPrice = product.isBundle 
                  ? getBundleTotalPrice(product)
                  : (productPrices[product.productId] !== undefined ? productPrices[product.productId] : 0);

                return (
                  <div
                    key={product.productId}
                    className={`bg-white rounded-lg border-2 transition-all ${
                      isBeingRemoved
                        ? 'border-red-300 bg-red-50'
                        : isSelected 
                          ? 'border-oe-primary shadow-md' 
                          : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="p-6">
                      <div className="flex items-start space-x-4">
                        {/* Product Image */}
                        <div className="flex-shrink-0">
                          <img
                            src={product.productLogoUrl}
                            alt={product.name}
                            className="w-16 h-16 object-contain rounded-lg"
                          />
                        </div>

                        {/* Product Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <h3 className="text-lg font-semibold text-gray-900 mb-1">
                                {product.name}
                              </h3>
                              <p className="text-sm text-gray-600 mb-2">
                                {product.description}
                              </p>
                              <div className="flex items-center space-x-4">
                                <span className="text-sm font-medium text-gray-900">
                                  {productPrice > 0 ? (
                                    <>
                                      ${productPrice.toFixed(2)}/month
                                      {product.isBundle && (
                                        <span className="ml-2 text-xs text-gray-500">
                                          (before employer contributions)
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <span className="flex items-center text-gray-500">
                                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                      Calculating...
                                    </span>
                                  )}
                                </span>
                                {product.productDocumentUrl && (
                                  <button
                                    onClick={() => handleProductInfoClick(product)}
                                    className="inline-flex items-center px-2 py-1 rounded text-xs font-medium text-oe-primary hover:text-blue-800 hover:bg-blue-50"
                                  >
                                    <FileText className="h-3 w-3 mr-1" />
                                    Product Info
                                  </button>
                                )}
                                {isCurrentlyEnrolled && (
                                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                                    Currently Enrolled
                                  </span>
                                )}
                                {!product.isGroupAuthorized && (
                                  <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                    Not Available for Your Group
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Action Button */}
                            <div className="flex-shrink-0 ml-4">
                              {isCurrentlyEnrolled ? (
                                <div className="flex flex-col items-end space-y-2">
                                  {isBeingRemoved ? (
                                    <div className="flex flex-col items-end space-y-2">
                                      <button
                                        onClick={() => handleUndoRemove(product.productId)}
                                        className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200"
                                      >
                                        <Undo2 className="h-3 w-3 mr-1" />
                                        Undo Remove
                                      </button>
                                      {(() => {
                                        if (enrollment) {
                                          const terminationDate = calculateNextBillingDate(enrollment.effectiveDate, enrollment.paymentFrequency);
                                          return (
                                            <div className="text-xs text-red-600 text-right">
                                              <div className="font-medium">Plan Ends:</div>
                                              <div>{terminationDate.toLocaleDateString()}</div>
                                            </div>
                                          );
                                        }
                                        return null;
                                      })()}
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => handleProductToggle(product.productId)}
                                      className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200"
                                    >
                                      <X className="h-3 w-3 mr-1" />
                                      Remove
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <button
                                  onClick={() => handleProductToggle(product.productId)}
                                  disabled={!product.isGroupAuthorized}
                                  className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
                                    isSelected && !isBeingRemoved
                                      ? 'bg-oe-primary border-oe-primary text-white'
                                      : 'border-gray-300 hover:border-gray-400'
                                  } ${!product.isGroupAuthorized ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                                >
                                  {isSelected && !isBeingRemoved && <Check className="h-4 w-4" />}
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Bundle Products Display */}
                          {product.isBundle && product.includedProducts && product.includedProducts.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-gray-200">
                              <div className="space-y-3">
                                {product.includedProducts.map((includedProduct, index) => (
                                  <div key={includedProduct.productId || index} className="bg-gray-50 rounded-lg p-3">
                                    <div className="flex justify-between items-start">
                                      <div className="flex-1">
                                        <h4 className="text-sm font-medium text-gray-900">
                                          {includedProduct.productName}
                                        </h4>
                                        <p className="text-xs text-gray-600 mt-1">
                                          {includedProduct.description}
                                        </p>
                                        <div className="mt-2">
                                          <span className="text-sm font-medium text-gray-900">
                                            {(() => {
                                              const price = includedProductPrices[`${product.productId}-${includedProduct.productId}`] || 0;
                                              return price > 0 ? (
                                                `$${price.toFixed(2)}/month`
                                              ) : (
                                                <span className="flex items-center text-gray-500">
                                                  <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                                  Calculating...
                                                </span>
                                              );
                                            })()}
                                          </span>
                                        </div>
                                        
                                        {/* Configuration for included products */}
                                        {includedProduct.requiredDataFields && includedProduct.requiredDataFields.length > 0 && (
                                          <div className="mt-3">
                                            {includedProduct.requiredDataFields.map((field) => {
                                              const bundleConfigKey = `${product.productId}-${includedProduct.productId}`;
                                              return (
                                                <div key={field.id}>
                                                  <label className="block text-xs font-medium text-gray-700 mb-1">
                                                    {field.fieldName}
                                                  </label>
                                                  <select
                                                    value={configValues[bundleConfigKey] || field.fieldOptions[0] || ''}
                                                    onChange={(e) => handleBundleConfigChange(product.productId, includedProduct.productId, e.target.value)}
                                                    className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-oe-primary"
                                                  >
                                                    {field.fieldOptions.map((option) => (
                                                      <option key={option} value={option}>
                                                        {option}
                                                      </option>
                                                    ))}
                                                  </select>
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                      
                                      {/* Product Info button for included products */}
                                      {includedProduct.productDocumentUrl && (
                                        <button
                                          onClick={() => handleProductInfoClick({
                                            ...includedProduct,
                                            productId: includedProduct.productId,
                                            name: includedProduct.productName,
                                            productDocumentUrl: includedProduct.productDocumentUrl || '',
                                            productImageUrl: '',
                                            productLogoUrl: '',
                                            basePrice: 0,
                                            effectiveDateLogic: '',
                                            isEnrolled: false,
                                            canEnroll: true,
                                            isGroupAuthorized: true,
                                            requiredDataFields: [],
                                            acknowledgementQuestions: []
                                          })}
                                          className="ml-2 inline-flex items-center px-2 py-1 rounded text-xs font-medium text-oe-primary hover:text-blue-800 hover:bg-blue-50"
                                        >
                                          <FileText className="h-3 w-3 mr-1" />
                                          Product Info
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Configuration Section for individual products - Only show if not a bundle */}
                          {!product.isBundle && product.requiredDataFields.length > 0 && (
                            <div className="mt-4 pt-4 border-t border-gray-200">
                              <div className="space-y-3">
                                {product.requiredDataFields.map((field) => (
                                  <div key={field.id}>
                                    <label className="block text-sm font-medium text-gray-700 mb-1">
                                      {field.fieldName}
                                    </label>
                                    <select
                                      value={currentConfig}
                                      onChange={(e) => handleConfigChange(product.productId, e.target.value)}
                                      disabled={isFutureEnrollment(product.productId)}
                                      className={`w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary ${
                                        isFutureEnrollment(product.productId) ? 'bg-gray-100 cursor-not-allowed opacity-60' : ''
                                      }`}
                                    >
                                      {field.fieldOptions.map((option) => (
                                        <option key={option} value={option}>
                                          {option}
                                        </option>
                                      ))}
                                    </select>
                                    {isFutureEnrollment(product.productId) && (
                                      <p className="text-xs text-amber-600 mt-1 flex items-center">
                                        <Info className="h-3 w-3 mr-1" />
                                        You cannot make changes to plans that have not gone into effect yet.
                                      </p>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Summary Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg border border-gray-200 p-6 sticky top-8">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Plan Summary</h3>
              
              <div className="space-y-4">
                {/* Current Plan - Simplified */}
                <div className="py-2 border-b border-gray-200">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-900">Your Current Monthly Contribution</span>
                    <span className="text-sm font-medium text-gray-900">
                      {isPricingLoading ? (
                        <span className="flex items-center text-gray-500">
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          Calculating...
                        </span>
                      ) : (
                        `$${currentTotal.toFixed(2)}`
                      )}
                    </span>
                  </div>
                </div>
                
                      {/* Plan Changes - only show if there are changes */}
                      {hasChanges() && (
                        <div className="py-2 border-b border-gray-200">
                          <div className="text-sm font-medium text-gray-900 mb-2">Plan Changes</div>
                          <div className="space-y-1 text-sm">
                            {/* Show individual product changes */}
                            {removedProducts.map(productId => {
                              const product = products.find(p => p.productId === productId);
                              const productName = product?.name || 'Unknown Product';
                              
                              let premium = 0;
                              
                              // Find the correct grouped enrollment for this specific product
                              const groupedEnrollment = groupedEnrollments?.find(ge => {
                                if (ge.type === 'bundle' && ge.bundleId === productId) {
                                  // This is the bundle product itself
                                  return true;
                                } else if (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId) {
                                  // This is an individual product
                                  return true;
                                } else if (ge.type === 'bundle' && ge.componentEnrollments?.some(ce => ce.productId === productId)) {
                                  // This is a component within a bundle - we need the component's individual premium
                                  return true;
                                }
                                return false;
                              });
                              
                              if (groupedEnrollment) {
                                if (groupedEnrollment.type === 'bundle' && groupedEnrollment.bundleId === productId) {
                                  // For bundle products, use the total bundle premium from actual enrollments
                                  premium = groupedEnrollment.totalPremium || 0;
                                } else if (groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment?.productId === productId) {
                                  // For individual products, calculate the net employee contribution after employer contributions
                                  const currentProductId = groupedEnrollment.primaryEnrollment?.productId;
                                  if (currentProductId && memberProfile && groupContributionRules) {
                                    // Calculate contribution for this specific product
                                    const productRules = groupContributionRules?.filter((rule: any) => 
                                      rule.ProductId === currentProductId && rule.Status === 'Active'
                                    ) || [];
                                    const allProductsRules = groupContributionRules?.filter((rule: any) => 
                                      !rule.ProductId && rule.Status === 'Active'
                                    ) || [];

                                    const transformedProductRules = productRules.map((rule: any) => ({
                                      type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
                                      amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
                                      description: rule.Name || '',
                                      appliesTo: 'product' as const
                                    }));

                                    const transformedAllProductsRules = allProductsRules.map((rule: any) => ({
                                      type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
                                      amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
                                      description: rule.Name || '',
                                      appliesTo: 'all_products' as const
                                    }));

                                    const productData = {
                                      productId: currentProductId,
                                      productName: groupedEnrollment.primaryEnrollment?.product.name || '',
                                      description: '',
                                      productType: '',
                                      isBundle: false,
                                      contributionRules: transformedProductRules,
                                      pricingVariations: [{
                                        configValue: 'Default',
                                        monthlyPremium: groupedEnrollment.primaryEnrollment?.premiumAmount || 0
                                      }]
                                    };

                                    const selectedConfigs = { [currentProductId]: 'Default' };

                                    const contributionResult = ContributionCalculator.calculateTotalContributions(
                                      [productData],
                                      selectedConfigs,
                                      transformedAllProductsRules
                                    );

                                    premium = contributionResult.totals.totalEmployeeContribution;
                                  } else {
                                    // Fallback to raw premium amount if no contribution calculation
                                    premium = groupedEnrollment.primaryEnrollment?.premiumAmount || 0;
                                  }
                                } else if (groupedEnrollment.type === 'bundle' && groupedEnrollment.componentEnrollments?.some(ce => ce.productId === productId)) {
                                  // For bundle components, find the specific component's premium
                                  const componentEnrollment = groupedEnrollment.componentEnrollments?.find(ce => ce.productId === productId);
                                  premium = componentEnrollment?.premiumAmount || 0;
                                }
                              }
                              
                              console.log('🔍 DEBUG Remove pricing:', { 
                                productId, 
                                productName, 
                                groupedEnrollment: groupedEnrollment ? {
                                  type: groupedEnrollment.type,
                                  bundleId: groupedEnrollment.bundleId,
                                  primaryProductId: groupedEnrollment.primaryEnrollment?.productId,
                                  componentProductIds: groupedEnrollment.componentEnrollments?.map(ce => ce.productId)
                                } : null,
                                premium 
                              });
                              
                              return (
                                <div key={productId} className="flex justify-between">
                                  <span className="text-red-600">Remove {productName}</span>
                                  <span className="text-red-600">-${premium.toFixed(2)}</span>
                </div>
                              );
                            })}
                            
                            {/* Show products being added */}
                            {selectedProducts
                              .filter(productId => !initialSelectedProducts.includes(productId))
                              .map(productId => {
                                const product = products.find(p => p.productId === productId);
                                const productName = product?.name || 'Unknown Product';
                                // Use the exact same logic as the product card
                                const premium = product?.isBundle 
                                  ? getBundleTotalPrice(product)
                                  : (productPrices[productId] || product?.basePrice || 0);
                                
                                console.log('🔍 DEBUG Add pricing:', { 
                                  productId, 
                                  productName, 
                                  isBundle: product?.isBundle,
                                  basePrice: product?.basePrice, 
                                  productPricesValue: productPrices[productId],
                                  bundleTotal: product?.isBundle ? getBundleTotalPrice(product) : 'N/A',
                                  finalPremium: premium 
                                });
                                
                                return (
                                  <div key={productId} className="flex justify-between">
                                    <span className="text-oe-primary">{productName}</span>
                                    <span className="text-oe-primary">
                                      {premium > 0 ? (
                                        `+$${premium.toFixed(2)}`
                                      ) : (
                                        <span className="flex items-center text-gray-500">
                                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                          Calculating...
                                        </span>
                                      )}
                                    </span>
                                  </div>
                                );
                              })}
                            
                            {/* Show configuration changes for existing products */}
                            {(() => {
                              const configChanges: Array<{
                                productId: string;
                                productName: string;
                                oldPrice: number;
                                newPrice: number;
                                oldConfig: string;
                                newConfig: string;
                              }> = [];
                              
                              console.log('🔍 DEBUG: Checking for configuration changes', {
                                configValues,
                                initialConfigValues,
                                selectedProducts,
                                initialSelectedProducts,
                                configValueKeys: Object.keys(configValues),
                                initialConfigValueKeys: Object.keys(initialConfigValues)
                              });
                              
                              // Check for configuration changes in existing products
                              // First check individual products
                              initialSelectedProducts.forEach(productId => {
                                const currentValue = configValues[productId];
                                const initialValue = initialConfigValues[productId];
                                
                                if (currentValue !== initialValue) {
                                  const product = products.find(p => p.productId === productId);
                                  if (product) {
                                    // This is an existing product with a configuration change
                                    const productName = product.name;
                                    // The current price reflects the new configuration
                                    const newPrice = product.isBundle ? 
                                      getBundleTotalPrice(product) : 
                                      (productPrices[productId] || product.basePrice || 0);
                                    
                                    // For the old price, we need to get the actual PremiumAmount from the enrollment
                                    // which reflects the original configuration
                                    const groupedEnrollment = groupedEnrollments?.find(ge => 
                                      (ge.type === 'bundle' && ge.bundleId === productId) ||
                                      (ge.type === 'individual' && ge.primaryEnrollment?.productId === productId)
                                    );
                                    
                                    let oldPrice = 0;
                                    if (groupedEnrollment) {
                                      if (groupedEnrollment.type === 'bundle' && groupedEnrollment.bundleId === productId) {
                                        // For bundle products, use the total bundle premium
                                        oldPrice = groupedEnrollment.totalPremium || 0;
                                      } else if (groupedEnrollment.type === 'individual' && groupedEnrollment.primaryEnrollment?.productId === productId) {
                                        // For individual products, calculate the net employee contribution after employer contributions
                                        const currentProductId = groupedEnrollment.primaryEnrollment?.productId;
                                        if (currentProductId && memberProfile && groupContributionRules) {
                                          // Calculate contribution for this specific product
                                          const productRules = groupContributionRules?.filter((rule: any) => 
                                            rule.ProductId === currentProductId && rule.Status === 'Active'
                                          ) || [];
                                          const allProductsRules = groupContributionRules?.filter((rule: any) => 
                                            !rule.ProductId && rule.Status === 'Active'
                                          ) || [];

                                          const transformedProductRules = productRules.map((rule: any) => ({
                                            type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
                                            amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
                                            description: rule.Name || '',
                                            appliesTo: 'product' as const
                                          }));

                                          const transformedAllProductsRules = allProductsRules.map((rule: any) => ({
                                            type: rule.ContributionType === 'flat_rate' ? 'flat_rate' : 'percentage',
                                            amount: rule.ContributionType === 'flat_rate' ? rule.FlatRateAmount : rule.PercentageAmount,
                                            description: rule.Name || '',
                                            appliesTo: 'all_products' as const
                                          }));

                                          const productData = {
                                            productId: currentProductId,
                                            productName: groupedEnrollment.primaryEnrollment?.product.name || '',
                                            description: '',
                                            productType: '',
                                            isBundle: false,
                                            contributionRules: transformedProductRules,
                                            pricingVariations: [{
                                              configValue: 'Default',
                                              monthlyPremium: groupedEnrollment.primaryEnrollment?.premiumAmount || 0
                                            }]
                                          };

                                          const selectedConfigs = { [currentProductId]: 'Default' };

                                          const contributionResult = ContributionCalculator.calculateTotalContributions(
                                            [productData],
                                            selectedConfigs,
                                            transformedAllProductsRules
                                          );

                                          oldPrice = contributionResult.totals.totalEmployeeContribution;
                                        } else {
                                          // Fallback to raw premium amount if no contribution calculation
                                          oldPrice = groupedEnrollment.primaryEnrollment?.premiumAmount || 0;
                                        }
                                      }
                                    }
                                    
                                    console.log('🔍 DEBUG: Configuration change detected for individual product', {
                                      productId,
                                      productName,
                                      oldConfig: initialValue,
                                      newConfig: currentValue,
                                      oldPrice,
                                      newPrice,
                                      priceChange: newPrice - oldPrice
                                    });
                                    
                                    configChanges.push({
                                      productId,
                                      productName,
                                      oldPrice,
                                      newPrice,
                                      oldConfig: initialValue,
                                      newConfig: currentValue
                                    });
                                  }
                                }
                              });
                              
                              // Then check for bundle configuration changes (included product configs)
                              Object.keys(configValues).forEach(key => {
                                // Check if this is a bundle config key (format: bundleProductId-includedProductId)
                                if (key.includes('-')) {
                                  const currentValue = configValues[key];
                                  const initialValue = initialConfigValues[key];
                                  
                                  console.log('🔍 DEBUG: Checking bundle config key', {
                                    key,
                                    currentValue,
                                    initialValue,
                                    hasInitialValue: initialValue !== undefined,
                                    valuesMatch: currentValue === initialValue
                                  });
                                  
                                  if (currentValue !== initialValue) {
                                    // Split the key properly - UUIDs contain dashes, so we need to find the pattern
                                    // Format: bundleProductId-includedProductId
                                    // Both are UUIDs, so we need to split at the right position
                                    const parts = key.split('-');
                                    // UUID format: XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
                                    // So we need to take the first 5 parts for bundleProductId and the rest for includedProductId
                                    const bundleProductId = parts.slice(0, 5).join('-');
                                    const includedProductId = parts.slice(5).join('-');
                                    
                                    console.log('🔍 DEBUG: Properly split bundle config key', {
                                      originalKey: key,
                                      bundleProductId,
                                      includedProductId,
                                      parts
                                    });
                                    
                                    const bundleProduct = products.find(p => p.productId === bundleProductId);
                                    
                                    console.log('🔍 DEBUG: Bundle config change found', {
                                      bundleProductId,
                                      includedProductId,
                                      bundleProductFound: !!bundleProduct,
                                      isBundle: bundleProduct?.isBundle,
                                      isInSelectedProducts: initialSelectedProducts.includes(bundleProductId)
                                    });
                                    
                                    if (bundleProduct && bundleProduct.isBundle && initialSelectedProducts.includes(bundleProductId)) {
                                      // Find the included product to get its name
                                      const includedProduct = bundleProduct.includedProducts?.find(p => p.productId === includedProductId);
                                      
                                      if (includedProduct) {
                                        // This is a bundle product with an included product configuration change
                                        const bundleProductName = bundleProduct.name;
                                        const includedProductName = includedProduct.productName;
                                        
                                        // The current price reflects the new configuration
                                        const newPrice = getBundleTotalPrice(bundleProduct);
                                        
                                        // For the old price, we need to get the price from the grouped enrollment
                                        const groupedEnrollment = groupedEnrollments?.find(ge => 
                                          ge.type === 'bundle' && ge.bundleId === bundleProductId
                                        );
                                        const oldPrice = groupedEnrollment?.totalPremium || bundleProduct.basePrice || 0;
                                        
                                        console.log('🔍 DEBUG: Configuration change detected for included product in bundle', {
                                          bundleProductId,
                                          bundleProductName,
                                          includedProductId,
                                          includedProductName,
                                          configKey: key,
                                          oldConfig: initialValue,
                                          newConfig: currentValue,
                                          oldPrice,
                                          newPrice,
                                          priceChange: newPrice - oldPrice
                                        });
                                        
                                        // Only add if we haven't already added this bundle product
                                        if (!configChanges.some(change => change.productId === bundleProductId)) {
                                          configChanges.push({
                                            productId: bundleProductId,
                                            productName: `${bundleProductName} (${includedProductName})`,
                                            oldPrice,
                                            newPrice,
                                            oldConfig: initialValue,
                                            newConfig: currentValue
                                          });
                                        }
                                      }
                                    }
                                  }
                                }
                              });
                              
                              return configChanges.length > 0 ? (
                                <div className="space-y-1">
                                  {configChanges.map(change => (
                                    <div key={change.productId} className="flex justify-between">
                                      <div className="text-orange-600">
                                        <div>Update {change.productName}</div>
                                        <div className="text-xs text-gray-500">({change.oldConfig} → {change.newConfig})</div>
                                      </div>
                                      <span className="text-orange-600">
                                        {change.newPrice > 0 ? (
                                          `${change.newPrice > change.oldPrice ? '+' : ''}$${(change.newPrice - change.oldPrice).toFixed(2)}`
                                        ) : (
                                          <span className="flex items-center text-gray-500">
                                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                            Calculating...
                                          </span>
                                        )}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              ) : null;
                            })()}
                            
                            {/* Show employer contributions for group members with selected products that have contributions > $0 */}
                            {memberProfile?.groupId && (() => {
                              // Get all selected product IDs (not removed)
                              const activeSelectedProductIds = selectedProducts.filter(productId => !removedProducts.includes(productId));
                              const relevantRules = groupContributionRules?.filter((rule: any) => 
                                rule.Status === 'Active' && 
                                (rule.ProductId === null || activeSelectedProductIds.includes(rule.ProductId)) &&
                                (rule.FlatRateAmount || 0) > 0
                              );
                              
                              return relevantRules && relevantRules.length > 0 ? (
                                <div className="pt-2 border-t border-gray-100">
                                  <div className="text-xs font-medium text-gray-700 mb-1">Employer Contributions:</div>
                                  {relevantRules.map((rule: any, index: number) => (
                                    <div key={index} className="flex justify-between ml-2">
                                      <span className="text-green-700 text-xs">{rule.Name}</span>
                                      <span className="text-green-600 text-xs">-${(rule.FlatRateAmount || 0).toFixed(2)}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : null;
                            })()}
                            
                            <div className="flex justify-between font-medium pt-2 border-t border-gray-200">
                              <span className="text-gray-900">Your New Monthly Contribution</span>
                              <span className="text-gray-900">
                                {isPricingLoading ? (
                                  <span className="flex items-center text-gray-500">
                                    <Loader2 className="h-3 w-3 animate-spin mr-1" />
                                    Calculating...
                                  </span>
                                ) : (
                                  `$${newTotal.toFixed(2)}`
                                )}
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
              </div>

              <div className="mt-6">
                <button
                  onClick={handleSubmit}
                  disabled={submitting || !hasChanges() || isPricingLoading}
                  className={`w-full py-3 px-4 rounded-lg font-medium flex items-center justify-center transition-colors ${
                    (() => {
                      // Check if all products are being removed (cancel plan scenario)
                      const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
                      const isCancelPlan = currentSelected.length === 0 && hasChanges();
                      return isCancelPlan 
                      ? 'bg-red-600 text-white hover:bg-red-700' 
                        : 'bg-oe-primary text-white hover:bg-oe-primary-dark';
                    })()
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Processing...
                    </>
                  ) : isPricingLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Calculating Pricing...
                    </>
                  ) : (() => {
                    // Check if all products are being removed (cancel plan scenario)
                    const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
                    const isCancelPlan = currentSelected.length === 0 && hasChanges();
                    return isCancelPlan ? 'Cancel Plan' : 'Apply Changes';
                  })()}
                </button>
              </div>

              {/* Contribution Breakdown - Only show in debug mode */}
              {isDebugMode() && (
                <ContributionBreakdown
                  products={products.filter(p => selectedProducts.includes(p.productId) && !removedProducts.includes(p.productId)).map(p => ({
                    productId: p.productId,
                    productName: p.name,
                    isBundle: p.isBundle || false,
                    pricingVariations: p.requiredDataFields && p.requiredDataFields.length > 0 ? [{
                      configValue: p.requiredDataFields[0].fieldOptions[0] || 'Default',
                      monthlyPremium: p.basePrice
                    }] : [{
                      configValue: 'Default',
                      monthlyPremium: p.basePrice
                    }],
                    contributionRules: []
                  }))}
                  selectedConfigs={selectedConfigs}
                  allProductsRules={[]}
                  totals={{
                    totalPremium: newTotal,
                    totalEmployerContribution: products
                      .filter(p => selectedProducts.includes(p.productId) && !removedProducts.includes(p.productId))
                      .reduce((sum, p) => sum + (p.employerContribution || 0), 0),
                    totalEmployeeContribution: products
                      .filter(p => selectedProducts.includes(p.productId) && !removedProducts.includes(p.productId))
                      .reduce((sum, p) => sum + (p.employeeContribution || 0), 0)
                  }}
                />
              )}

              {(() => {
                // Check if all products are being removed (cancel plan scenario)
                const currentSelected = selectedProducts.filter(id => !removedProducts.includes(id));
                return currentSelected.length === 0 && hasChanges();
              })() && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
                  <div className="flex">
                    <Info className="h-4 w-4 text-red-400 mr-2 mt-0.5" />
                    <p className="text-sm text-red-800">
                      You are about to cancel your entire plan. This will remove all your current products.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Remove Confirmation Dialog */}
      {showRemoveConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg max-w-md w-full p-6">
            <div className="flex items-center mb-4">
              <div className="flex-shrink-0">
                <X className="h-6 w-6 text-red-600" />
              </div>
              <div className="ml-3">
                <h3 className="text-lg font-medium text-gray-900">Remove Product</h3>
              </div>
            </div>
            <div className="mb-6">
              <p className="text-sm text-gray-600">
                Are you sure you want to remove this product from your plan? This action can be undone.
              </p>
            </div>
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowRemoveConfirm(null)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleConfirmRemove(showRemoveConfirm)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700"
              >
                Remove Product
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Product Info Modal */}
      <ProductInfoModal
        isOpen={showProductInfoModal}
        onClose={() => setShowProductInfoModal(false)}
        product={selectedProductForInfo}
        isBundle={selectedProductForInfo?.isBundle || false}
        includedProducts={selectedProductForInfo?.includedProducts || []}
      />


      {/* Add Payment Method Modal */}
      {showAddPaymentMethod && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold text-gray-900">Add Payment Method</h2>
              <div className="flex items-center justify-between mt-1">
                <p className="text-sm text-gray-600">Add a new payment method for billing</p>
                {window.location.hostname === 'localhost' && (
                  <button
                    type="button"
                    onClick={() => {
                      // Prefill test data based on payment method type
                      const currentType = paymentMethodData.paymentMethodType;
                      if (currentType === 'ACH') {
                        setPaymentMethodData(prev => ({
                          ...prev,
                          bankName: 'Test Bank',
                          accountType: 'Checking',
                          routingNumber: '021000021', // DIME API test routing number
                          accountNumber: '123456789', // DIME API test account number
                          accountHolderName: 'John Doe',
                          billingAddress: '123 Main St',
                          billingCity: 'Anytown',
                          billingState: 'CA',
                          billingZip: '12345',
                          phoneNumber: '7707892072'
                        }));
                      } else { // CreditCard
                        setPaymentMethodData(prev => ({
                          ...prev,
                          cardNumber: '4111111111111111',
                          cardholderName: 'John Doe',
                          expiryMonth: 12,
                          expiryYear: 2025,
                          cvv: '123',
                          billingAddress: '123 Main St',
                          billingCity: 'Anytown',
                          billingState: 'CA',
                          billingZip: '12345',
                          phoneNumber: '7707892072'
                        }));
                      }
                    }}
                    className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                  >
                    Prefill Test Data
                  </button>
                )}
              </div>
            </div>
            <div className="p-6">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Payment Method Type *
                  </label>
                  <select
                    value={paymentMethodData.paymentMethodType}
                    onChange={(e) => setPaymentMethodData(prev => ({ ...prev, paymentMethodType: e.target.value as 'ACH' | 'CreditCard' }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    required
                  >
                    <option value="CreditCard">Credit/Debit Card</option>
                    <option value="ACH">Bank Account (ACH)</option>
                  </select>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <div className="flex items-center">
                    <Star className="h-4 w-4 text-oe-primary mr-2" />
                    <span className="text-sm text-blue-800 font-medium">
                      This payment method will be set as your default
                    </span>
                  </div>
                  <p className="text-xs text-oe-primary mt-1">
                    Any existing default payment method will be moved to secondary
                  </p>
                </div>

                {paymentMethodData.paymentMethodType === 'CreditCard' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Card Number *
                      </label>
                      <div className="relative">
                        <input
                          type={showCardNumber ? 'text' : 'password'}
                          value={paymentMethodData.cardNumber || ''}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 21);
                            setPaymentMethodData(prev => ({ ...prev, cardNumber: value }));
                            if (paymentMethodErrors.cardNumber) {
                              setPaymentMethodErrors((prev: any) => ({ ...prev, cardNumber: undefined }));
                            }
                          }}
                          placeholder="1234 5678 9012 3456"
                          className={`w-full px-3 py-2 pr-10 border ${paymentMethodErrors.cardNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowCardNumber(!showCardNumber)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          <Eye className={`h-4 w-4 ${showCardNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                        </button>
                      </div>
                      {paymentMethodErrors.cardNumber ? (
                        <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cardNumber}</p>
                      ) : (
                        <div className="text-gray-500 text-xs mt-1">
                          <p>Enter 13-21 digits (Visa: 13-19, Mastercard: 16, Amex: 15, Discover: 16)</p>
                          <p className="text-oe-primary mt-1">
                            Test: 4111111111111111 (Visa), 5555555555554444 (Mastercard)
                          </p>
                        </div>
                      )}
                      <DetectedCardBrandLine cardNumber={paymentMethodData.cardNumber || ''} className="mt-2" />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Cardholder Name *
                      </label>
                      <input
                        type="text"
                        value={paymentMethodData.cardholderName || ''}
                        onChange={(e) => {
                          setPaymentMethodData(prev => ({ ...prev, cardholderName: e.target.value }));
                          if (paymentMethodErrors.cardholderName) {
                            setPaymentMethodErrors((prev: any) => ({ ...prev, cardholderName: undefined }));
                          }
                        }}
                        placeholder="John Doe"
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.cardholderName ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        required
                      />
                      {paymentMethodErrors.cardholderName && (
                        <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cardholderName}</p>
                      )}
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Expiry Month *
                        </label>
                        <select
                          value={paymentMethodData.expiryMonth || ''}
                          onChange={(e) => {
                            setPaymentMethodData(prev => ({ ...prev, expiryMonth: parseInt(e.target.value) }));
                            if (paymentMethodErrors.expiryMonth) {
                              setPaymentMethodErrors((prev: any) => ({ ...prev, expiryMonth: undefined }));
                            }
                          }}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.expiryMonth ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                          required
                        >
                          <option value="">Month</option>
                          {Array.from({ length: 12 }, (_, i) => i + 1).map(month => (
                            <option key={month} value={month}>{month.toString().padStart(2, '0')}</option>
                          ))}
                        </select>
                        {paymentMethodErrors.expiryMonth && (
                          <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.expiryMonth}</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Expiry Year *
                        </label>
                        <select
                          value={paymentMethodData.expiryYear || ''}
                          onChange={(e) => {
                            setPaymentMethodData(prev => ({ ...prev, expiryYear: parseInt(e.target.value) }));
                            if (paymentMethodErrors.expiryYear) {
                              setPaymentMethodErrors((prev: any) => ({ ...prev, expiryYear: undefined }));
                            }
                          }}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.expiryYear ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                          required
                        >
                          <option value="">Year</option>
                          {Array.from({ length: 10 }, (_, i) => new Date().getFullYear() + i).map(year => (
                            <option key={year} value={year}>{year}</option>
                          ))}
                        </select>
                        {paymentMethodErrors.expiryYear && (
                          <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.expiryYear}</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          CVV *
                        </label>
                        <input
                          type="password"
                          value={paymentMethodData.cvv || ''}
                          onChange={(e) => {
                            const value = e.target.value.replace(/\D/g, '').slice(0, 4);
                            setPaymentMethodData(prev => ({ ...prev, cvv: value }));
                            if (paymentMethodErrors.cvv) {
                              setPaymentMethodErrors((prev: any) => ({ ...prev, cvv: undefined }));
                            }
                          }}
                          placeholder="123"
                          maxLength={4}
                          className={`w-full px-3 py-2 border ${paymentMethodErrors.cvv ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                          required
                        />
                        {paymentMethodErrors.cvv && (
                          <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.cvv}</p>
                        )}
                        <p className="text-gray-500 text-xs mt-1">
                          CVV is required for tokenization but not stored
                        </p>
                      </div>
                    </div>
                  </>
                )}

                {paymentMethodData.paymentMethodType === 'ACH' && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Bank Name *
                      </label>
                      <input
                        type="text"
                        value={paymentMethodData.bankName || ''}
                        onChange={(e) => {
                          setPaymentMethodData(prev => ({ ...prev, bankName: e.target.value }));
                          if (paymentMethodErrors.bankName) {
                            setPaymentMethodErrors((prev: any) => ({ ...prev, bankName: undefined }));
                          }
                        }}
                        placeholder="Enter bank name"
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.bankName ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        required
                      />
                      {paymentMethodErrors.bankName && (
                        <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.bankName}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Type *
                      </label>
                      <select
                        value={paymentMethodData.accountType || ''}
                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, accountType: e.target.value as any }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        required
                      >
                        <option value="">Select account type</option>
                        <option value="Checking">Checking</option>
                        <option value="Savings">Savings</option>
                        <option value="Business">Business</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Routing Number *
                      </label>
                      <input
                        type="text"
                        value={paymentMethodData.routingNumber || ''}
                        onChange={(e) => {
                          const value = e.target.value.replace(/\D/g, '').slice(0, 9);
                          setPaymentMethodData(prev => ({ ...prev, routingNumber: value }));
                          if (paymentMethodErrors.routingNumber) {
                            setPaymentMethodErrors((prev: any) => ({ ...prev, routingNumber: undefined }));
                          }
                        }}
                        placeholder="123456789"
                        maxLength={9}
                        className={`w-full px-3 py-2 border ${paymentMethodErrors.routingNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                        required
                      />
                      {paymentMethodErrors.routingNumber && (
                        <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.routingNumber}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Number *
                      </label>
                      <div className="relative">
                        <input
                          type={showAccountNumber ? 'text' : 'password'}
                          value={paymentMethodData.accountNumber || ''}
                          onChange={(e) => {
                            setPaymentMethodData(prev => ({ ...prev, accountNumber: e.target.value }));
                            if (paymentMethodErrors.accountNumber) {
                              setPaymentMethodErrors((prev: any) => ({ ...prev, accountNumber: undefined }));
                            }
                          }}
                          placeholder="Enter account number"
                          className={`w-full px-3 py-2 pr-10 border ${paymentMethodErrors.accountNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                          required
                        />
                        <button
                          type="button"
                          onClick={() => setShowAccountNumber(!showAccountNumber)}
                          className="absolute inset-y-0 right-0 pr-3 flex items-center"
                        >
                          <Eye className={`h-4 w-4 ${showAccountNumber ? 'text-oe-primary' : 'text-gray-400'}`} />
                        </button>
                      </div>
                      {paymentMethodErrors.accountNumber && (
                        <p className="text-red-500 text-xs mt-1">{paymentMethodErrors.accountNumber}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Account Holder Name *
                      </label>
                      <input
                        type="text"
                        value={paymentMethodData.accountHolderName || ''}
                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, accountHolderName: e.target.value }))}
                        placeholder="Enter account holder name"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        required
                      />
                    </div>
                  </>
                )}

                {/* Billing Address Section */}
                <div className="border-t border-gray-200 pt-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Billing Address</h3>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Address
                    </label>
                    <input
                      type="text"
                      value={paymentMethodData.billingAddress || ''}
                      onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingAddress: e.target.value }))}
                      placeholder="123 Main Street"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Address Line 2
                    </label>
                    <input
                      type="text"
                      value={paymentMethodData.billingAddress2 || ''}
                      onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingAddress2: e.target.value }))}
                      placeholder="Apt 4B"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        City
                      </label>
                      <input
                        type="text"
                        value={paymentMethodData.billingCity || ''}
                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingCity: e.target.value }))}
                        placeholder="Anytown"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        State <span className="text-red-500">*</span>
                      </label>
                      {paymentMethodErrors.billingState && (
                        <p className="text-red-500 text-xs mb-1">{paymentMethodErrors.billingState}</p>
                      )}
                      <select
                        value={paymentMethodData.billingState || ''}
                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingState: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      >
                        <option value="">Select State</option>
                        {US_STATES_FORMATTED.map((state: { value: string; label: string }) => (
                          <option key={state.value} value={state.value}>
                            {state.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        ZIP Code
                      </label>
                      <input
                        type="text"
                        value={paymentMethodData.billingZip || ''}
                        onChange={(e) => setPaymentMethodData(prev => ({ ...prev, billingZip: e.target.value }))}
                        placeholder="12345"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone Number
                    </label>
                    <input
                      type="tel"
                      value={paymentMethodData.phoneNumber || ''}
                      onChange={(e) => {
                        setPaymentMethodData(prev => ({ ...prev, phoneNumber: e.target.value }));
                        if (paymentMethodErrors.phoneNumber) {
                          setPaymentMethodErrors((prev: any) => ({ ...prev, phoneNumber: undefined }));
                        }
                      }}
                      placeholder="+1 (555) 123-4567"
                      className={`w-full px-3 py-2 border ${paymentMethodErrors.phoneNumber ? 'border-red-500' : 'border-gray-300'} rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                    />
                    {paymentMethodErrors.phoneNumber && (
                      <p className="mt-1 text-sm text-red-600">{paymentMethodErrors.phoneNumber}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 bg-gray-50 flex justify-end space-x-3">
              <button
                onClick={() => setShowAddPaymentMethod(false)}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAddPaymentMethod}
                disabled={isUpdatingPayment || !paymentMethodData.paymentMethodType}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isUpdatingPayment ? 'Saving...' : 'Add Payment Method'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Enrollment Completion Wizard */}
      <EnrollmentCompletionWizard
        isOpen={showCompletionWizard}
        onClose={() => setShowCompletionWizard(false)}
        onComplete={handleCompletionWizardComplete}
        productAcknowledgements={productAcknowledgements}
        memberInfo={{
          firstName: memberProfile?.firstName || '',
          lastName: memberProfile?.lastName || '',
          email: memberProfile?.email || '',
          phone: memberProfile?.phone || '',
          dateOfBirth: memberProfile?.dateOfBirth || '',
          gender: memberProfile?.gender || '',
          tobaccoUse: memberProfile?.tobaccoUse || 'No',
          address: memberProfile?.address || '',
          city: memberProfile?.city || '',
          state: memberProfile?.state || '',
          zip: memberProfile?.zip || memberProfile?.zipCode || '',
          hasSpouse: householdData?.householdMembers?.some((m: any) => m.relationshipType === 'S') || false,
          childrenCount: householdData?.householdMembers?.filter((m: any) => m.relationshipType === 'C').length || 0
        }}
        selectedProducts={selectedProducts
          .filter(productId => !removedProducts.includes(productId))
          .map(productId => {
            const product = products.find(p => p.productId === productId);
            return {
              productId,
              productName: product?.name || '',
              monthlyPremium: product?.isBundle 
                ? getBundleTotalPrice(product)
                : (productPrices[productId] || product?.basePrice || 0)
            };
          })
        }
        loading={completionLoading}
        pdfUrl={pdfUrl}
        // Contribution-related props - use the same calculation as Plan Summary
        products={[]} // Not needed since we're using newTotal directly
        selectedConfigs={{}}
        allProductsRules={[]}
        calculatedTotal={newTotal} // Pass the exact same total as Plan Summary
        // Payment-related props
        isGroupMember={isGroupMember}
        // Payment method selection props for non-group members
        availablePaymentMethods={availablePaymentMethods}
        selectedPaymentMethodId={selectedPaymentMethodId}
        // Effective date for billing calculation (not shown to user, backend calculates)
        effectiveDate={new Date().toISOString().split('T')[0]}
        onPaymentMethodSelect={setSelectedPaymentMethodId}
        onAddPaymentMethod={() => setShowAddPaymentMethod(true)}
        paymentMethodLoading={paymentMethodLoading}
        onPaymentMethodAdded={() => {
          // Auto-advance to next step after payment method is added
          // This will be handled by the wizard's internal navigation
        }}
        shouldAutoAdvance={shouldAutoAdvance}
        onAutoAdvanceComplete={() => setShouldAutoAdvance(false)}
      />

      {/* PDF Download Modal */}
      {showPdfModal && pdfUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl h-[90vh] flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-gray-200">
              <h2 className="text-xl font-semibold text-gray-800">Enrollment Document</h2>
              <button 
                onClick={() => setShowPdfModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="flex-1 p-4">
              <iframe
                src={pdfUrl}
                title="Enrollment Document"
                className="w-full h-full border-0"
              />
            </div>
            <div className="p-4 border-t border-gray-200 flex justify-end space-x-3">
              <button
                onClick={() => setShowPdfModal(false)}
                className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
              >
                Close
              </button>
              <a
                href={pdfUrl}
                download="enrollment-document.pdf"
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
              >
                Download PDF
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProductChangePage;
