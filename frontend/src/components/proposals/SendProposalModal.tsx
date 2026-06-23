// frontend/src/components/proposals/SendProposalModal.tsx
// Modal for sending proposals to prospects

import { AlertCircle, Download, Link as LinkIcon, Mail, MessageSquare, Send, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import SearchableDropdown from '../common/SearchableDropdown';
import OutboundEmailSenderNotice from '../shared/OutboundEmailSenderNotice';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';
import BusinessProposalService from '../../services/businessProposal.service';
import { AgeBand, AgeBandTierCounts, AgeBandTierPrices, TierPrices } from '../../services/proposalCalculation.service';
import ProposalService, { ProposalDocument, ProposalField } from '../../services/proposal.service';
import { InputSection } from '../proposal-editor/calcTypeMetadata';
import { deriveRequiredInputs, FormSection } from '../../utils/calcInputRequirements';
import { TenantAdminAgentsService } from '../../services/tenant-admin/agents.service';

interface SendProposalModalProps {
  isOpen: boolean;
  onClose: () => void;
  // productId and bundleProductId removed - pricing placeholders in the document handle product selection
  /** Optional: pre-fill prospect info (e.g. when opened from a Prospect's detail view). */
  initialProspect?: { name?: string; email?: string; phone?: string };
  /** Optional: called after a proposal is successfully sent. */
  onSent?: () => void;
}

interface EnrollmentLinkTemplate {
  templateId: string;
  templateName: string;
  templateType: string;
  description?: string;
}

interface LinkProductSection {
  productType?: string;
  includeAllProducts?: boolean;
  specificProducts?: string[];
  includeAllBundles?: boolean;
  specificBundles?: string[];
}

interface StaticEnrollmentLink {
  linkId: string;
  linkUrl: string;
  templateId: string;
  templateName: string;
  description?: string;
  usageCount?: number;
  productsPreview?: string; // Preview of products/bundles in the template
  productSections?: LinkProductSection[]; // Parsed LinkMetaData.products, used to detect coverage gaps vs proposal slots
}

// Returns the proposal slots NOT covered by the link's product sections.
// A slot is covered if any section either lists slot.productId in specificProducts,
// or has includeAllProducts:true and a productType that matches the slot (or no productType, treated as wildcard).
// Bundle membership is NOT expanded — links covering a slot's product only via a bundle will surface as a warning.
function findUncoveredSlots(
  slots: import('../../services/proposal.service').ProductSlot[],
  sections: LinkProductSection[] | undefined
): import('../../services/proposal.service').ProductSlot[] {
  if (!sections || sections.length === 0) return slots;
  return slots.filter(slot => {
    return !sections.some(section => {
      if (section.specificProducts && section.specificProducts.includes(slot.productId)) return true;
      if (section.includeAllProducts) {
        const sectionType = (section.productType || '').trim();
        if (!sectionType) return true; // wildcard section
        if (!slot.productType) return false;
        return sectionType.toLowerCase() === slot.productType.toLowerCase();
      }
      return false;
    });
  });
}

const SendProposalModal: React.FC<SendProposalModalProps> = ({
  isOpen,
  onClose,
  initialProspect,
  onSent,
}) => {
  const { user } = useAuth();
  const isTenantAdmin = user?.currentRole === 'TenantAdmin';
  const isAgent = user?.currentRole === 'Agent';

  const [proposalDocuments, setProposalDocuments] = useState<ProposalDocument[]>([]);
  // TenantAdmin: which agent the proposal is for (required for TenantAdmin)
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [agentOptions, setAgentOptions] = useState<Array<{ id: string; label: string; value: string; email?: string }>>([]);
  const [agentSearchLoading, setAgentSearchLoading] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string>('');
  const [selectedDocument, setSelectedDocument] = useState<ProposalDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Enrollment link templates
  const [enrollmentLinkTemplates, setEnrollmentLinkTemplates] = useState<EnrollmentLinkTemplate[]>([]);
  const [staticEnrollmentLinks, setStaticEnrollmentLinks] = useState<StaticEnrollmentLink[]>([]);
  const [enrollmentLinkSelections, setEnrollmentLinkSelections] = useState<Record<string, string>>({}); // fieldId -> linkId
  const [enrollmentLinkUrls, setEnrollmentLinkUrls] = useState<Record<string, string>>({}); // linkId -> url
  const [customUrlSelections, setCustomUrlSelections] = useState<Record<string, boolean>>({}); // fieldId -> useCustomUrl
  const [customUrls, setCustomUrls] = useState<Record<string, string>>({}); // fieldId -> customUrl
  
  // Prospect information
  const [prospectName, setProspectName] = useState('');
  const [prospectEmail, setProspectEmail] = useState('');
  const [prospectPhone, setProspectPhone] = useState('');
  const [prospectAddress, setProspectAddress] = useState('');
  const [prospectAge, setProspectAge] = useState<number | null>(null);
  
  // Custom field values (fieldId -> value)
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, string>>({});
  
  // Household information
  const [hasSpouse, setHasSpouse] = useState(false);
  const [childrenCount, setChildrenCount] = useState<number>(0);
  const [childrenCountInput, setChildrenCountInput] = useState<string>('0');
  const [tobaccoUse, setTobaccoUse] = useState(false);
  
  // Send method
  const [sendMethod, setSendMethod] = useState<'email' | 'text' | 'download'>('download');
  
  // Message content for email/text
  const [emailMessage, setEmailMessage] = useState('');
  const [textMessage, setTextMessage] = useState('');
  
  // Generated PDF tracking
  const [generatedPdfUrl, setGeneratedPdfUrl] = useState<string | null>(null);
  const [formDataHash, setFormDataHash] = useState<string>('');
  
  // Calculated values
  const [calculatedTier, setCalculatedTier] = useState<string>('');
  const [calculatedAge, setCalculatedAge] = useState<number | null>(null);

  // Agent profile for validation
  const [agentProfile, setAgentProfile] = useState<any>(null);
  const [tenantFromEmail, setTenantFromEmail] = useState<string | null>(null);

  // ====== Proposal Mode ======
  const [proposalMode, setProposalMode] = useState<'individual' | 'business'>('individual');

  // ====== Business proposal state ======
  const [companyName, setCompanyName] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');
  const [hasExistingCoverage, setHasExistingCoverage] = useState(false);
  const [currentCountEE, setCurrentCountEE] = useState<number>(0);
  const [currentCountE1, setCurrentCountE1] = useState<number>(0);
  const [currentCountEF, setCurrentCountEF] = useState<number>(0);
  const [currentPremiumEE, setCurrentPremiumEE] = useState<number>(0);
  const [currentPremiumE1, setCurrentPremiumE1] = useState<number>(0);
  const [currentPremiumEF, setCurrentPremiumEF] = useState<number>(0);
  const [currentContributionType, setCurrentContributionType] = useState<'flat' | 'per_tier'>('flat');
  const [currentContributionValueType, setCurrentContributionValueType] = useState<'dollar' | 'percentage'>('dollar');
  const [currentContributionValue, setCurrentContributionValue] = useState<number>(0);
  const [currentContributionValueEE, setCurrentContributionValueEE] = useState<number>(0);
  const [currentContributionValueE1, setCurrentContributionValueE1] = useState<number>(0);
  const [currentContributionValueEF, setCurrentContributionValueEF] = useState<number>(0);
  const [totalEmployees, setTotalEmployees] = useState<number>(0);
  const [estimatedEnrollmentPct, setEstimatedEnrollmentPct] = useState<number>(50);
  const [tierCountEE, setTierCountEE] = useState<number>(0);
  const [tierCountE1, setTierCountE1] = useState<number>(0);
  const [tierCountEF, setTierCountEF] = useState<number>(0);
  const [unsharedAmount, setUnsharedAmount] = useState<string>('');
  const [unsharedAmountOptions, setUnsharedAmountOptions] = useState<string[]>([]);
  const [configFieldLabel, setConfigFieldLabel] = useState<string>('Default Unshared Amount');
  const [tierPrices, setTierPrices] = useState<TierPrices>({ EE: 0, ES: 0, EC: 0, EF: 0 });
  const [businessCalculationResults, setBusinessCalculationResults] = useState<Record<string, string | number>>({});
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');

  // Employer contribution
  const [contributionType, setContributionType] = useState<'flat' | 'per_tier'>('flat');
  const [contributionValueType, setContributionValueType] = useState<'dollar' | 'percentage'>('dollar');
  const [contributionValue, setContributionValue] = useState<number>(0);
  const [contributionValueEE, setContributionValueEE] = useState<number>(0);
  const [contributionValueE1, setContributionValueE1] = useState<number>(0);
  const [contributionValueEF, setContributionValueEF] = useState<number>(0);

  // Partial switch (per-tier)
  const [currentRemainCountEE, setCurrentRemainCountEE] = useState<number>(0);
  const [currentRemainCountE1, setCurrentRemainCountE1] = useState<number>(0);
  const [currentRemainCountEF, setCurrentRemainCountEF] = useState<number>(0);

  // Enrollment date
  const [enrollmentDate, setEnrollmentDate] = useState('');

  // Required input sections (derived from document calc fields)
  const [requiredSections, setRequiredSections] = useState<Set<InputSection>>(new Set());
  const needsSection = (section: InputSection) => requiredSections.has(section);

  // Required individual inputs — used for finer-grained conditional rendering
  // within a section (e.g. show tier-count inputs but not tier-premium inputs
  // when the template only uses calcCurrentEnrollmentPct).
  const [requiredInputs, setRequiredInputs] = useState<Set<string>>(new Set());
  const needsInput = (name: string) => requiredInputs.has(name);

  const mapFormSectionsToInputSections = (sections: Set<FormSection>): Set<InputSection> => {
    const mapped = new Set<InputSection>();
    sections.forEach((section) => {
      if (section === 'mwTierCounts') mapped.add('tierCounts');
      else if (section === 'planConfig') mapped.add('oopLevel');
      else if (section === 'partialSwitch') mapped.add('currentRemainCount');
      else mapped.add(section as InputSection);
    });
    return mapped;
  };

  // Product discovery from price fields
  const [involvedProducts, setInvolvedProducts] = useState<Array<{ productId: string; configValues: string[]; hasAgeBands: boolean; slotNumber: number }>>([]);
  const [hasAgeBandedPricing, setHasAgeBandedPricing] = useState(false);
  // Dynamic age bands discovered from product pricing tiers
  const [ageBands, setAgeBands] = useState<AgeBand[]>([]);
  // Age-banded tier counts and prices (dynamic N bands)
  const [ageBandTierCounts, setAgeBandTierCounts] = useState<AgeBandTierCounts[]>([]);
  const [ageBandTierPrices, setAgeBandTierPrices] = useState<AgeBandTierPrices[]>([]);

  // Per-slot tier prices for multi-product comparison proposals
  const [allSlotTierPrices, setAllSlotTierPrices] = useState<Array<{
    slotNumber: number;
    productId: string;
    tierPrices: TierPrices;
    ageBandTierPrices?: AgeBandTierPrices[];
  }>>([]);


  useEffect(() => {
    if (isOpen) {
      loadProposalDocuments();
      if (isTenantAdmin) {
        loadAgentsForTenantAdmin();
      } else if (isAgent) {
        loadEnrollmentLinkTemplates();
        loadStaticEnrollmentLinks();
        loadAgentProfile();
      }
      // Seed prefill fields after the modal opens (runs after resetForm has already cleared)
      if (initialProspect?.name) setProspectName(initialProspect.name);
      if (initialProspect?.email) setProspectEmail(initialProspect.email);
      if (initialProspect?.phone) setProspectPhone(initialProspect.phone);
    } else {
      // Reset form when modal closes
      resetForm();
      setSelectedAgentId('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isTenantAdmin, isAgent]);

  // When TenantAdmin selects an agent, load that agent's static links and profile
  useEffect(() => {
    if (isOpen && isTenantAdmin && selectedAgentId) {
      loadStaticEnrollmentLinks(selectedAgentId);
      loadAgentProfileForTenantAdmin(selectedAgentId);
    }
  }, [isOpen, isTenantAdmin, selectedAgentId]);

  useEffect(() => {
    // Load selected document details when document changes
    if (selectedDocumentId) {
      loadSelectedDocument();
    } else {
      setSelectedDocument(null);
    }
  }, [selectedDocumentId]);

  useEffect(() => {
    // Sync input display with childrenCount value
    setChildrenCountInput(childrenCount.toString());
  }, [childrenCount]);

  useEffect(() => {
    // Calculate tier when household info changes
    if (hasSpouse !== undefined && childrenCount !== undefined) {
      const tier = calculateTier(hasSpouse, childrenCount);
      setCalculatedTier(tier);
    }
  }, [hasSpouse, childrenCount]);

  useEffect(() => {
    // Set calculated age directly from prospect age
    setCalculatedAge(prospectAge);
  }, [prospectAge]);

  // Clear generated PDF when form data changes (allowing re-generation)
  useEffect(() => {
    if (!generatedPdfUrl) {
      // No PDF generated yet, just update hash
      const currentHash = JSON.stringify({
        selectedDocumentId,
        prospectName,
        prospectEmail,
        prospectPhone,
        prospectAddress,
        prospectAge,
        hasSpouse,
        childrenCount,
        tobaccoUse,
        calculatedTier,
        calculatedAge,
        enrollmentLinkSelections,
        customUrls,
        customUrlSelections,
        customFieldValues
      });
      setFormDataHash(currentHash);
      return;
    }
    
    const currentHash = JSON.stringify({
      selectedDocumentId,
      prospectName,
      prospectEmail,
      prospectPhone,
      prospectAddress,
      prospectAge,
      hasSpouse,
      childrenCount,
      tobaccoUse,
      calculatedTier,
      calculatedAge,
      enrollmentLinkSelections,
      customUrls,
      customUrlSelections
    });
    
    if (formDataHash && currentHash !== formDataHash) {
      // Form data changed, clear generated PDF
      setGeneratedPdfUrl(null);
    }
    
    setFormDataHash(currentHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedDocumentId,
    prospectName,
    prospectEmail,
    prospectPhone,
    prospectAddress,
    prospectAge,
    hasSpouse,
    childrenCount,
    tobaccoUse,
    calculatedTier,
    calculatedAge,
    enrollmentLinkSelections,
    customUrls,
    customUrlSelections
  ]);

  // Auto-select first static enrollment link for all enrollment link fields when document and links are loaded
  useEffect(() => {
    if (selectedDocument && selectedDocument.fields && staticEnrollmentLinks.length > 0) {
      const enrollmentLinkFields = selectedDocument.fields.filter(f => f.fieldType === 'link' && f.linkType === 'enrollment_link');
      if (enrollmentLinkFields.length > 0) {
        const firstLinkId = staticEnrollmentLinks[0].linkId;
        setEnrollmentLinkSelections(prev => {
          const updated = { ...prev };
          let hasChanges = false;
          enrollmentLinkFields.forEach(field => {
            const fieldId = field.fieldId || '';
            // Only auto-select if not already selected
            if (!updated[fieldId]) {
              updated[fieldId] = firstLinkId;
              hasChanges = true;
            }
          });
          return hasChanges ? updated : prev;
        });
      }
    }
  }, [selectedDocument, staticEnrollmentLinks]);

  // ====== Business-specific useEffects ======

  // Product discovery: read product slots from the template and detect age bands from product data
  useEffect(() => {
    const discoverProducts = async () => {
      if (proposalMode !== 'business' || !selectedDocument) {
        setInvolvedProducts([]);
        setHasAgeBandedPricing(false);
        setAgeBands([]);
        return;
      }

      // Read product slots from the template (set by SysAdmin in the editor)
      const slots = selectedDocument.productSlots || [];
      if (slots.length === 0) {
        // Fallback: scan price fields for backward compatibility
        const productMap = new Map<string, Set<string>>();
        for (const field of (selectedDocument.fields || [])) {
          if (field.fieldType === 'price' && field.productId) {
            if (!productMap.has(field.productId)) {
              productMap.set(field.productId, new Set());
            }
            if (field.configValue) {
              productMap.get(field.productId)!.add(field.configValue);
            }
          }
        }
        if (productMap.size === 0) {
          setInvolvedProducts([]);
          setHasAgeBandedPricing(false);
          setAgeBands([]);
          return;
        }
        const legacyProducts: Array<{ productId: string; configValues: string[]; hasAgeBands: boolean; slotNumber: number }> = [];
        let legacySlot = 1;
        for (const [productId, configValuesSet] of productMap) {
          legacyProducts.push({ productId, configValues: Array.from(configValuesSet), hasAgeBands: false, slotNumber: legacySlot++ });
        }
        setInvolvedProducts(legacyProducts);
        setHasAgeBandedPricing(false);
        setAgeBands([]);
        return;
      }

      // Helper: extract unique age band ranges from a product's PricingTiers
      const extractAgeBands = (productData: any): AgeBand[] => {
        const pricingTiers = productData.PricingTiers || productData.pricingTiers || [];
        if (!Array.isArray(pricingTiers) || pricingTiers.length === 0) return [];
        
        // Use the first tier type to discover age bands (they should be consistent)
        const firstTier = pricingTiers[0];
        const bands = firstTier.ageBands || firstTier.AgeBands || [];
        if (!Array.isArray(bands) || bands.length <= 1) return [];
        
        // Get distinct minAge/maxAge pairs (filter to non-tobacco for consistency)
        const seen = new Set<string>();
        const result: AgeBand[] = [];
        for (const band of bands) {
          const tobacco = band.tobaccoStatus || band.TobaccoStatus || 'No';
          if (tobacco !== 'No' && tobacco !== 'N/A' && tobacco !== 'Unknown') continue;
          const min = band.minAge ?? band.MinAge ?? 0;
          const max = band.maxAge ?? band.MaxAge ?? 999;
          const key = `${min}-${max}`;
          if (!seen.has(key)) {
            seen.add(key);
            const label = max >= 150 || max >= 999 ? `${min}+` : `${min}-${max}`;
            result.push({ label, minAge: min, maxAge: max });
          }
        }
        result.sort((a, b) => a.minAge - b.minAge);
        return result;
      };

      // Build involvedProducts from product slots and discover age bands
      const products: Array<{ productId: string; configValues: string[]; hasAgeBands: boolean; slotNumber: number }> = [];
      let discoveredAgeBands: AgeBand[] = [];

      for (const slot of slots) {
        if (!slot.productId) continue;
        let hasAgeBands = false;

        // Fetch product data to discover age bands from PricingTiers
        try {
          const response = await apiService.get(`/api/products/${slot.productId}`);
          // The /api/products/:id endpoint returns { success, product } (not { success, data })
          const productData = (response as any).product || (response as any).data;
          if ((response as any).success && productData) {
            let bands = extractAgeBands(productData);

            // If this is a bundle and no age bands found, check included products
            if (bands.length === 0 && (productData.IsBundle || productData.isBundle)) {
              try {
                const bundleResp = await apiService.get(`/api/products/${slot.productId}/bundle-products`);
                if ((bundleResp as any).success && Array.isArray((bundleResp as any).data)) {
                  for (const included of (bundleResp as any).data) {
                    // Bundle products endpoint returns raw data; try to get full pricing tiers
                    try {
                      const inclResp = await apiService.get(`/api/products/${included.IncludedProductId || included.includedProductId}`);
                      const inclProductData = (inclResp as any).product || (inclResp as any).data;
                      if ((inclResp as any).success && inclProductData) {
                        const inclBands = extractAgeBands(inclProductData);
                        if (inclBands.length > bands.length) {
                          bands = inclBands;
                        }
                      }
                    } catch { /* skip */ }
                  }
                }
              } catch { /* skip */ }
            }

            if (bands.length > 1) {
              hasAgeBands = true;
              // Use the most granular age bands found across all products
              if (bands.length > discoveredAgeBands.length) {
                discoveredAgeBands = bands;
              }
            }
          }
        } catch (err) {
          console.error(`Error discovering age bands for product ${slot.productId}:`, err);
        }

        products.push({ productId: slot.productId, configValues: [], hasAgeBands, slotNumber: slot.slotNumber });
      }

      setInvolvedProducts(products);
      setAgeBands(discoveredAgeBands);
      setHasAgeBandedPricing(discoveredAgeBands.length > 1);

      // Initialize age band tier counts when bands change
      if (discoveredAgeBands.length > 1) {
        setAgeBandTierCounts(discoveredAgeBands.map(b => ({
          label: b.label, minAge: b.minAge, maxAge: b.maxAge,
          counts: { EE: 0, ES: 0, EC: 0, EF: 0 }
        })));
      } else {
        setAgeBandTierCounts([]);
      }
    };

    discoverProducts();
  }, [selectedDocument, proposalMode]);

  // Load unshared amount options from discovered products (business mode)
  useEffect(() => {
    if (proposalMode !== 'business' || !selectedDocument?.fields) return;
    loadUnsharedAmountOptions();
  }, [selectedDocument, proposalMode, involvedProducts]);

  // Fetch tier prices when unshared amount or document changes (business mode)
  // Fetches prices for ALL product slots and ALL age bands (dynamic).
  useEffect(() => {
    const fetchTierPrices = async () => {
      if (proposalMode !== 'business' || !selectedDocument?.fields) {
        setTierPrices({ EE: 0, ES: 0, EC: 0, EF: 0 });
        setAgeBandTierPrices([]);
        setAllSlotTierPrices([]);
        return;
      }
      // If the product requires a config value (unshared amount), wait until one is selected
      if (unsharedAmountOptions.length > 0 && !unsharedAmount) {
        setTierPrices({ EE: 0, ES: 0, EC: 0, EF: 0 });
        setAgeBandTierPrices([]);
        setAllSlotTierPrices([]);
        return;
      }
      
      if (involvedProducts.length === 0) return;

      try {
        const tiers: Array<'EE' | 'ES' | 'EC' | 'EF'> = ['EE', 'ES', 'EC', 'EF'];
        const slotPricesArr: Array<{
          slotNumber: number;
          productId: string;
          tierPrices: TierPrices;
          ageBandTierPrices?: AgeBandTierPrices[];
        }> = [];

        // Helper: get representative age for an age band (midpoint)
        const getRepresentativeAge = (band: AgeBand): number => {
          const max = band.maxAge >= 150 ? 65 : band.maxAge;
          return Math.round((band.minAge + max) / 2);
        };

        // Fetch prices for EACH product slot
        for (let i = 0; i < involvedProducts.length; i++) {
          const product = involvedProducts[i];
          const slotNumber = product.slotNumber || (i + 1);

          if (hasAgeBandedPricing && ageBands.length > 1 && product.hasAgeBands) {
            // Fetch prices for each dynamic age band for this product
            const bandPrices: AgeBandTierPrices[] = [];
            
            for (const band of ageBands) {
              const repAge = getRepresentativeAge(band);
              const prices: TierPrices = { EE: 0, ES: 0, EC: 0, EF: 0 };
              
              for (const tier of tiers) {
                try {
                  const resp = await apiService.post<{
                    success: boolean;
                    data: { products: Array<{ productId: string; monthlyPremium: number }> };
                  }>('/api/pricing/calculate', {
                    calculationType: 'enrollment',
                    memberCriteria: { age: repAge, tobaccoUse: 'No', tier, householdSize: 1 },
                    productSelections: [{ productId: product.productId, configValues: unsharedAmount ? { ConfigValue1: unsharedAmount } : {} }]
                  });
                  prices[tier] = resp.success ? resp.data?.products?.[0]?.monthlyPremium || 0 : 0;
                } catch { /* default 0 */ }
              }
              
              bandPrices.push({ label: band.label, minAge: band.minAge, maxAge: band.maxAge, prices });
            }
            
            // Primary tier prices = last (oldest) age band prices
            const primaryPrices = bandPrices[bandPrices.length - 1].prices;
            
            slotPricesArr.push({
              slotNumber,
              productId: product.productId,
              tierPrices: primaryPrices,
              ageBandTierPrices: bandPrices
            });

            // First product sets the "primary" state for UI display
            if (i === 0) {
              setAgeBandTierPrices(bandPrices);
              setTierPrices(primaryPrices);
            }
          } else {
            // Single price set (no age banding) for this product
            const prices: TierPrices = { EE: 0, ES: 0, EC: 0, EF: 0 };
            for (const tier of tiers) {
              try {
                const response = await apiService.post<{
                  success: boolean;
                  data: { products: Array<{ productId: string; monthlyPremium: number }> };
                }>('/api/pricing/calculate', {
                  calculationType: 'enrollment',
                  memberCriteria: { age: 30, tobaccoUse: 'No', tier, householdSize: 1 },
                  productSelections: [{ productId: product.productId, configValues: unsharedAmount ? { ConfigValue1: unsharedAmount } : {} }]
                });
                if (response.success && response.data?.products?.[0]) {
                  prices[tier] = response.data.products[0].monthlyPremium || 0;
                }
              } catch { /* default 0 */ }
            }

            slotPricesArr.push({
              slotNumber,
              productId: product.productId,
              tierPrices: prices
            });

            // First product sets the "primary" state for UI display
            if (i === 0) {
              setTierPrices(prices);
            }
          }
        }

        setAllSlotTierPrices(slotPricesArr);
      } catch (err) {
        console.error('Error fetching tier prices:', err);
      }
    };
    fetchTierPrices();
  }, [selectedDocument, unsharedAmount, unsharedAmountOptions, proposalMode, involvedProducts, hasAgeBandedPricing, ageBands]);

  // Business calculations are now handled entirely server-side.
  // This modal only shows General-category documents (individual proposals).
  // Business proposals go through BusinessProposalModal instead.
  useEffect(() => {
    if (proposalMode !== 'business' || !selectedDocument || totalEmployees <= 0) {
      setBusinessCalculationResults({});
      return;
    }
    // Business mode should not be reachable in this modal (General docs only),
    // but clear results as a safety net.
    setBusinessCalculationResults({});
  }, [proposalMode, selectedDocument, totalEmployees]);

  // Don't clear generated PDF when switching send methods - reuse it if form data hasn't changed

  const loadProposalDocuments = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // Load only General-category proposal documents (Business docs use BusinessProposalModal)
      const response = await ProposalService.getProposalDocuments({ category: 'General' });
      
      if (response.success && response.data) {
        setProposalDocuments(response.data);
        if (response.data.length > 0) {
          setSelectedDocumentId(response.data[0].proposalDocumentId);
        }
      }
    } catch (err: any) {
      console.error('Error loading proposal documents:', err);
      setError(err.message || 'Failed to load proposal documents');
    } finally {
      setLoading(false);
    }
  };

  const loadSelectedDocument = async () => {
    try {
      if (!selectedDocumentId) return;
      
      // Immediately clear stale state from the previous document
      // so the UI doesn't flash old slot data while the new document loads
      setInvolvedProducts([]);
      setAllSlotTierPrices([]);
      setBusinessCalculationResults({});
      setHasAgeBandedPricing(false);
      setGeneratedPdfUrl(null);
      
      const response = await ProposalService.getProposalDocument(selectedDocumentId);
      if (response.success && response.data) {
        setSelectedDocument(response.data);
        // Auto-detect proposal mode and required inputs from the document's fields
        const calcFieldNames = (response.data.fields || [])
          .filter((f: ProposalField) => f.fieldType === 'calculation' && f.fieldName)
          .map((f: ProposalField) => f.fieldName!);
        const businessCalcFields = calcFieldNames.filter(
          (n: string) => n.startsWith('calc')
        );
        const hasBusinessFields = businessCalcFields.length > 0;
        setProposalMode(hasBusinessFields ? 'business' : 'individual');
        if (hasBusinessFields) {
          const { requiredSections: formSections, requiredInputs: formInputs } = deriveRequiredInputs(response.data.fields || []);
          setRequiredSections(mapFormSectionsToInputSections(formSections));
          setRequiredInputs(formInputs);
        } else {
          setRequiredSections(new Set());
          setRequiredInputs(new Set());
        }
        // Reset enrollment link selections when document changes
        setEnrollmentLinkSelections({});
        setCustomUrlSelections({});
        setCustomUrls({});
      }
    } catch (err: any) {
      console.error('Error loading selected document:', err);
    }
  };

  const loadEnrollmentLinkTemplates = async () => {
    try {
      // Load enrollment link templates for the agent
      const response = await apiService.get('/api/me/agent/enrollment-links/available-templates');
      
      if ((response as any).success && (response as any).data) {
        setEnrollmentLinkTemplates((response as any).data);
        
        // After templates load, update static links with templateIds
        if (staticEnrollmentLinks.length > 0) {
          setStaticEnrollmentLinks(prev => prev.map(link => {
            const matchingTemplate = (response as any).data.find((t: EnrollmentLinkTemplate) => 
              t.templateName === link.templateName
            );
            return {
              ...link,
              templateId: matchingTemplate?.templateId || link.templateId
            };
          }));
        }
      }
    } catch (err: any) {
      console.error('Error loading enrollment link templates:', err);
      // Don't show error to user, just log it
    }
  };

  const loadAgentsForTenantAdmin = useCallback(async () => {
    try {
      setAgentSearchLoading(true);
      const response = await TenantAdminAgentsService.getAgentsAndAgencies({
        type: 'Agent',
        status: 'Active',
        page: 1,
        limit: 100
      });
      if (response.success && response.data && Array.isArray(response.data)) {
        const options = response.data
          .filter((a: { Type: string }) => a.Type === 'Agent')
          .map((a: { Id: string; Name: string; Email?: string }) => ({
            id: a.Id,
            label: a.Name || 'Unknown',
            value: a.Id,
            email: a.Email
          }));
        setAgentOptions(options);
      } else {
        setAgentOptions([]);
      }
    } catch (err) {
      console.error('Error loading agents for TenantAdmin:', err);
      setAgentOptions([]);
    } finally {
      setAgentSearchLoading(false);
    }
  }, []);

  const loadAgentProfileForTenantAdmin = useCallback(async (agentId: string) => {
    try {
      const response = await TenantAdminAgentsService.getAgentDetails(agentId);
      if (response.success && response.data) {
        const d = response.data as any;
        // Map tenant-admin agent detail to agentProfile shape (FirstName, LastName, etc.)
        const name = d.Name || d.name || '';
        const parts = name.trim().split(/\s+/);
        const firstName = d.FirstName ?? d.firstName ?? parts[0] ?? '';
        const lastName = d.LastName ?? d.lastName ?? (parts.length > 1 ? parts.slice(1).join(' ') : '');
        setAgentProfile({
          FirstName: firstName,
          LastName: lastName,
          Email: d.Email ?? d.email ?? '',
          PhoneNumber: d.PhoneNumber ?? d.phoneNumber ?? d.Phone ?? d.phone ?? '',
          AgentPhone: d.AgentPhone ?? d.Phone ?? d.phone ?? '',
          ProfileImageUrl: d.ProfileImageUrl ?? d.profileImageUrl ?? '',
          Address1: d.Address1 ?? d.address1 ?? d.Address ?? '',
          Address2: d.Address2 ?? d.address2 ?? '',
          City: d.City ?? d.city ?? '',
          State: d.State ?? d.state ?? '',
          ZipCode: d.ZipCode ?? d.zipCode ?? ''
        });
      } else {
        setAgentProfile(null);
      }
    } catch (err) {
      console.error('Error loading agent profile for TenantAdmin:', err);
      setAgentProfile(null);
    }
  }, []);

  const loadStaticEnrollmentLinks = async (agentIdForTenantAdmin?: string) => {
    try {
      const url = isTenantAdmin && agentIdForTenantAdmin
        ? `/api/me/tenant-admin/enrollment-link-templates/static?agentId=${agentIdForTenantAdmin}&page=1&limit=100`
        : '/api/me/agent/enrollment-links/static';
      const response = await apiService.get(url);
      
      if ((response as any).success && (response as any).data) {
        // The endpoint now returns an array of static links
        const staticLinksData = Array.isArray((response as any).data) 
          ? (response as any).data 
          : [(response as any).data];
        
        if (staticLinksData.length > 0) {
          const links: StaticEnrollmentLink[] = staticLinksData.map((staticLink: any) => {
            // Parse LinkMetaData to extract product/bundle counts
            let productsPreview = '';
            let productSections: LinkProductSection[] | undefined;
            try {
              const metadata = staticLink.template?.metadata || staticLink.template?.LinkMetaData;
              if (metadata) {
                const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
                if (parsed.products && Array.isArray(parsed.products)) {
                  productSections = parsed.products.map((section: any): LinkProductSection => ({
                    productType: section.productType,
                    includeAllProducts: !!section.includeAllProducts,
                    specificProducts: Array.isArray(section.specificProducts) ? section.specificProducts : [],
                    includeAllBundles: !!section.includeAllBundles,
                    specificBundles: Array.isArray(section.specificBundles) ? section.specificBundles : []
                  }));

                  let productCount = 0;
                  let bundleCount = 0;
                  productSections.forEach((section) => {
                    if (section.includeAllProducts) {
                      // If including all products, we can't count them
                      productCount = -1; // Use -1 to indicate "all"
                    } else if (section.specificProducts) {
                      productCount += section.specificProducts.length;
                    }
                    if (section.includeAllBundles) {
                      // If including all bundles, we can't count them
                      bundleCount = -1; // Use -1 to indicate "all"
                    } else if (section.specificBundles) {
                      bundleCount += section.specificBundles.length;
                    }
                  });

                  const parts: string[] = [];
                  if (productCount > 0) {
                    parts.push(`${productCount} product${productCount > 1 ? 's' : ''}`);
                  } else if (productCount === -1) {
                    parts.push('All products');
                  }
                  if (bundleCount > 0) {
                    parts.push(`${bundleCount} bundle${bundleCount > 1 ? 's' : ''}`);
                  } else if (bundleCount === -1) {
                    parts.push('All bundles');
                  }

                  if (parts.length > 0) {
                    productsPreview = parts.join(', ');
                  }
                }
              }
            } catch (e) {
              // If parsing fails, just leave productsPreview empty
              console.warn('Failed to parse LinkMetaData for products preview:', e);
            }

            return {
              linkId: staticLink.linkId,
              linkUrl: staticLink.enrollmentUrl || staticLink.linkUrl,
              templateId: staticLink.templateId || staticLink.template?.id || '',
              templateName: staticLink.template?.name || 'Default Template',
              description: staticLink.description,
              usageCount: staticLink.usageCount || 0,
              productsPreview,
              productSections
            };
          });
          
          setStaticEnrollmentLinks(links);
          // TenantAdmin: derive enrollment link templates from static links (for dropdown)
          if (isTenantAdmin && agentIdForTenantAdmin) {
            const seen = new Set<string>();
            const templates: EnrollmentLinkTemplate[] = [];
            links.forEach(link => {
              if (link.templateId && !seen.has(link.templateId)) {
                seen.add(link.templateId);
                templates.push({
                  templateId: link.templateId,
                  templateName: link.templateName,
                  templateType: 'Individual',
                  description: link.description
                });
              }
            });
            setEnrollmentLinkTemplates(templates);
          }
          // Pre-populate URLs for existing links
          const urls: Record<string, string> = {};
          links.forEach(link => {
            urls[link.linkId] = link.linkUrl;
          });
          setEnrollmentLinkUrls(urls);
        } else {
          setStaticEnrollmentLinks([]);
          if (isTenantAdmin && agentIdForTenantAdmin) setEnrollmentLinkTemplates([]);
        }
      } else {
        setStaticEnrollmentLinks([]);
      }
    } catch (err: any) {
      console.error('Error loading static enrollment links:', err);
      // Don't show error to user, just log it
      setStaticEnrollmentLinks([]);
    }
  };

  const loadAgentProfile = async () => {
    try {
      const response = await apiService.get('/api/me/agent/profile');
      
      if ((response as any).success && (response as any).data) {
        setAgentProfile((response as any).data);
      }
    } catch (err: any) {
      console.error('Error loading agent profile:', err);
      // Don't show error to user, just log it
    }
  };

  const loadUnsharedAmountOptions = async () => {
    if (!selectedDocument) return;
    
    // Get the primary product ID from product slots or discovered products
    let primaryProductId: string | undefined;
    
    if (involvedProducts.length > 0) {
      primaryProductId = involvedProducts[0].productId;
      // If legacy path provided config values from price fields, use them
      if (involvedProducts[0].configValues.length > 0) {
        const sorted = [...involvedProducts[0].configValues].sort((a, b) => Number(a) - Number(b));
        setUnsharedAmountOptions(sorted);
        if (!unsharedAmount) {
          const midIdx = Math.floor(sorted.length / 2);
          setUnsharedAmount(sorted[midIdx]);
        }
        return;
      }
    }
    
    if (!primaryProductId) {
      // No product found — clear config options (don't show dropdown)
      setUnsharedAmountOptions([]);
      setConfigFieldLabel('');
      setUnsharedAmount('');
      return;
    }

    // Helper to extract config options from a product's configuration fields
    const extractConfigFromProduct = (product: any): { options: string[]; label: string } | null => {
      // The API returns ConfigurationFields (renamed from RequiredDataFields)
      const configFields = product.ConfigurationFields || product.configurationFields
        || product.RequiredDataFields || product.requiredDataFields;
      if (!configFields) return null;
      
      try {
        const parsed = typeof configFields === 'string' ? JSON.parse(configFields) : configFields;
        
        // Current DB format: array of field objects [{fieldName, fieldOptions, isDeductible}]
        if (Array.isArray(parsed)) {
          for (const field of parsed) {
            if (field.fieldOptions && Array.isArray(field.fieldOptions) && field.fieldOptions.length > 0) {
              const label = field.fieldName || (field.isDeductible ? 'Deductible' : 'Default Unshared Amount');
              return { options: field.fieldOptions.map(String), label };
            }
          }
        }
        
        // Legacy format: {ConfigValue1: {options: [...]}}
        if (parsed.ConfigValue1 && Array.isArray(parsed.ConfigValue1.options)) {
          return { options: parsed.ConfigValue1.options.map(String), label: 'Default Unshared Amount' };
        }
      } catch (e) { console.warn('Error parsing config fields:', e); }
      return null;
    };
    
    // Load config options from the product API
    try {
      const response = await apiService.get(`/api/products/${primaryProductId}`);
      // The /api/products/:id endpoint returns { success, product } (not { success, data })
      const product = (response as any).product || (response as any).data;
      if ((response as any).success && product) {
        
        // Try the product itself first
        const directConfig = extractConfigFromProduct(product);
        if (directConfig) {
          const sorted = [...directConfig.options].sort((a, b) => Number(a) - Number(b));
          setUnsharedAmountOptions(sorted);
          setConfigFieldLabel(directConfig.label);
          if (!unsharedAmount && sorted.length > 0) {
            const midIdx = Math.floor(sorted.length / 2);
            setUnsharedAmount(sorted[midIdx]);
          }
          return;
        }
        
        // For bundles: check included products for config options
        if (product.IsBundle || product.isBundle) {
          try {
            const bundleResp = await apiService.get(`/api/products/${primaryProductId}/bundle-products`);
            if ((bundleResp as any).success && Array.isArray((bundleResp as any).data)) {
              for (const includedProduct of (bundleResp as any).data) {
                const bundleConfig = extractConfigFromProduct(includedProduct);
                if (bundleConfig) {
                  const sorted = [...bundleConfig.options].sort((a, b) => Number(a) - Number(b));
                  setUnsharedAmountOptions(sorted);
                  setConfigFieldLabel(bundleConfig.label);
                  if (!unsharedAmount && sorted.length > 0) {
                    const midIdx = Math.floor(sorted.length / 2);
                    setUnsharedAmount(sorted[midIdx]);
                  }
                  return;
                }
              }
            }
          } catch (bundleErr) { console.error('Error loading bundle product config:', bundleErr); }
        }
      }
    } catch (err) { console.error('Error loading product config:', err); }
    // Product has no config options — clear dropdown (don't show hardcoded fallback)
    setUnsharedAmountOptions([]);
    setConfigFieldLabel('');
    setUnsharedAmount('');
  };

  const formatBusinessCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
  };

  useEffect(() => {
    if (!isOpen) return;
    apiService
      .get<{ success: boolean; data?: { fromEmail: string } }>('/api/me/agent/outbound-email-sender')
      .then((res) => {
        if (res?.success && res.data?.fromEmail) setTenantFromEmail(res.data.fromEmail);
      })
      .catch(() => setTenantFromEmail(null));
  }, [isOpen]);

  // Load default messages when agent profile is available
  useEffect(() => {
    if (agentProfile && agentProfile.FirstName && agentProfile.LastName) {
      const agentName = `${agentProfile.FirstName} ${agentProfile.LastName}`;
      const greeting = prospectName ? `Hi ${prospectName}` : '';
      
      // Default email template
      const defaultEmailBody = `Please find attached your personalized benefits proposal.

If you have any questions, please don't hesitate to reach out.

Best regards,
${agentName}`;
      
      // Default text template
      const defaultTextBody = `your personalized benefits proposal is ready!`;
      
      // Update email message if empty or if it matches the default pattern
      const shouldUpdateEmail = emailMessage === '' || 
        (emailMessage.includes('Please find attached') && emailMessage.includes(`Best regards,\n${agentName}`));
      
      if (shouldUpdateEmail) {
        if (prospectName) {
          setEmailMessage(`${greeting},\n\n${defaultEmailBody}`);
        } else {
          setEmailMessage(defaultEmailBody);
        }
      }
      
      // Update text message if empty or if it matches the default pattern
      const shouldUpdateText = textMessage === '' || 
        textMessage.trim() === defaultTextBody ||
        (textMessage.trim().startsWith('your personalized') && textMessage.includes('is ready!'));
      
      if (shouldUpdateText) {
        if (prospectName) {
          setTextMessage(`${greeting}, ${defaultTextBody}`);
        } else {
          setTextMessage(defaultTextBody);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentProfile, prospectName]);

  const getMissingAgentFields = (): string[] => {
    if (!agentProfile) return [];
    
    const missing: string[] = [];
    
    if (!agentProfile.FirstName || !agentProfile.LastName) {
      missing.push('name');
    }
    
    if (!agentProfile.Email) {
      missing.push('email');
    }
    
    if (!agentProfile.PhoneNumber && !agentProfile.AgentPhone) {
      missing.push('phone');
    }
    
    if (!agentProfile.ProfileImageUrl) {
      missing.push('profile image');
    }
    
    // Check if address is complete (at least Address1, City, State, ZipCode)
    if (!agentProfile.Address1 || !agentProfile.City || !agentProfile.State || !agentProfile.ZipCode) {
      missing.push('address');
    }
    
    return missing;
  };

  const getLinkFields = (): ProposalField[] => {
    if (!selectedDocument || !selectedDocument.fields) return [];
    // Return all link fields (enrollment_link, static_url, etc.)
    return selectedDocument.fields.filter(f => f.fieldType === 'link');
  };

  const handleEnrollmentLinkChange = async (fieldId: string, linkId: string) => {
    if (linkId) {
      // User selected an existing static link
      setEnrollmentLinkSelections(prev => ({
        ...prev,
        [fieldId]: linkId
      }));

      const selectedLink = staticEnrollmentLinks.find(link => link.linkId === linkId);
      if (selectedLink) {
        setEnrollmentLinkUrls(prev => ({
          ...prev,
          [linkId]: selectedLink.linkUrl
        }));
      }
    } else {
      // Clear selection
      setEnrollmentLinkSelections(prev => {
        const updated = { ...prev };
        delete updated[fieldId];
        return updated;
      });
    }
  };

  const calculateTier = (hasSpouse: boolean, childrenCount: number): string => {
    if (!hasSpouse && childrenCount === 0) {
      return 'EE'; // Employee Only
    } else if (hasSpouse && childrenCount === 0) {
      return 'ES'; // Employee + Spouse
    } else if (!hasSpouse && childrenCount > 0) {
      return 'EC'; // Employee + Children
    } else if (hasSpouse && childrenCount > 0) {
      return 'EF'; // Employee + Family
    }
    return 'EE'; // Default
  };


  const resetForm = () => {
    setSelectedAgentId('');
    setProspectName('');
    setProspectEmail('');
    setProspectPhone('');
    setProspectAddress('');
    setProspectAge(null);
    setHasSpouse(false);
    setCustomFieldValues({});
    setChildrenCount(0);
    setChildrenCountInput('0');
    setTobaccoUse(false);
    setSendMethod('download');
    setCalculatedTier('');
    setCalculatedAge(null);
    setError(null);
    setSelectedDocument(null);
    setEnrollmentLinkSelections({});
    setEnrollmentLinkUrls({});
    setCustomUrlSelections({});
    setCustomUrls({});
    setGeneratedPdfUrl(null);
    setFormDataHash('');
    // Reset business state
    setProposalMode('individual');
    setCompanyName('');
    setCompanyAddress('');
    setHasExistingCoverage(false);
    setCurrentCountEE(0); setCurrentCountE1(0); setCurrentCountEF(0);
    setCurrentPremiumEE(0); setCurrentPremiumE1(0); setCurrentPremiumEF(0);
    setCurrentContributionType('flat'); setCurrentContributionValueType('dollar');
    setCurrentContributionValue(0); setCurrentContributionValueEE(0); setCurrentContributionValueE1(0); setCurrentContributionValueEF(0);
    setTotalEmployees(0);
    setEstimatedEnrollmentPct(50);
    setTierCountEE(0);
    setTierCountE1(0);
    setTierCountEF(0);
    setUnsharedAmount('');
    setUnsharedAmountOptions([]);
    setConfigFieldLabel('Default Unshared Amount');
    setTierPrices({ EE: 0, ES: 0, EC: 0, EF: 0 });
    setBusinessCalculationResults({});
    setRecipientEmail('');
    setRecipientPhone('');
    // Reset new inputs
    setContributionType('flat');
    setContributionValueType('dollar');
    setContributionValue(0);
    setContributionValueEE(0);
    setContributionValueE1(0);
    setContributionValueEF(0);
    setCurrentRemainCountEE(0);
    setCurrentRemainCountE1(0);
    setCurrentRemainCountEF(0);
    setEnrollmentDate('');
    setRequiredSections(new Set());
    // Reset product discovery and age band state
    setInvolvedProducts([]);
    setHasAgeBandedPricing(false);
    setAgeBands([]);
    setAgeBandTierCounts([]);
    setAgeBandTierPrices([]);
    setAllSlotTierPrices([]);
  };

  const validateForm = (): boolean => {
    if (isTenantAdmin && !selectedAgentId) {
      setError('Please select an agent for this proposal');
      return false;
    }
    if (!selectedDocumentId) {
      setError('Please select a proposal document');
      return false;
    }

    if (proposalMode === 'business') {
      // Business mode validation
      if (!companyName.trim()) {
        setError('Company name is required');
        return false;
      }
      if (totalEmployees <= 0) {
        setError('Total employees must be greater than 0');
        return false;
      }
      if (tierCountEE + tierCountE1 + tierCountEF <= 0) {
        setError('Please enter at least one tier count');
        return false;
      }
      if (unsharedAmountOptions.length > 0 && !unsharedAmount) {
        setError(`Please select a ${configFieldLabel.toLowerCase()}`);
        return false;
      }
      if (sendMethod === 'email' && !recipientEmail.trim()) {
        setError('Email is required when sending via email');
        return false;
      }
      if (sendMethod === 'text' && !recipientPhone.trim()) {
        setError('Phone number is required when sending via text');
        return false;
      }
    } else {
      // Individual mode validation
      if (!prospectName.trim()) {
        setError('Prospect name is required');
        return false;
      }
      if (sendMethod === 'email' && !prospectEmail.trim()) {
        setError('Email is required when sending via email');
        return false;
      }
      if (sendMethod === 'text' && !prospectPhone.trim()) {
        setError('Phone number is required when sending via text');
        return false;
      }
      if (prospectAge === null || prospectAge < 18 || prospectAge > 64) {
        setError('Age is required and must be between 18 and 64');
        return false;
      }
      if (!calculatedTier) {
        setError('Tier calculation failed. Please check spouse and children information.');
        return false;
      }
    }

    // Validate link field selections
    const linkFields = getLinkFields();
    for (const field of linkFields) {
      if (field.linkType === 'enrollment_link') {
        // For enrollment links, either select an existing static link or use custom URL
        const fieldId = field.fieldId || '';
        const useCustom = customUrlSelections[fieldId];
        if (!useCustom && !enrollmentLinkSelections[fieldId]) {
          setError(`Please select an enrollment link or enter a custom URL for ${field.fieldName || 'enrollment link'}`);
          return false;
        }
        if (useCustom && !customUrls[fieldId]?.trim()) {
          setError(`Please enter a custom URL for ${field.fieldName || 'enrollment link'}`);
          return false;
        }
        // Validate that selected link ID doesn't start with "new-" (shouldn't happen anymore, but just in case)
        const selectedLinkId = enrollmentLinkSelections[fieldId];
        if (selectedLinkId && selectedLinkId.startsWith('new-')) {
          setError(`Invalid enrollment link selection for ${field.fieldName || 'enrollment link'}`);
          return false;
        }
      } else if (field.linkType === 'static_url') {
        // For static URLs, either use the saved URL or enter custom
        const useCustom = customUrlSelections[field.fieldId || ''];
        if (useCustom && !customUrls[field.fieldId || '']?.trim()) {
          setError(`Please enter a custom URL for ${field.fieldName || 'link'}`);
          return false;
        }
      }
    }
    
    return true;
  };

  // Helper function to normalize URLs (add http:// or https:// if missing)
  const normalizeUrl = (url: string): string => {
    if (!url || !url.trim()) return url;
    const trimmed = url.trim();
    // If URL doesn't start with http:// or https://, add https://
    if (!trimmed.match(/^https?:\/\//i)) {
      return `https://${trimmed}`;
    }
    return trimmed;
  };

  const handleSend = async () => {
    if (!validateForm()) {
      return;
    }
    
    try {
      setSending(true);
      setError(null);
      
      // Build enrollment link URLs map (templateId -> url)
      // Backend expects templateId -> url mapping
      // Also pass custom URLs as field-specific entries: field_<fieldId> -> url
      const enrollmentLinkUrlsMap: Record<string, string> = {};
      const linkFields = getLinkFields();
      for (const field of linkFields) {
        const fieldId = field.fieldId || '';
        const useCustom = customUrlSelections[fieldId];
        
        if (useCustom && customUrls[fieldId]) {
          // Store custom URL for this field using field-specific key, normalize it first
          enrollmentLinkUrlsMap[`field_${fieldId}`] = normalizeUrl(customUrls[fieldId]);
        } else if (field.linkType === 'enrollment_link') {
          const linkId = enrollmentLinkSelections[fieldId];
          if (linkId && enrollmentLinkUrls[linkId]) {
            // Find the templateId for this link
            const selectedLink = staticEnrollmentLinks.find(link => link.linkId === linkId);
            if (selectedLink && selectedLink.templateId) {
              // Use the templateId from the selected link (no pre-selection)
              enrollmentLinkUrlsMap[selectedLink.templateId] = enrollmentLinkUrls[linkId];
            }
          }
        } else if (field.linkType === 'static_url') {
          // For static_url fields, use custom URL if provided, otherwise use saved URL
          if (customUrls[fieldId]?.trim()) {
            // Custom URL override - normalize it
            enrollmentLinkUrlsMap[`field_${fieldId}`] = normalizeUrl(customUrls[fieldId]);
          } else if (field.linkUrl) {
            // Use saved URL from field
            enrollmentLinkUrlsMap[`field_${fieldId}`] = normalizeUrl(field.linkUrl);
          }
        }
      }
      
      // If PDF is already generated and form data hasn't changed, reuse it
      // Include customUrls in hash to force regeneration when URLs change
      const shouldReusePdf = generatedPdfUrl && 
        (sendMethod === 'email' || sendMethod === 'text') &&
        formDataHash === JSON.stringify({
          selectedDocumentId,
          prospectName,
          prospectEmail,
          prospectPhone,
          prospectAddress,
          prospectAge,
          hasSpouse,
          childrenCount,
          tobaccoUse,
          calculatedTier,
          calculatedAge,
          enrollmentLinkSelections,
          customUrls,
          customUrlSelections,
          customFieldValues
        });

      // Map customFieldValues to use customFieldId (or fieldId as fallback) for all linked fields
      const customFieldValuesForApi: Record<string, string> = {};
      if (selectedDocument?.fields) {
        selectedDocument.fields
          .filter(f => f.fieldType === 'custom')
          .forEach(field => {
            const key = field.customFieldId || field.fieldId || '';
            if (key && customFieldValues[key]) {
              // Use customFieldId as the key in the API call
              const apiKey = field.customFieldId || field.fieldId || '';
              customFieldValuesForApi[apiKey] = customFieldValues[key];
            }
          });
      }
      
      let response;

      if (proposalMode === 'business') {
        // Send raw inputs to backend — server-side computeAllCalculations handles everything
        const businessPayload: any = {
          proposalDocumentId: selectedDocumentId,
          documentType: 'exact_quote',
          companyName: companyName.trim(),
          companyAddress: companyAddress.trim() || undefined,
          hasExistingCoverage,
          currentCountEE: hasExistingCoverage ? currentCountEE : 0,
          currentCountE1: hasExistingCoverage ? currentCountE1 : 0,
          currentCountEF: hasExistingCoverage ? currentCountEF : 0,
          currentPremiumEE: hasExistingCoverage ? currentPremiumEE : 0,
          currentPremiumE1: hasExistingCoverage ? currentPremiumE1 : 0,
          currentPremiumEF: hasExistingCoverage ? currentPremiumEF : 0,
          currentContributionType: hasExistingCoverage ? currentContributionType : 'flat',
          currentContributionValueType: hasExistingCoverage ? currentContributionValueType : 'dollar',
          currentContributionValue: hasExistingCoverage && currentContributionType === 'flat' ? currentContributionValue : undefined,
          currentContributionValueEE: hasExistingCoverage && currentContributionType === 'per_tier' ? currentContributionValueEE : undefined,
          currentContributionValueE1: hasExistingCoverage && currentContributionType === 'per_tier' ? currentContributionValueE1 : undefined,
          currentContributionValueEF: hasExistingCoverage && currentContributionType === 'per_tier' ? currentContributionValueEF : undefined,
          totalEmployees,
          oopLevel: unsharedAmount || undefined,
          mwCountEE: tierCountEE,
          mwCountE1: tierCountE1,
          mwCountEF: tierCountEF,
          currentRemainCountEE: hasExistingCoverage ? currentRemainCountEE : 0,
          currentRemainCountE1: hasExistingCoverage ? currentRemainCountE1 : 0,
          currentRemainCountEF: hasExistingCoverage ? currentRemainCountEF : 0,
          contributionType,
          contributionValueType,
          contributionValue: contributionType === 'flat' ? contributionValue : undefined,
          contributionValueEE: contributionType === 'per_tier' ? contributionValueEE : undefined,
          contributionValueE1: contributionType === 'per_tier' ? contributionValueE1 : undefined,
          contributionValueEF: contributionType === 'per_tier' ? contributionValueEF : undefined,
          enrollmentDate: enrollmentDate || undefined,
          sendMethod,
          recipientEmail: recipientEmail.trim() || undefined,
          recipientPhone: recipientPhone.trim() || undefined,
          enrollmentLinkUrls: Object.keys(enrollmentLinkUrlsMap).length > 0 ? enrollmentLinkUrlsMap : undefined,
          customFieldValues: Object.keys(customFieldValuesForApi).length > 0 ? customFieldValuesForApi : undefined,
          existingPdfUrl: shouldReusePdf ? (generatedPdfUrl ?? undefined) : undefined,
          emailMessage: sendMethod === 'email' ? emailMessage : undefined,
          textMessage: sendMethod === 'text' ? textMessage : undefined
        };
        response = await BusinessProposalService.generateBusinessProposal({
          ...businessPayload,
          ...(isTenantAdmin && selectedAgentId ? { agentId: selectedAgentId } : {})
        });
      } else {
        // Individual proposal flow
        response = await ProposalService.generateProposal({
          proposalDocumentId: selectedDocumentId,
          ...(isTenantAdmin && selectedAgentId ? { agentId: selectedAgentId } : {}),
          prospectInfo: {
            name: prospectName.trim(),
            email: prospectEmail.trim() || undefined,
            phone: prospectPhone.trim() || undefined,
            address: prospectAddress.trim() || undefined,
            hasSpouse,
            childrenCount
          },
          tier: calculatedTier,
          tobaccoUse,
          age: prospectAge!,
          sendMethod,
          enrollmentLinkUrls: enrollmentLinkUrlsMap,
          customFieldValues: Object.keys(customFieldValuesForApi).length > 0 ? customFieldValuesForApi : undefined,
          existingPdfUrl: shouldReusePdf ? generatedPdfUrl : undefined,
          emailMessage: sendMethod === 'email' ? emailMessage : undefined,
          textMessage: sendMethod === 'text' ? textMessage : undefined
        });
      }
      
      if (response.success && response.data) {
        if (sendMethod === 'download' && response.data.pdfUrl) {
          setGeneratedPdfUrl(response.data.pdfUrl);
          window.open(response.data.pdfUrl, '_blank');
          onSent?.();
        } else {
          onSent?.();
          alert(`Proposal sent successfully!`);
          onClose();
        }
      } else {
        setError(response.message || 'Failed to generate/send proposal');
      }
    } catch (err: any) {
      console.error('Error sending proposal:', err);
      setError(err.message || 'Failed to generate/send proposal');
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  const linkFields = getLinkFields();
  const hasEnrollmentLinkFields = linkFields.length > 0;
  const hasNoTemplates = enrollmentLinkTemplates.length === 0;
  const isBusinessMode = proposalMode === 'business';
  const totalTierCount = tierCountEE + tierCountE1 + tierCountEF;
  const estimatedEnrollment = Math.round(totalEmployees * (estimatedEnrollmentPct / 100));

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-semibold text-gray-900">
            {isBusinessMode ? 'Send Business Proposal' : 'Send Proposal'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
            </div>
          ) : (
            <>
              {/* TenantAdmin: Select which agent the proposal is for */}
              {isTenantAdmin && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Agent for this proposal *
                  </label>
                  <SearchableDropdown
                    options={agentOptions}
                    value={selectedAgentId}
                    onChange={(value) => setSelectedAgentId(value)}
                    placeholder="Select an agent"
                    searchPlaceholder="Search agents..."
                    loading={agentSearchLoading}
                    onSearch={async (query) => {
                      setAgentSearchLoading(true);
                      try {
                        const response = await TenantAdminAgentsService.getAgentsAndAgencies({
                          search: query || undefined,
                          type: 'Agent',
                          status: 'Active',
                          page: 1,
                          limit: 50
                        });
                        if (response.success && response.data && Array.isArray(response.data)) {
                          const options = response.data
                            .filter((a: { Type: string }) => a.Type === 'Agent')
                            .map((a: { Id: string; Name: string; Email?: string }) => ({
                              id: a.Id,
                              label: a.Name || 'Unknown',
                              value: a.Id,
                              email: a.Email
                            }));
                          setAgentOptions(options);
                        }
                      } catch {
                        setAgentOptions([]);
                      } finally {
                        setAgentSearchLoading(false);
                      }
                    }}
                    useBackendSearch={true}
                    showEmail={true}
                    className="w-full"
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    The proposal will use this agent&apos;s enrollment links and profile information.
                  </p>
                </div>
              )}

              {/* Proposal Document Selection */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Proposal Document *
                </label>
                <select
                  value={selectedDocumentId}
                  onChange={(e) => setSelectedDocumentId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">Select a proposal document</option>
                  {proposalDocuments.map((doc) => (
                    <option key={doc.proposalDocumentId} value={doc.proposalDocumentId}>
                      {doc.name}
                    </option>
                  ))}
                </select>
                {proposalDocuments.length === 0 && (
                  <p className="mt-1 text-sm text-gray-500">
                    No proposal documents available.
                  </p>
                )}
              </div>

              {/* Enrollment Link Fields */}
              {hasEnrollmentLinkFields && (
                <div className="border-t border-gray-200 pt-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-4 flex items-center gap-2">
                    <LinkIcon className="h-5 w-5" />
                    Enrollment Links
                  </h3>
                  
                  {hasNoTemplates && (
                    <div className="mb-4 p-3 alert alert-warning">
                      <div className="flex items-start">
                        <AlertCircle className="h-5 w-5 text-oe-warning mr-2 mt-0.5 flex-shrink-0" />
                        <div className="text-sm">
                          <p className="font-medium mb-1">No Enrollment Link Templates Available</p>
                          <p>This proposal contains enrollment link fields, but you don't have any enrollment link templates. Please create an enrollment link template first.</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {!hasNoTemplates && (
                    <div className="space-y-4">
                      {linkFields.map((field) => {
                        const fieldId = field.fieldId || '';
                        const selectedLinkId = enrollmentLinkSelections[fieldId];
                        const selectedLink = selectedLinkId ? staticEnrollmentLinks.find(link => link.linkId === selectedLinkId) : null;
                        const linkUrl = selectedLink ? selectedLink.linkUrl : null;
                        const useCustomUrl = customUrlSelections[fieldId] || false;
                        const customUrl = customUrls[fieldId] || '';
                        
                        // Only show existing static links - no "Create New" options
                        const availableLinks = staticEnrollmentLinks;
                        
                        // Only show enrollment link dropdown for enrollment_link type fields
                        const isEnrollmentLink = field.linkType === 'enrollment_link';
                        
                        return (
                          <div key={fieldId} className="p-4 border border-gray-200 rounded-lg">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                              {field.fieldName || (isEnrollmentLink ? 'Enrollment Link' : 'Link')} *
                            </label>
                            
                            {/* Custom URL checkbox */}
                            <div className="mb-3">
                              <label className="flex items-center">
                                <input
                                  type="checkbox"
                                  checked={useCustomUrl}
                                  onChange={(e) => {
                                    setCustomUrlSelections(prev => ({
                                      ...prev,
                                      [fieldId]: e.target.checked
                                    }));
                                    // Clear enrollment link selection when custom URL is enabled
                                    if (e.target.checked) {
                                      setEnrollmentLinkSelections(prev => {
                                        const updated = { ...prev };
                                        delete updated[fieldId];
                                        return updated;
                                      });
                                    }
                                  }}
                                  className="mr-2"
                                />
                                <span className="text-sm text-gray-700">Enter custom URL</span>
                              </label>
                            </div>
                            
                            {useCustomUrl ? (
                              // Custom URL input
                              <input
                                type="url"
                                value={customUrl}
                                onChange={(e) => setCustomUrls(prev => ({
                                  ...prev,
                                  [fieldId]: e.target.value
                                }))}
                                onBlur={(e) => {
                                  // Normalize URL when user leaves the field
                                  const normalized = normalizeUrl(e.target.value);
                                  if (normalized !== e.target.value) {
                                    setCustomUrls(prev => ({
                                      ...prev,
                                      [fieldId]: normalized
                                    }));
                                  }
                                }}
                                placeholder="https://example.com"
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              />
                            ) : isEnrollmentLink ? (
                              // Enrollment link dropdown - only show existing static links
                              <>
                                {availableLinks.length > 0 ? (
                                  <>
                                    <select
                                      value={selectedLinkId || ''}
                                      onChange={(e) => handleEnrollmentLinkChange(fieldId, e.target.value)}
                                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                    >
                                      <option value="">Select enrollment link</option>
                                      {availableLinks.map((link) => (
                                        <option key={link.linkId} value={link.linkId}>
                                          {link.templateName}
                                        </option>
                                      ))}
                                    </select>
                                    
                                    {selectedLink && selectedLink.productsPreview && (
                                      <p className="mt-1 text-xs text-gray-500">
                                        {selectedLink.productsPreview}
                                      </p>
                                    )}

                                    {selectedLink && (() => {
                                      const slots = selectedDocument?.productSlots || [];
                                      if (slots.length === 0) return null;
                                      const missing = findUncoveredSlots(slots, selectedLink.productSections);
                                      if (missing.length === 0) return null;
                                      return (
                                        <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                                          <div className="flex items-start">
                                            <AlertCircle className="h-5 w-5 text-oe-warning mr-2 mt-0.5 flex-shrink-0" />
                                            <div className="text-sm text-yellow-800">
                                              <p className="font-medium mb-1">
                                                This enrollment link does not include {missing.length === 1 ? 'a product' : 'products'} from your proposal:
                                              </p>
                                              <ul className="list-disc list-inside space-y-0.5">
                                                {missing.map(slot => (
                                                  <li key={slot.slotNumber}>
                                                    {slot.productName || 'Unknown product'}
                                                    {slot.productType ? ` (${slot.productType})` : ''}
                                                  </li>
                                                ))}
                                              </ul>
                                              <p className="mt-1 text-xs">
                                                You can still send the proposal, but recipients may not be able to enroll in {missing.length === 1 ? 'this product' : 'these products'} using this link.
                                              </p>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })()}

                                    {linkUrl && (
                                      <p className="mt-2 text-xs text-gray-600 break-all">
                                        Link: <span className="font-mono">{linkUrl}</span>
                                      </p>
                                    )}
                                  </>
                                ) : (
                                  <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
                                    <p className="text-sm text-yellow-800">
                                      No static enrollment links available. Please create a static enrollment link in{' '}
                                      <span className="font-medium">Enrollment Link Templates</span> first.
                                    </p>
                                  </div>
                                )}
                              </>
                            ) : (
                              // Static URL field - show saved URL or allow custom
                              <div>
                                {field.linkUrl ? (
                                  <p className="text-sm text-gray-600 mb-2">
                                    Saved URL: <span className="font-mono">{field.linkUrl}</span>
                                  </p>
                                ) : null}
                                <input
                                  type="url"
                                  value={customUrl}
                                  onChange={(e) => setCustomUrls(prev => ({
                                    ...prev,
                                    [fieldId]: e.target.value
                                  }))}
                                  onBlur={(e) => {
                                    // Normalize URL when user leaves the field
                                    const normalized = normalizeUrl(e.target.value);
                                    if (normalized !== e.target.value) {
                                      setCustomUrls(prev => ({
                                        ...prev,
                                        [fieldId]: normalized
                                      }));
                                    }
                                  }}
                                  placeholder={field.linkUrl || "https://example.com"}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                  {field.linkUrl ? 'Leave empty to use saved URL, or enter a custom URL to override' : 'Enter a URL for this link'}
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ====== INDIVIDUAL MODE SECTIONS ====== */}
              {!isBusinessMode && (
              <>
              {/* Prospect Information */}
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Prospect Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Prospect Name *
                    </label>
                    <input
                      type="text"
                      value={prospectName}
                      onChange={(e) => setProspectName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Enter prospect name"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Email Address {sendMethod === 'email' && '*'}
                    </label>
                    <input
                      type="email"
                      value={prospectEmail}
                      onChange={(e) => setProspectEmail(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="prospect@example.com"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone Number {sendMethod === 'text' && '*'}
                    </label>
                    <input
                      type="tel"
                      value={prospectPhone}
                      onChange={(e) => setProspectPhone(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="(555) 123-4567"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Address (Optional)
                    </label>
                    <input
                      type="text"
                      value={prospectAddress}
                      onChange={(e) => setProspectAddress(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Street address, City, State ZIP"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Age *
                    </label>
                    <select
                      value={prospectAge || ''}
                      onChange={(e) => setProspectAge(e.target.value ? parseInt(e.target.value) : null)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="">Select age</option>
                      {Array.from({ length: 47 }, (_, i) => i + 18).map(age => (
                        <option key={age} value={age}>
                          {age} years
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              </>
              )}

              {/* ====== BUSINESS MODE SECTIONS ====== */}
              {isBusinessMode && (
              <>
              {/* Employer Information */}
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Employer Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
                    <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary" placeholder="Enter company name" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Company Address (Optional)</label>
                    <input type="text" value={companyAddress} onChange={(e) => setCompanyAddress(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary" placeholder="Street address, City, State ZIP" />
                  </div>
                </div>
              </div>

              {/* Current Coverage — only shown when calculations need it */}
              {needsSection('currentCoverage') && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Current Coverage</h3>
                <div className="space-y-4">
                  <label className="flex items-center">
                    <input type="checkbox" checked={hasExistingCoverage}
                      onChange={(e) => {
                        setHasExistingCoverage(e.target.checked);
                        if (!e.target.checked) {
                          setCurrentCountEE(0); setCurrentCountE1(0); setCurrentCountEF(0);
                          setCurrentPremiumEE(0); setCurrentPremiumE1(0); setCurrentPremiumEF(0);
                          setCurrentContributionType('flat'); setCurrentContributionValueType('dollar');
                          setCurrentContributionValue(0); setCurrentContributionValueEE(0); setCurrentContributionValueE1(0); setCurrentContributionValueEF(0);
                        }
                      }}
                      className="mr-2 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary" />
                    <span className="text-sm font-medium text-gray-700">Company has existing health coverage</span>
                  </label>
                  {hasExistingCoverage && (
                    <div className="space-y-5 pl-6">
                      {/* Current Enrollment Counts per Tier — shown when any calc needs currentCount* */}
                      {needsInput('currentCountEE') && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Current Enrollment Counts per Tier</label>
                        <p className="text-xs text-gray-500 mb-3">Number of employees currently enrolled in each tier on the existing plan.</p>
                        <div className="grid grid-cols-3 gap-4">
                          {[
                            { label: 'EE (Employee Only)', val: currentCountEE, set: setCurrentCountEE },
                            { label: 'E1 (Employee + One)', val: currentCountE1, set: setCurrentCountE1 },
                            { label: 'EF (Employee + Family)', val: currentCountEF, set: setCurrentCountEF },
                          ].map(({ label, val, set }) => (
                            <div key={label}>
                              <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                              <input type="number" min={0} value={val || ''} onChange={e => set(parseInt(e.target.value) || 0)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center" placeholder="0" />
                            </div>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Total: {currentCountEE + currentCountE1 + currentCountEF}</p>
                      </div>
                      )}

                      {/* Current Monthly Premium per Tier — shown only when a calc needs currentPremium* */}
                      {needsInput('currentPremiumEE') && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Current Monthly Premium per Tier ($)</label>
                        <p className="text-xs text-gray-500 mb-3">Monthly premium cost per member for each tier on the existing plan.</p>
                        <div className="grid grid-cols-3 gap-4">
                          {[
                            { label: 'EE ($/month)', val: currentPremiumEE, set: setCurrentPremiumEE },
                            { label: 'E1 ($/month)', val: currentPremiumE1, set: setCurrentPremiumE1 },
                            { label: 'EF ($/month)', val: currentPremiumEF, set: setCurrentPremiumEF },
                          ].map(({ label, val, set }) => (
                            <div key={label}>
                              <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                              <input type="number" min={0} step="1" value={val || ''} onChange={e => set(parseFloat(e.target.value) || 0)}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center" placeholder="0" />
                            </div>
                          ))}
                        </div>
                      </div>
                      )}

                      {/* Current Employer Contribution — shown only when a calc needs currentContribution* */}
                      {needsInput('currentContributionType') && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-3">Current Employer Contribution</label>
                        <div className="flex gap-6 mb-3">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="radio" name="currentContribTypeSend" checked={currentContributionType === 'flat'}
                              onChange={() => setCurrentContributionType('flat')}
                              className="w-4 h-4 text-oe-primary focus:ring-oe-primary" />
                            <span className="text-sm text-gray-700">Flat (same for all tiers)</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="radio" name="currentContribTypeSend" checked={currentContributionType === 'per_tier'}
                              onChange={() => setCurrentContributionType('per_tier')}
                              className="w-4 h-4 text-oe-primary focus:ring-oe-primary" />
                            <span className="text-sm text-gray-700">Per-Tier</span>
                          </label>
                        </div>
                        <div className="flex gap-6 mb-4">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="radio" name="currentContribValueTypeSend" checked={currentContributionValueType === 'dollar'}
                              onChange={() => setCurrentContributionValueType('dollar')}
                              className="w-4 h-4 text-oe-primary focus:ring-oe-primary" />
                            <span className="text-sm text-gray-700">Dollar Amount ($)</span>
                          </label>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="radio" name="currentContribValueTypeSend" checked={currentContributionValueType === 'percentage'}
                              onChange={() => setCurrentContributionValueType('percentage')}
                              className="w-4 h-4 text-oe-primary focus:ring-oe-primary" />
                            <span className="text-sm text-gray-700">Percentage (%)</span>
                          </label>
                        </div>
                        {currentContributionType === 'flat' ? (
                          <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                              Contribution {currentContributionValueType === 'dollar' ? '($)' : '(%)'} — All Tiers
                            </label>
                            <input type="number" min={0} step={currentContributionValueType === 'dollar' ? '1' : '0.1'}
                              value={currentContributionValue || ''} onChange={e => setCurrentContributionValue(parseFloat(e.target.value) || 0)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder={currentContributionValueType === 'dollar' ? 'e.g. 300' : 'e.g. 50'} />
                          </div>
                        ) : (
                          <div className="grid grid-cols-3 gap-4">
                            {[
                              { label: `EE ${currentContributionValueType === 'dollar' ? '($)' : '(%)'}`, val: currentContributionValueEE, set: setCurrentContributionValueEE },
                              { label: `E1 ${currentContributionValueType === 'dollar' ? '($)' : '(%)'}`, val: currentContributionValueE1, set: setCurrentContributionValueE1 },
                              { label: `EF ${currentContributionValueType === 'dollar' ? '($)' : '(%)'}`, val: currentContributionValueEF, set: setCurrentContributionValueEF },
                            ].map(({ label, val, set }) => (
                              <div key={label}>
                                <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                                <input type="number" min={0} value={val || ''} onChange={e => set(parseFloat(e.target.value) || 0)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center" />
                              </div>
                            ))}
                          </div>
                        )}
                        <p className="text-xs text-gray-500 mt-2">The employer's current contribution toward the existing plan.</p>
                      </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Workforce — Total Employees */}
              {needsSection('workforce') && (
              <div className="border-t border-gray-200 pt-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Total Employees *</label>
                  <input type="number" min="1" value={totalEmployees || ''} onChange={(e) => setTotalEmployees(parseInt(e.target.value) || 0)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary" placeholder="Total number of employees" />
                </div>
              </div>
              )}

              {/* Enrollment Assumptions */}
              {needsSection('tierCounts') && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Enrollment Assumptions</h3>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Estimated MightyWELL Enrollment %</label>
                  <div className="flex items-center gap-4">
                    <input type="range" min="1" max="100" value={estimatedEnrollmentPct} onChange={(e) => setEstimatedEnrollmentPct(parseInt(e.target.value))}
                      className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-oe-primary" />
                    <div className="flex items-center gap-1 min-w-[80px]">
                      <input type="number" min="1" max="100" value={estimatedEnrollmentPct}
                        onChange={(e) => setEstimatedEnrollmentPct(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
                        className="w-16 px-2 py-1 border border-gray-300 rounded text-center text-sm" />
                      <span className="text-sm text-gray-500">%</span>
                    </div>
                  </div>
                  {totalEmployees > 0 && (
                    <p className="mt-1 text-sm text-gray-500">Estimated enrollment: {estimatedEnrollment} of {totalEmployees} employees</p>
                  )}
                </div>
              </div>
              )}

              {/* Employee Tier Counts */}
              {needsSection('tierCounts') && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Employee Tier Counts</h3>
                <p className="text-sm text-gray-500 mb-4">
                  {hasAgeBandedPricing 
                    ? 'Enter the number of employees expected for each coverage tier, split by age group.'
                    : 'Enter the number of employees expected for each coverage tier.'}
                </p>
                
                {/* Standard 3-tier count inputs (EE / E1 / EF) */}
                <div className="space-y-3">
                  {[
                    { label: 'EE (Employee Only)', value: tierCountEE, setter: setTierCountEE },
                    { label: 'E1 (Employee + One)', value: tierCountE1, setter: setTierCountE1 },
                    { label: 'EF (Employee + Family)', value: tierCountEF, setter: setTierCountEF },
                  ].map(({ label, value, setter }) => (
                    <div key={label} className="flex items-center gap-4">
                      <label className="w-48 text-sm font-medium text-gray-700">{label}</label>
                      <input type="number" min="0" value={value || ''} onChange={(e) => setter(parseInt(e.target.value) || 0)}
                        className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center" />
                      {totalTierCount > 0 && <span className="text-sm text-gray-500">{((value / totalTierCount) * 100).toFixed(1)}%</span>}
                    </div>
                  ))}
                  <p className="text-xs text-gray-400 mt-2">Total: {totalTierCount}</p>
                </div>
              </div>
              )}

              {/* Plan Configuration */}
              {needsSection('oopLevel') && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Plan Configuration</h3>
                <div className="space-y-4">
                  {unsharedAmountOptions.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">{configFieldLabel} *</label>
                    <select value={unsharedAmount} onChange={(e) => setUnsharedAmount(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary">
                      <option value="">Select {configFieldLabel.toLowerCase()}</option>
                      {unsharedAmountOptions.map(opt => (
                        <option key={opt} value={opt}>${Number(opt).toLocaleString()}</option>
                      ))}
                    </select>
                  </div>
                  )}
                  {unsharedAmount && (tierPrices.EE > 0 || tierPrices.ES > 0 || tierPrices.EF > 0) && (
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                      <p className="text-sm font-medium text-blue-800 mb-2">Monthly Prices per Tier</p>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-blue-700">
                            <th className="py-1 pr-4 font-medium">Tier</th>
                            <th className="py-1 font-medium text-right">Monthly</th>
                          </tr>
                        </thead>
                        <tbody className="font-medium text-gray-900">
                          {([
                            { tierKey: 'EE' as const, label: 'EE (Employee Only)' },
                            { tierKey: 'ES' as const, label: 'E1 (Employee + One)' },
                            { tierKey: 'EF' as const, label: 'EF (Employee + Family)' },
                          ]).map(({ tierKey, label }) => (
                            <tr key={tierKey}>
                              <td className="py-0.5 pr-4 text-blue-700">{label}</td>
                              <td className="py-0.5 text-right">{formatBusinessCurrency(tierPrices[tierKey])}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Employer Contribution — only shown when calculations need it */}
              {needsSection('contribution') && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Employer Contribution</h3>
                <div className="space-y-4">
                  <div className="flex gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Contribution Mode</label>
                      <select value={contributionType} onChange={(e) => setContributionType(e.target.value as 'flat' | 'per_tier')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary">
                        <option value="flat">Flat (same for all tiers)</option>
                        <option value="per_tier">Per Tier (different per tier)</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Value Type</label>
                      <select value={contributionValueType} onChange={(e) => setContributionValueType(e.target.value as 'dollar' | 'percentage')}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary">
                        <option value="dollar">Dollar Amount ($)</option>
                        <option value="percentage">Percentage (%)</option>
                      </select>
                    </div>
                  </div>

                  {contributionType === 'flat' ? (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Contribution {contributionValueType === 'dollar' ? '($)' : '(%)'} — All Tiers
                      </label>
                      <div className="relative">
                        {contributionValueType === 'dollar' && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>}
                        <input type="number" min="0" step={contributionValueType === 'dollar' ? '1' : '1'}
                          max={contributionValueType === 'percentage' ? 100 : undefined}
                          value={contributionValue || ''}
                          onChange={(e) => setContributionValue(parseFloat(e.target.value) || 0)}
                          className={`w-full ${contributionValueType === 'dollar' ? 'pl-7' : 'pl-3'} pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                          placeholder={contributionValueType === 'dollar' ? '0' : '0'} />
                        {contributionValueType === 'percentage' && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {[
                        { label: 'EE (Employee Only)', value: contributionValueEE, setter: setContributionValueEE },
                        { label: 'E1 (Employee + One)', value: contributionValueE1, setter: setContributionValueE1 },
                        { label: 'EF (Employee + Family)', value: contributionValueEF, setter: setContributionValueEF },
                      ].map(({ label, value, setter }) => (
                        <div key={label} className="flex items-center gap-4">
                          <label className="w-48 text-sm font-medium text-gray-700">{label}</label>
                          <div className="relative flex-1">
                            {contributionValueType === 'dollar' && <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">$</span>}
                            <input type="number" min="0" step={contributionValueType === 'dollar' ? '1' : '1'}
                              max={contributionValueType === 'percentage' ? 100 : undefined}
                              value={value || ''}
                              onChange={(e) => setter(parseFloat(e.target.value) || 0)}
                              className={`w-full ${contributionValueType === 'dollar' ? 'pl-7' : 'pl-3'} pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary`}
                              placeholder={contributionValueType === 'dollar' ? '0' : '0'} />
                            {contributionValueType === 'percentage' && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">%</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-500">These are estimates. The employer contribution is capped at the tier price.</p>
                </div>
              </div>
              )}

              {/* Partial Switch — per-tier remain on current plan */}
              {needsSection('currentRemainCount') && hasExistingCoverage && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Partial Switch</h3>
                <p className="text-sm text-gray-500 mb-4">
                  If some employees will remain on the current plan instead of switching to MightyWELL, enter the count per tier. Leave at 0 for a full switch.
                </p>
                <div className="space-y-3">
                  {[
                    { label: 'EE (Employee Only)', value: currentRemainCountEE, setter: setCurrentRemainCountEE },
                    { label: 'E1 (Employee + One)', value: currentRemainCountE1, setter: setCurrentRemainCountE1 },
                    { label: 'EF (Employee + Family)', value: currentRemainCountEF, setter: setCurrentRemainCountEF },
                  ].map(({ label, value, setter }) => (
                    <div key={label} className="flex items-center gap-4">
                      <label className="w-48 text-sm font-medium text-gray-700">{label}</label>
                      <input type="number" min="0" value={value || ''} onChange={(e) => setter(parseInt(e.target.value) || 0)}
                        className="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center" />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400 mt-2">Total: {currentRemainCountEE + currentRemainCountE1 + currentRemainCountEF}</p>
                {(currentRemainCountEE + currentRemainCountE1 + currentRemainCountEF) > 0 && (
                  <p className="mt-2 text-sm text-gray-500">
                    {currentRemainCountEE + currentRemainCountE1 + currentRemainCountEF} stay on current plan, {totalTierCount} switch to MightyWELL, {totalEmployees - totalTierCount - (currentRemainCountEE + currentRemainCountE1 + currentRemainCountEF)} not enrolled
                  </p>
                )}
              </div>
              )}

              {/* Enrollment Date — only shown when calculations need it */}
              {needsSection('enrollmentDates') && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Enrollment Date</h3>
                <input
                  type="date"
                  value={enrollmentDate}
                  onChange={(e) => setEnrollmentDate(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                />
              </div>
              )}

              {/* Business Calculation Preview */}
              {Object.keys(businessCalculationResults).length > 0 && (
                <div className="border-t border-gray-200 pt-6">
                  <h3 className="text-lg font-medium text-gray-900 mb-4">Calculation Preview</h3>
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-4">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">Enrollment Summary</h4>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>Total Employees: <span className="font-medium">{businessCalculationResults.bp_total_employees}</span></div>
                        <div>Est. MW Enrollment: <span className="font-medium">{businessCalculationResults.bp_estimated_enrollment_count} ({businessCalculationResults.bp_estimated_enrollment_pct})</span></div>
                        {hasExistingCoverage && (
                          <>
                            <div>Currently Enrolled: <span className="font-medium">{businessCalculationResults.bp_currently_enrolled}</span></div>
                            <div>Current Not Enrolled: <span className="font-medium">{businessCalculationResults.bp_not_enrolled}</span></div>
                          </>
                        )}
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">Projected Participation Mix</h4>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>MW Plan: <span className="font-medium">{businessCalculationResults.bp_mw_plan_count} employees</span></div>
                        <div>Current Remain: <span className="font-medium">{businessCalculationResults.bp_current_remain_count} employees</span></div>
                        <div>Not Enrolled: <span className="font-medium">{businessCalculationResults.bp_not_enrolled_projected} employees</span></div>
                        <div>Net Opt-in Change: <span className="font-medium">{businessCalculationResults.bp_total_enrolled_projected}</span></div>
                        <div>Participation: <span className="font-medium">{businessCalculationResults.bp_participation_pct}</span></div>
                        <div>Net Increase: <span className="font-medium">{businessCalculationResults.bp_net_increase_employees} employees ({businessCalculationResults.bp_net_increase_enrollment_pct})</span></div>
                      </div>
                    </div>
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 mb-2">Tier Breakdown</h4>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        <div>EE: {tierCountEE} ({totalTierCount > 0 ? ((tierCountEE / totalTierCount) * 100).toFixed(1) : '0.0'}%)</div>
                        <div>E1: {tierCountE1} ({totalTierCount > 0 ? ((tierCountE1 / totalTierCount) * 100).toFixed(1) : '0.0'}%)</div>
                        <div>EF: {tierCountEF} ({totalTierCount > 0 ? ((tierCountEF / totalTierCount) * 100).toFixed(1) : '0.0'}%)</div>
                      </div>
                    </div>
                    {allSlotTierPrices.length > 1 ? (
                      <>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-800 mb-2">Tier Prices by Product Slot</h4>
                          <div className="space-y-2">
                            {allSlotTierPrices.map(sp => {
                              const slotName = selectedDocument?.productSlots?.find(s => s.slotNumber === sp.slotNumber)?.productName;
                              return (
                                <div key={sp.slotNumber} className="bg-white border border-gray-200 rounded p-2">
                                  <div className="text-xs font-medium text-gray-600 mb-1">Slot {sp.slotNumber}{slotName ? `: ${slotName}` : ''}</div>
                                  <div className="grid grid-cols-3 gap-1 text-sm">
                                    <div>EE: <span className="font-medium">{formatBusinessCurrency(sp.tierPrices.EE)}</span></div>
                                    <div>E1: <span className="font-medium">{formatBusinessCurrency(sp.tierPrices.ES)}</span></div>
                                    <div>EF: <span className="font-medium">{formatBusinessCurrency(sp.tierPrices.EF)}</span></div>
                                  </div>
                                  <div className="text-sm mt-1">
                                    Monthly: <span className="font-semibold text-oe-primary">{businessCalculationResults[`bp_projected_monthly_slot_${sp.slotNumber}`]}</span>
                                    {' | '}Yearly: <span className="font-semibold text-oe-primary">{businessCalculationResults[`bp_projected_yearly_slot_${sp.slotNumber}`]}</span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                        {hasExistingCoverage && (
                          <div>
                            <h4 className="text-sm font-semibold text-gray-800 mb-2">Estimated Savings</h4>
                            <div className="space-y-1">
                              {allSlotTierPrices.map(sp => (
                                <div key={sp.slotNumber} className="text-sm">
                                  Slot {sp.slotNumber}: <span className="font-semibold text-green-700">{businessCalculationResults[`bp_savings_monthly_slot_${sp.slotNumber}`]}</span> / mo
                                  {' | '}<span className="font-semibold text-green-700">{businessCalculationResults[`bp_savings_yearly_slot_${sp.slotNumber}`]}</span> / yr
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="pt-2 border-t border-gray-300">
                          {allSlotTierPrices.map(sp => {
                            const slotName = selectedDocument?.productSlots?.find(s => s.slotNumber === sp.slotNumber)?.productName;
                            return (
                              <div key={sp.slotNumber} className="text-center mb-2">
                                <div className="text-xs text-gray-500">Slot {sp.slotNumber}{slotName ? `: ${slotName}` : ''}</div>
                                <div className="text-xl font-bold text-oe-primary">{businessCalculationResults[`bp_headline_value_slot_${sp.slotNumber}`]}</div>
                              </div>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <h4 className="text-sm font-semibold text-gray-800 mb-2">Projected Costs</h4>
                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div>Monthly: <span className="font-semibold text-oe-primary">{businessCalculationResults.bp_projected_monthly}</span></div>
                            <div>Yearly: <span className="font-semibold text-oe-primary">{businessCalculationResults.bp_projected_yearly}</span></div>
                          </div>
                        </div>
                        {hasExistingCoverage && (
                          <div>
                            <h4 className="text-sm font-semibold text-gray-800 mb-2">Estimated Savings</h4>
                            <div className="grid grid-cols-2 gap-2 text-sm">
                              <div>Monthly: <span className="font-semibold text-green-700">{businessCalculationResults.bp_savings_monthly}</span></div>
                              <div>Yearly: <span className="font-semibold text-green-700">{businessCalculationResults.bp_savings_yearly}</span></div>
                            </div>
                          </div>
                        )}
                        <div className="pt-2 border-t border-gray-300 text-center">
                          <div className="text-2xl font-bold text-oe-primary">{businessCalculationResults.bp_headline_value}</div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Business Send Recipient Info */}
              {sendMethod === 'email' && (
                <div className="border-t border-gray-200 pt-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Email *</label>
                    <input type="email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary" placeholder="recipient@company.com" />
                  </div>
                </div>
              )}
              {sendMethod === 'text' && (
                <div className="border-t border-gray-200 pt-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Phone *</label>
                    <input type="tel" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary" placeholder="(555) 123-4567" />
                  </div>
                </div>
              )}
              </>
              )}

              {/* Custom Fields */}
              {selectedDocument?.fields?.some(f => f.fieldType === 'custom') && (() => {
                // Group custom fields by customFieldId (or fieldId if no customFieldId)
                const customFieldsMap = new Map<string, ProposalField>();
                selectedDocument.fields
                  .filter(f => f.fieldType === 'custom')
                  .forEach(field => {
                    const key = field.customFieldId || field.fieldId || '';
                    if (key && !customFieldsMap.has(key)) {
                      customFieldsMap.set(key, field);
                    }
                  });
                
                return (
                  <div className="border-t border-gray-200 pt-6">
                    <h3 className="text-lg font-medium text-gray-900 mb-4">Custom Fields</h3>
                    <div className="space-y-4">
                      {Array.from(customFieldsMap.values()).map(field => {
                        const key = field.customFieldId || field.fieldId || '';
                        const linkedCount = (selectedDocument.fields || []).filter(
                          f => f.fieldType === 'custom' && (f.customFieldId || f.fieldId) === key
                        ).length;
                        
                        return (
                          <div key={key}>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              {field.customLabel || 'Custom Field'}
                              {linkedCount > 1 && (
                                <span className="ml-2 text-xs text-gray-500">
                                  ({linkedCount} locations)
                                </span>
                              )}
                            </label>
                            <input
                              type="text"
                              value={customFieldValues[key] || ''}
                              onChange={(e) => {
                                setCustomFieldValues(prev => ({
                                  ...prev,
                                  [key]: e.target.value
                                }));
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder={`Enter ${field.customLabel || 'value'}`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Household Information (Individual only) */}
              {!isBusinessMode && (
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Household Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Has Spouse?
                    </label>
                    <div className="flex gap-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="hasSpouse"
                          checked={hasSpouse === true}
                          onChange={() => setHasSpouse(true)}
                          className="mr-2"
                        />
                        Yes
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="hasSpouse"
                          checked={hasSpouse === false}
                          onChange={() => setHasSpouse(false)}
                          className="mr-2"
                        />
                        No
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Number of Children
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={childrenCountInput}
                      onChange={(e) => {
                        const value = e.target.value;
                        // Allow empty string during editing so user can clear the field
                        setChildrenCountInput(value);
                        if (value === '') {
                          setChildrenCount(0);
                        } else {
                          const numValue = parseInt(value);
                          if (!isNaN(numValue) && numValue >= 0) {
                            setChildrenCount(numValue);
                          }
                        }
                      }}
                      onBlur={(e) => {
                        // If empty on blur, default to 0
                        if (e.target.value === '') {
                          setChildrenCountInput('0');
                          setChildrenCount(0);
                        }
                      }}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Tobacco Use?
                    </label>
                    <div className="flex gap-4">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="tobaccoUse"
                          checked={tobaccoUse === true}
                          onChange={() => setTobaccoUse(true)}
                          className="mr-2"
                        />
                        Yes
                      </label>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="tobaccoUse"
                          checked={tobaccoUse === false}
                          onChange={() => setTobaccoUse(false)}
                          className="mr-2"
                        />
                        No
                      </label>
                    </div>
                  </div>

                  {calculatedTier && (
                    <div className="p-3 alert alert-info">
                      <p className="text-sm">
                        <span className="font-medium">Calculated Tier:</span> {calculatedTier}
                        {calculatedTier === 'EE' && ' (Employee Only)'}
                        {calculatedTier === 'ES' && ' (Employee + Spouse)'}
                        {calculatedTier === 'EC' && ' (Employee + Children)'}
                        {calculatedTier === 'EF' && ' (Employee + Family)'}
                      </p>
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Send Method */}
              <div className="border-t border-gray-200 pt-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Send Method</h3>
                <div className="space-y-3">
                  <label className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="sendMethod"
                      value="download"
                      checked={sendMethod === 'download'}
                      onChange={() => setSendMethod('download')}
                      className="mr-3"
                    />
                    <Download className="h-5 w-5 mr-2 text-gray-600" />
                    <span>Download Only</span>
                  </label>
                  <label className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="sendMethod"
                      value="email"
                      checked={sendMethod === 'email'}
                      onChange={() => setSendMethod('email')}
                      className="mr-3"
                    />
                    <Mail className="h-5 w-5 mr-2 text-gray-600" />
                    <span>Send via Email</span>
                  </label>
                  <label className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio"
                      name="sendMethod"
                      value="text"
                      checked={sendMethod === 'text'}
                      onChange={() => setSendMethod('text')}
                      className="mr-3"
                    />
                    <MessageSquare className="h-5 w-5 mr-2 text-gray-600" />
                    <span>Send via Text/SMS</span>
                  </label>
                </div>
                
                {/* Email Message Input */}
                {sendMethod === 'email' && agentProfile?.Email && (
                  <div className="mt-4">
                    <OutboundEmailSenderNotice
                      fromDisplayName={`${agentProfile.FirstName || ''} ${agentProfile.LastName || ''}`.trim() || 'Agent'}
                      fromEmail={tenantFromEmail || 'noreply@allaboard365.com'}
                      replyToName={`${agentProfile.FirstName || ''} ${agentProfile.LastName || ''}`.trim() || 'Agent'}
                      replyToEmail={agentProfile.Email}
                    />
                  </div>
                )}
                {sendMethod === 'email' && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Email Message
                    </label>
                    <textarea
                      value={emailMessage}
                      onChange={(e) => setEmailMessage(e.target.value)}
                      rows={6}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Enter your email message..."
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      The proposal PDF will be attached. Replies go to your email shown above.
                    </p>
                  </div>
                )}
                
                {/* Text/SMS Message Input */}
                {sendMethod === 'text' && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Text Message{' '}
                      <span className="font-normal text-gray-500">
                        (your text first, then the PDF link on its own line)
                      </span>
                    </label>
                    <textarea
                      value={textMessage}
                      onChange={(e) => setTextMessage(e.target.value)}
                      rows={4}
                      maxLength={1600}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Enter your text message..."
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      {textMessage.length}/1600 characters · The proposal link is added on a separate line so phones
                      recognize it as tappable.
                    </p>
                  </div>
                )}
              </div>

            </>
          )}
          
          {/* Error messages at bottom near submit button */}
          {error && (
            <div className="p-4 alert alert-error">
              <p>{error}</p>
            </div>
          )}
        </div>

        {/* Agent Profile Warning */}
        {agentProfile && getMissingAgentFields().length > 0 && (
          <div className="px-6 pb-4">
            <div className="p-3 alert alert-warning">
              <div className="flex items-start">
                <AlertCircle className="h-5 w-5 text-oe-warning mr-2 mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <p className="font-medium mb-1">Missing Agent Information</p>
                  <p className="mb-1">
                    The following information is missing from the selected agent profile: <span className="font-medium">{getMissingAgentFields().join(', ')}</span>.
                  </p>
                  <p>
                    {isTenantAdmin
                      ? 'Ask the agent to complete their profile in Agent Settings so proposals display correctly.'
                      : (
                        <>
                          Please complete these details in your{' '}
                          <a href="/agent/settings" target="_blank" rel="noopener noreferrer" className="underline font-medium hover:opacity-80">
                            Agent Profile Settings
                          </a>
                          {' '}to ensure proposals display correctly.
                        </>
                      )}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-4 p-6 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            disabled={sending}
          >
            {generatedPdfUrl ? 'Close' : 'Cancel'}
          </button>
          {generatedPdfUrl && sendMethod === 'download' ? (
            <button
              onClick={() => {
                if (generatedPdfUrl) {
                  window.open(generatedPdfUrl, '_blank');
                }
              }}
              className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 flex items-center gap-2 transition-colors"
            >
              <Download className="h-4 w-4" />
              Download Generated PDF
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={sending || loading || !selectedDocumentId || (isTenantAdmin && !selectedAgentId)}
              className="btn-primary flex items-center gap-2"
            >
              {sending ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                  {sendMethod === 'download' ? 'Generating...' : 'Sending...'}
                </>
              ) : (
                <>
                  {sendMethod === 'download' ? (
                    <>
                      <Download className="h-4 w-4" />
                      {generatedPdfUrl ? 'Regenerate PDF' : 'Download Proposal'}
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      Send Proposal
                    </>
                  )}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default SendProposalModal;
