// frontend/src/components/proposals/BusinessProposalModal.tsx
// Dedicated modal for generating business proposal documents (Partial Switch, Generic Quote, Employee Proposal).
// Dynamically shows input fields based on which templates are checked.

import { CheckSquare, Download, Mail, MessageSquare, Send, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiService } from '../../services/api.service';
import BusinessProposalService, { GenerateBusinessProposalData } from '../../services/businessProposal.service';
import ProposalService, { ProposalDocument } from '../../services/proposal.service';
import { deriveRequiredInputs, FormSection } from '../../utils/calcInputRequirements';
import TierContributionInput from './TierContributionInput';

interface BusinessProposalModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ProductTierPricingRow {
  productId: string;
  productName: string;
  ee: number;
  e1: number;
  // EC is optional: only populated for products that price an Employee+Children tier.
  // 4-tier products (e.g. Concierge MightyWELL) return ec > 0; 3-tier products return 0.
  ec: number;
  ef: number;
}

interface ProductOption {
  productId: string;
  productName: string;
}

const NO_PRODUCT_OPTION_ID = '__NO_PRODUCT__';


const BusinessProposalModal: React.FC<BusinessProposalModalProps> = ({ isOpen, onClose }) => {
  // ---- Document selection ----
  const [templates, setTemplates] = useState<ProposalDocument[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [selectedProductId, setSelectedProductId] = useState<string>('');

  // ---- Form inputs ----
  const [companyName, setCompanyName] = useState('');
  const [companyAddressLine1, setCompanyAddressLine1] = useState('');
  const [companyCity, setCompanyCity] = useState('');
  const [companyState, setCompanyState] = useState('');
  const [companyZip, setCompanyZip] = useState('');
  const [totalEmployees, setTotalEmployees] = useState<number | ''>('');

  // Current Coverage
  const [hasExistingCoverage, setHasExistingCoverage] = useState(false);
  const [currentCountEE, setCurrentCountEE] = useState<number | ''>('');
  const [currentCountE1, setCurrentCountE1] = useState<number | ''>('');
  const [currentCountEC, setCurrentCountEC] = useState<number | ''>('');
  const [currentCountEF, setCurrentCountEF] = useState<number | ''>('');
  const [currentPremiumEE, setCurrentPremiumEE] = useState<number | ''>('');
  const [currentPremiumE1, setCurrentPremiumE1] = useState<number | ''>('');
  const [currentPremiumEC, setCurrentPremiumEC] = useState<number | ''>('');
  const [currentPremiumEF, setCurrentPremiumEF] = useState<number | ''>('');
  // Current Employer Contribution (per-tier with individual value types)
  const [currentContributionValueEE, setCurrentContributionValueEE] = useState<number>(0);
  const [currentContributionValueE1, setCurrentContributionValueE1] = useState<number>(0);
  const [currentContributionValueEC, setCurrentContributionValueEC] = useState<number>(0);
  const [currentContributionValueEF, setCurrentContributionValueEF] = useState<number>(0);
  const [currentContributionValueTypeEE, setCurrentContributionValueTypeEE] = useState<'dollar' | 'percentage'>('percentage');
  const [currentContributionValueTypeE1, setCurrentContributionValueTypeE1] = useState<'dollar' | 'percentage'>('percentage');
  const [currentContributionValueTypeEC, setCurrentContributionValueTypeEC] = useState<'dollar' | 'percentage'>('percentage');
  const [currentContributionValueTypeEF, setCurrentContributionValueTypeEF] = useState<'dollar' | 'percentage'>('percentage');

  // Plan Config — dynamically populated from product slots
  const [oopLevel, setOopLevel] = useState<string>('');
  const [oopOptions, setOopOptions] = useState<string[]>([]);
  const [configFieldLabel, setConfigFieldLabel] = useState<string>('Unshared Amount');
  const [loadingOopOptions, setLoadingOopOptions] = useState(false);

  // MW Tier Counts. Most products are 3-tier (EE/E1/EF); 4-tier products
  // (e.g. Concierge MightyWELL) also collect EC (Employee+Children).
  const [mwCountEE, setMwCountEE] = useState<number | ''>('');
  const [mwCountE1, setMwCountE1] = useState<number | ''>('');
  const [mwCountEC, setMwCountEC] = useState<number | ''>('');
  const [mwCountEF, setMwCountEF] = useState<number | ''>('');

  // Partial Switch (per-tier)
  const [currentRemainCountEE, setCurrentRemainCountEE] = useState<number | ''>('');
  const [currentRemainCountE1, setCurrentRemainCountE1] = useState<number | ''>('');
  const [currentRemainCountEC, setCurrentRemainCountEC] = useState<number | ''>('');
  const [currentRemainCountEF, setCurrentRemainCountEF] = useState<number | ''>('');

  // MW Employer Contribution (per-tier with individual value types)
  const [contributionValueEE, setContributionValueEE] = useState<number>(0);
  const [contributionValueE1, setContributionValueE1] = useState<number>(0);
  const [contributionValueEC, setContributionValueEC] = useState<number>(0);
  const [contributionValueEF, setContributionValueEF] = useState<number>(0);
  const [contributionValueTypeEE, setContributionValueTypeEE] = useState<'dollar' | 'percentage'>('percentage');
  const [contributionValueTypeE1, setContributionValueTypeE1] = useState<'dollar' | 'percentage'>('percentage');
  const [contributionValueTypeEC, setContributionValueTypeEC] = useState<'dollar' | 'percentage'>('percentage');
  const [contributionValueTypeEF, setContributionValueTypeEF] = useState<'dollar' | 'percentage'>('percentage');

  // Enrollment Date
  const [enrollmentDate, setEnrollmentDate] = useState('');

  // Send options
  const [sendMethod, setSendMethod] = useState<'download' | 'email' | 'text'>('download');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [emailMessage, setEmailMessage] = useState('');
  const [textMessage, setTextMessage] = useState('');

  // State
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ---- Load templates ----
  useEffect(() => {
    if (!isOpen) return;
    loadTemplates();
  }, [isOpen]);

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const listResponse = await ProposalService.getProposalDocuments({ includeInactive: false, category: 'Business' });
      if (listResponse.success && listResponse.data) {
        // The listing endpoint doesn't include fields — fetch each document
        // individually so we have the fields needed by deriveRequiredInputs.
        const detailedTemplates = await Promise.all(
          listResponse.data.map(async (doc) => {
            try {
              const detailRes = await ProposalService.getProposalDocument(doc.proposalDocumentId);
              if (detailRes.success && detailRes.data) {
                return detailRes.data;
              }
            } catch {
              console.warn(`Failed to load fields for template ${doc.proposalDocumentId}`);
            }
            return doc; // fallback to the listing data (no fields)
          })
        );
        setTemplates(detailedTemplates);
      }
    } catch (err: any) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  // ---- Derive required inputs + sections from checked templates ----
  const { requiredSections, requiredInputs } = useMemo<{ requiredSections: Set<FormSection>; requiredInputs: Set<string> }>(() => {
    if (selectedDocIds.size === 0) {
      // Nothing checked → hide all input sections
      return { requiredSections: new Set<FormSection>(), requiredInputs: new Set<string>() };
    }

    const selectedTemplates = templates.filter(t => selectedDocIds.has(t.proposalDocumentId));
    const allFields = selectedTemplates.flatMap(t => t.fields || []);

    // Debug: log what fields we found for selected templates
    console.log('[BusinessProposalModal] Selected templates:', selectedTemplates.map(t => ({
      id: t.proposalDocumentId,
      name: t.name,
      fieldCount: (t.fields || []).length,
      calcFields: (t.fields || []).filter(f => f.fieldType === 'calculation').map(f => f.fieldName),
    })));

    const derived = deriveRequiredInputs(allFields);

    console.log('[BusinessProposalModal] Required sections:', Array.from(derived.requiredSections));

    return derived;
  }, [selectedDocIds, templates]);

  const needsInput = (name: string) => requiredInputs.has(name);

  const availableProducts = useMemo<ProductOption[]>(() => {
    const map = new Map<string, string>();
    let hasNoProductTemplates = false;
    for (const template of templates) {
      let hasAnyProduct = false;
      // Only include primary products in the dropdown
      for (const slot of template.productSlots || []) {
        if (!slot.productId) continue;
        if (!slot.isPrimary) continue;
        hasAnyProduct = true;
        if (!map.has(slot.productId)) {
          map.set(slot.productId, slot.productName || 'Unnamed Product');
        }
      }
      // Fallback: if no primary slots, include all (backward compat)
      if (!hasAnyProduct) {
        for (const slot of template.productSlots || []) {
          if (!slot.productId) continue;
          hasAnyProduct = true;
          if (!map.has(slot.productId)) {
            map.set(slot.productId, slot.productName || 'Unnamed Product');
          }
        }
      }
      if (!hasAnyProduct) {
        hasNoProductTemplates = true;
      }
    }
    const options = Array.from(map.entries())
      .map(([productId, productName]) => ({ productId, productName }))
      .sort((a, b) => a.productName.localeCompare(b.productName));

    if (hasNoProductTemplates) {
      options.push({ productId: NO_PRODUCT_OPTION_ID, productName: 'No Product' });
    }

    return options;
  }, [templates]);

  const filteredTemplates = useMemo(() => {
    if (!selectedProductId) return [];
    if (selectedProductId === NO_PRODUCT_OPTION_ID) {
      return templates
        .filter(t => !(t.productSlots || []).some(slot => slot.productId))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    return templates
      .filter(t => (t.productSlots || []).some(slot => slot.productId === selectedProductId))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [templates, selectedProductId]);

  useEffect(() => {
    if (!selectedProductId) {
      setSelectedDocIds(new Set());
      return;
    }
    setSelectedDocIds(prev => {
      const allowed = new Set(filteredTemplates.map(t => t.proposalDocumentId));
      const next = new Set(Array.from(prev).filter(id => allowed.has(id)));
      return next;
    });
  }, [selectedProductId, filteredTemplates]);

  // ---- Derive OOP / config options from selected templates' product slots ----
  useEffect(() => {
    if (selectedDocIds.size === 0) {
      setOopOptions([]);
      setOopLevel('');
      setConfigFieldLabel('Unshared Amount');
      return;
    }

    const selectedTemplates = templates.filter(t => selectedDocIds.has(t.proposalDocumentId));
    const productIds = new Set<string>();
    for (const tpl of selectedTemplates) {
      for (const slot of tpl.productSlots || []) {
        productIds.add(slot.productId);
      }
    }

    if (productIds.size === 0) {
      setOopOptions([]);
      setOopLevel('');
      return;
    }

    let cancelled = false;
    const fetchConfigOptions = async () => {
      setLoadingOopOptions(true);
      try {
        const extractConfig = (product: any): { options: string[]; label: string } | null => {
          const configFields = product.ConfigurationFields || product.configurationFields
            || product.RequiredDataFields || product.requiredDataFields;
          if (!configFields) return null;
          try {
            const parsed = typeof configFields === 'string' ? JSON.parse(configFields) : configFields;
            if (Array.isArray(parsed)) {
              for (const field of parsed) {
                if (field.fieldOptions && Array.isArray(field.fieldOptions) && field.fieldOptions.length > 0) {
                  const label = field.fieldName || (field.isDeductible ? 'Deductible' : 'Unshared Amount');
                  return { options: field.fieldOptions.map(String), label };
                }
              }
            }
            if (parsed.ConfigValue1 && Array.isArray(parsed.ConfigValue1.options)) {
              return { options: parsed.ConfigValue1.options.map(String), label: 'Unshared Amount' };
            }
          } catch { /* ignore parse errors */ }
          return null;
        };

        for (const pid of productIds) {
          if (cancelled) return;
          try {
            const resp = await apiService.get(`/api/products/${pid}`);
            const product = (resp as any).product || (resp as any).data;
            if (!(resp as any).success || !product) continue;

            const directConfig = extractConfig(product);
            if (directConfig) {
              if (cancelled) return;
              const sorted = [...directConfig.options].sort((a, b) => Number(a) - Number(b));
              setOopOptions(sorted);
              setConfigFieldLabel(directConfig.label);
              if (!oopLevel || !sorted.includes(oopLevel)) {
                setOopLevel(sorted[Math.floor(sorted.length / 2)] || sorted[0] || '');
              }
              return;
            }

            if (product.IsBundle || product.isBundle) {
              try {
                const bundleResp = await apiService.get(`/api/products/${pid}/bundle-products`);
                if ((bundleResp as any).success && Array.isArray((bundleResp as any).data)) {
                  for (const included of (bundleResp as any).data) {
                    if (cancelled) return;
                    const bundleConfig = extractConfig(included);
                    if (bundleConfig) {
                      // Apply AllowedConfigOptions from oe.ProductBundles (same restriction
                      // the enrollment wizard enforces). Without this, proposals show config
                      // values (e.g. 1500) that aren't offered during actual enrollment.
                      let filteredOptions = bundleConfig.options;
                      const allowed = included.AllowedConfigOptions || included.allowedConfigOptions;
                      if (allowed && typeof allowed === 'object') {
                        // AllowedConfigOptions can be { "fieldName": ["3000","6000"] } or
                        // [{ fieldName, allowedValues: ["3000","6000"] }] depending on how it was stored.
                        let allowedValues: string[] | null = null;
                        if (Array.isArray(allowed)) {
                          const entry = allowed.find((a: any) => Array.isArray(a.allowedValues));
                          allowedValues = entry?.allowedValues?.map(String) ?? null;
                        } else {
                          const vals = Object.values(allowed).find(v => Array.isArray(v)) as string[] | undefined;
                          allowedValues = vals?.map(String) ?? null;
                        }
                        if (allowedValues && allowedValues.length > 0) {
                          filteredOptions = filteredOptions.filter(opt => allowedValues!.includes(opt));
                        }
                      }
                      if (filteredOptions.length === 0) filteredOptions = bundleConfig.options; // fallback
                      const sorted = [...filteredOptions].sort((a, b) => Number(a) - Number(b));
                      setOopOptions(sorted);
                      setConfigFieldLabel(bundleConfig.label);
                      if (!oopLevel || !sorted.includes(oopLevel)) {
                        setOopLevel(sorted[Math.floor(sorted.length / 2)] || sorted[0] || '');
                      }
                      return;
                    }
                  }
                }
              } catch { /* bundle fetch failed */ }
            }
          } catch { /* product fetch failed */ }
        }

        if (!cancelled) {
          setOopOptions([]);
          setOopLevel('');
          setConfigFieldLabel('Unshared Amount');
        }
      } finally {
        if (!cancelled) setLoadingOopOptions(false);
      }
    };

    fetchConfigOptions();
    return () => { cancelled = true; };
  }, [selectedDocIds, templates]);

  // ---- Fetch MW tier prices for equivalent display in contribution inputs ----
  const [mwTierPrices, setMwTierPrices] = useState<{ EE: number; E1: number; EC: number; EF: number }>({ EE: 0, E1: 0, EC: 0, EF: 0 });
  const [productTierPricingRows, setProductTierPricingRows] = useState<ProductTierPricingRow[]>([]);

  // A 4-tier product is detected by any selected product returning a positive EC price.
  // When false, EC inputs and the EC preview column are hidden entirely so the 3-tier flow looks unchanged.
  const hasECPricing = useMemo(
    () => productTierPricingRows.some(row => (row.ec || 0) > 0),
    [productTierPricingRows]
  );

  const selectedSlotProducts = useMemo(() => {
    const selectedTemplates = templates.filter(t => selectedDocIds.has(t.proposalDocumentId));
    const productMap = new Map<string, { productId: string; productName: string; isPrimary: boolean }>();

    for (const tpl of selectedTemplates) {
      for (const slot of tpl.productSlots || []) {
        if (!slot.productId) continue;
        const existing = productMap.get(slot.productId);
        if (!existing) {
          productMap.set(slot.productId, {
            productId: slot.productId,
            productName: slot.productName || 'Unnamed Product',
            isPrimary: !!slot.isPrimary
          });
        } else {
          if (slot.isPrimary) existing.isPrimary = true;
          if ((!existing.productName || existing.productName === 'Unnamed Product') && slot.productName) {
            existing.productName = slot.productName;
          }
        }
      }
    }

    return Array.from(productMap.values());
  }, [selectedDocIds, templates]);

  useEffect(() => {
    if (selectedDocIds.size === 0) {
      setMwTierPrices({ EE: 0, E1: 0, EC: 0, EF: 0 });
      setProductTierPricingRows([]);
      return;
    }
    if (selectedSlotProducts.length === 0) {
      setMwTierPrices({ EE: 0, E1: 0, EC: 0, EF: 0 });
      setProductTierPricingRows([]);
      return;
    }

    let cancelled = false;
    const fetchPrices = async () => {
      // Use the proposal-specific tier-prices endpoint so the blue box
      // matches the PDF (same calcMwTierPrice function, includes processing fee).
      try {
        const resp = await apiService.post<{
          success: boolean;
          data: Array<{ productId: string; productName: string; ee: number; e1: number; ec: number; ef: number }>;
        }>('/api/business-proposal-sends/tier-prices', {
          products: selectedSlotProducts.map(p => ({ productId: p.productId, productName: p.productName })),
          oopLevel
        });

        if (resp.success && resp.data && !cancelled) {
          const rows = resp.data;
          // Pick the primary product for the contribution baseline:
          //   1. prefer the slot explicitly flagged IsPrimary on the template
          //   2. fall back to the first slot encountered (slot 1 of the first selected template)
          // Alphabetical sort is display-only — using it for the baseline cascaded
          // contributions against the wrong product (e.g. Dental instead of the main plan).
          const primaryProductId =
            selectedSlotProducts.find(p => p.isPrimary)?.productId
            ?? selectedSlotProducts[0]?.productId;
          const primaryRow = (primaryProductId && rows.find(r => r.productId === primaryProductId)) || rows[0];
          const sortedForDisplay = [...rows].sort((a, b) => a.productName.localeCompare(b.productName));
          setProductTierPricingRows(sortedForDisplay);
          setMwTierPrices(primaryRow
            ? { EE: primaryRow.ee, E1: primaryRow.e1, EC: primaryRow.ec || 0, EF: primaryRow.ef }
            : { EE: 0, E1: 0, EC: 0, EF: 0 });
        }
      } catch {
        if (!cancelled) {
          setProductTierPricingRows([]);
          setMwTierPrices({ EE: 0, E1: 0, EC: 0, EF: 0 });
        }
      }
    };

    fetchPrices();
    return () => { cancelled = true; };
  }, [selectedDocIds, oopLevel, selectedSlotProducts]);

  // ---- Toggle document selection ----
  const toggleDoc = useCallback((docId: string) => {
    setSelectedDocIds(prev => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });
  }, []);

  const preventNumberInputScroll = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement && target.type === 'number') {
      target.blur();
    }
  }, []);


  // ---- Generate ----
  const handleGenerate = async () => {
    setError(null);
    setSuccess(null);

    if (selectedDocIds.size === 0) {
      setError('Please select at least one document to generate.');
      return;
    }
    if (!companyName.trim()) {
      setError('Company name is required.');
      return;
    }
    if (requiredSections.has('workforce') && (!totalEmployees || totalEmployees <= 0)) {
      setError('Total employees must be greater than 0.');
      return;
    }
    if (oopOptions.length > 0 && !oopLevel) {
      setError(`Please select a ${configFieldLabel.toLowerCase()}.`);
      return;
    }
    if (sendMethod === 'email' && !recipientEmail) {
      setError('Email is required when sending via email.');
      return;
    }
    if (sendMethod === 'text' && !recipientPhone) {
      setError('Phone number is required when sending via text.');
      return;
    }

    setGenerating(true);

    try {
      const validDate = enrollmentDate || undefined;
      const cityStateZip = [companyCity.trim(), companyState.trim(), companyZip.trim()]
        .filter(Boolean)
        .join(', ');
      const companyAddress = [companyAddressLine1.trim(), cityStateZip]
        .filter(Boolean)
        .join(', ');

      const data: GenerateBusinessProposalData = {
        documentIds: Array.from(selectedDocIds),
        companyName: companyName.trim(),
        companyAddress,
        totalEmployees: Number(totalEmployees),
        hasExistingCoverage,
        currentCountEE: Number(currentCountEE || 0),
        currentCountE1: Number(currentCountE1 || 0),
        currentCountEC: hasECPricing ? Number(currentCountEC || 0) : 0,
        currentCountEF: Number(currentCountEF || 0),
        currentPremiumEE: Number(currentPremiumEE || 0),
        currentPremiumE1: Number(currentPremiumE1 || 0),
        currentPremiumEC: hasECPricing ? Number(currentPremiumEC || 0) : 0,
        currentPremiumEF: Number(currentPremiumEF || 0),
        currentContributionValueEE: hasExistingCoverage ? currentContributionValueEE : 0,
        currentContributionValueE1: hasExistingCoverage ? currentContributionValueE1 : 0,
        currentContributionValueEC: hasExistingCoverage && hasECPricing ? currentContributionValueEC : 0,
        currentContributionValueEF: hasExistingCoverage ? currentContributionValueEF : 0,
        currentContributionValueTypeEE: hasExistingCoverage ? currentContributionValueTypeEE : 'percentage',
        currentContributionValueTypeE1: hasExistingCoverage ? currentContributionValueTypeE1 : 'percentage',
        currentContributionValueTypeEC: hasExistingCoverage && hasECPricing ? currentContributionValueTypeEC : 'percentage',
        currentContributionValueTypeEF: hasExistingCoverage ? currentContributionValueTypeEF : 'percentage',
        oopLevel,
        mwCountEE: Number(mwCountEE || 0),
        mwCountE1: Number(mwCountE1 || 0),
        mwCountEC: hasECPricing ? Number(mwCountEC || 0) : 0,
        mwCountEF: Number(mwCountEF || 0),
        currentRemainCountEE: Number(currentRemainCountEE || 0),
        currentRemainCountE1: Number(currentRemainCountE1 || 0),
        currentRemainCountEC: hasECPricing ? Number(currentRemainCountEC || 0) : 0,
        currentRemainCountEF: Number(currentRemainCountEF || 0),
        contributionValueEE,
        contributionValueE1,
        contributionValueEC: hasECPricing ? contributionValueEC : 0,
        contributionValueEF,
        contributionValueTypeEE,
        contributionValueTypeE1,
        contributionValueTypeEC: hasECPricing ? contributionValueTypeEC : 'percentage',
        contributionValueTypeEF,
        enrollmentDate: validDate,
        sendMethod,
        recipientEmail: sendMethod === 'email' ? recipientEmail : undefined,
        recipientPhone: sendMethod === 'text' ? recipientPhone : undefined,
        emailMessage: sendMethod === 'email' ? emailMessage : undefined,
      };

      const response = await BusinessProposalService.generateBusinessProposal(data);

      if (response.success && response.data) {
        const docs = response.data.documents || [];
        if (sendMethod === 'download') {
          const urls = docs
            .map(doc => doc.pdfUrl)
            .filter((url): url is string => Boolean(url));

          // Backward compatibility: some environments may only return top-level pdfUrl.
          if (urls.length === 0 && response.data.pdfUrl) {
            urls.push(response.data.pdfUrl);
          }

          if (urls.length === 0) {
            setError('Documents generated but no PDF links were returned.');
            return;
          }

          for (const url of urls) {
            window.open(url, '_blank');
          }
          setSuccess(`${urls.length} document(s) generated and downloaded.`);
        } else {
          setSuccess(`${docs.length} document(s) generated and sent via ${sendMethod}.`);
        }
      } else {
        setError(response.message || 'Failed to generate documents.');
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred while generating documents.');
    } finally {
      setGenerating(false);
    }
  };

  // ---- Reset on close ----
  const handleClose = () => {
    setSelectedDocIds(new Set());
    setSelectedProductId('');
    setCompanyName('');
    setCompanyAddressLine1('');
    setCompanyCity('');
    setCompanyState('');
    setCompanyZip('');
    setTotalEmployees('');
    setHasExistingCoverage(false);
    setCurrentCountEE('');
    setCurrentCountE1('');
    setCurrentCountEC('');
    setCurrentCountEF('');
    setCurrentPremiumEE('');
    setCurrentPremiumE1('');
    setCurrentPremiumEC('');
    setCurrentPremiumEF('');
    setCurrentContributionValueEE(0);
    setCurrentContributionValueE1(0);
    setCurrentContributionValueEC(0);
    setCurrentContributionValueEF(0);
    setCurrentContributionValueTypeEE('percentage');
    setCurrentContributionValueTypeE1('percentage');
    setCurrentContributionValueTypeEC('percentage');
    setCurrentContributionValueTypeEF('percentage');
    setOopLevel('');
    setOopOptions([]);
    setConfigFieldLabel('Unshared Amount');
    setMwCountEE('');
    setMwCountE1('');
    setMwCountEC('');
    setMwCountEF('');
    setCurrentRemainCountEE('');
    setCurrentRemainCountE1('');
    setCurrentRemainCountEC('');
    setCurrentRemainCountEF('');
    setContributionValueEE(0);
    setContributionValueE1(0);
    setContributionValueEC(0);
    setContributionValueEF(0);
    setContributionValueTypeEE('percentage');
    setContributionValueTypeE1('percentage');
    setContributionValueTypeEC('percentage');
    setContributionValueTypeEF('percentage');
    setMwTierPrices({ EE: 0, E1: 0, EC: 0, EF: 0 });
    setEnrollmentDate('');
    setSendMethod('download');
    setRecipientEmail('');
    setRecipientPhone('');
    setEmailMessage('');
    setTextMessage('');
    setError(null);
    setSuccess(null);
    onClose();
  };

  const hasAnySectionVisible = requiredSections.size > 0;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header — matches personal proposal form */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-2xl font-semibold text-gray-900">Generate Business Proposal</h2>
          <button onClick={handleClose} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form body */}
        <div className="p-6" onWheelCapture={preventNumberInputScroll}>

          <div>
            <h3 className="text-lg font-medium text-gray-900 mb-4">Select Product</h3>
            {loadingTemplates ? (
              <p className="text-sm text-gray-500">Loading products...</p>
            ) : availableProducts.length === 0 ? (
              <p className="text-sm text-gray-500">No products found in business proposal templates.</p>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product *</label>
                <select
                  value={selectedProductId}
                  onChange={(e) => setSelectedProductId(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="">Select product</option>
                  {availableProducts.map(product => (
                    <option key={product.productId} value={product.productId}>
                      {product.productName}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {selectedProductId && (
            <div className="border-t border-gray-200 pt-6 mt-8">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Select Documents to Generate</h3>
              {filteredTemplates.length === 0 ? (
                <p className="text-sm text-gray-500">No proposals use this product.</p>
              ) : (
                <div className="space-y-1.5">
                  {filteredTemplates.map(t => (
                    <label
                      key={t.proposalDocumentId}
                      className={`flex items-center gap-2 p-2 rounded-md border cursor-pointer transition-colors ${
                        selectedDocIds.has(t.proposalDocumentId)
                          ? 'border-oe-primary bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedDocIds.has(t.proposalDocumentId)}
                        onChange={() => toggleDoc(t.proposalDocumentId)}
                        className="w-4 h-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{t.name}</p>
                        {t.description && <p className="text-[11px] text-gray-500 truncate">{t.description}</p>}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}

          {hasAnySectionVisible && (
            <>
              {/* ================================================================
                  SECTION 2: COMPANY INFORMATION
                  (name, address, workforce, current coverage)
                  ================================================================ */}
              <div className="border-t border-gray-200 pt-6 mt-8">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Company Information</h3>

                {/* Name & Address */}
                {requiredSections.has('company') && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Company Name *</label>
                        <input
                          type="text" value={companyName} onChange={e => setCompanyName(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="Acme Corp"
                        />
                      </div>
                      {requiredSections.has('workforce') && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">Total Employees *</label>
                          <input
                            type="number" min={1} value={totalEmployees}
                            onChange={e => setTotalEmployees(e.target.value ? Number(e.target.value) : '')}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            placeholder="e.g. 25"
                          />
                        </div>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Address Line 1</label>
                      <input
                        type="text" value={companyAddressLine1} onChange={e => setCompanyAddressLine1(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="123 Main St"
                      />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                      <div className="sm:col-span-2">
                        <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                        <input
                          type="text" value={companyCity} onChange={e => setCompanyCity(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="Austin"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                        <input
                          type="text" value={companyState} onChange={e => setCompanyState(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="TX"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Zip</label>
                        <input
                          type="text" value={companyZip} onChange={e => setCompanyZip(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="78701"
                        />
                      </div>
                    </div>

                    {/* Current Coverage */}
                    {requiredSections.has('currentCoverage') && (
                      <div className="mt-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox" checked={hasExistingCoverage}
                            onChange={e => setHasExistingCoverage(e.target.checked)}
                            className="w-4 h-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                          />
                          <span className="text-sm text-gray-700">Business currently has health coverage</span>
                        </label>
                        {hasExistingCoverage && (
                          <div className="mt-4 pl-6 space-y-5">
                            {/* Current Enrollment Counts per Tier — shown when a calc needs currentCount* */}
                            {needsInput('currentCountEE') && (() => {
                              // EC column appears alongside the other tiers only when the selected
                              // product prices an EC tier. Otherwise the 3-tier layout is preserved.
                              const countRows = [
                                { key: 'EE', label: 'EE (Employee Only)', value: currentCountEE, setter: setCurrentCountEE },
                                { key: 'E1', label: 'E1 (Employee + One)', value: currentCountE1, setter: setCurrentCountE1 },
                                ...(hasECPricing ? [{ key: 'EC', label: 'EC (Employee + Children)', value: currentCountEC, setter: setCurrentCountEC }] : []),
                                { key: 'EF', label: 'EF (Employee + Family)', value: currentCountEF, setter: setCurrentCountEF },
                              ];
                              const total = Number(currentCountEE || 0) + Number(currentCountE1 || 0) + (hasECPricing ? Number(currentCountEC || 0) : 0) + Number(currentCountEF || 0);
                              return (
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-2">Current Enrollment Counts per Tier</label>
                                  <p className="text-xs text-gray-500 mb-3">Number of employees currently enrolled in each tier on the existing plan.</p>
                                  <div className={hasECPricing ? 'grid grid-cols-4 gap-4' : 'grid grid-cols-3 gap-4'}>
                                    {countRows.map(({ key, label, value, setter }) => (
                                      <div key={key}>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                                        <input
                                          type="number" min={0} value={value}
                                          onChange={e => setter(e.target.value ? Number(e.target.value) : '')}
                                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center"
                                          placeholder="0"
                                        />
                                      </div>
                                    ))}
                                  </div>
                                  <p className="text-xs text-gray-400 mt-1">Total: {total}</p>
                                </div>
                              );
                            })()}

                            {/* Current Monthly Premium per Tier — shown when a calc needs currentPremium* */}
                            {needsInput('currentPremiumEE') && (() => {
                              const premRows = [
                                { key: 'EE', label: 'EE ($/month)', value: currentPremiumEE, setter: setCurrentPremiumEE },
                                { key: 'E1', label: 'E1 ($/month)', value: currentPremiumE1, setter: setCurrentPremiumE1 },
                                ...(hasECPricing ? [{ key: 'EC', label: 'EC ($/month)', value: currentPremiumEC, setter: setCurrentPremiumEC }] : []),
                                { key: 'EF', label: 'EF ($/month)', value: currentPremiumEF, setter: setCurrentPremiumEF },
                              ];
                              return (
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-2">Current Monthly Premium per Tier ($)</label>
                                  <p className="text-xs text-gray-500 mb-3">Monthly premium cost per member for each tier on the existing plan.</p>
                                  <div className={hasECPricing ? 'grid grid-cols-4 gap-4' : 'grid grid-cols-3 gap-4'}>
                                    {premRows.map(({ key, label, value, setter }) => (
                                      <div key={key}>
                                        <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                                        <input
                                          type="number" min={0} step="1" value={value}
                                          onChange={e => setter(e.target.value ? Number(e.target.value) : '')}
                                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center"
                                          placeholder="0"
                                        />
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Current Employer Contribution — shown when a calc needs currentContributionValue* */}
                            {needsInput('currentContributionValueEE') && (
                            <TierContributionInput
                              label="Current Employer Contribution"
                              includeEC={hasECPricing}
                              tierPrices={{
                                EE: Number(currentPremiumEE || 0),
                                E1: Number(currentPremiumE1 || 0),
                                EC: Number(currentPremiumEC || 0),
                                EF: Number(currentPremiumEF || 0),
                              }}
                              values={{ EE: currentContributionValueEE, E1: currentContributionValueE1, EC: currentContributionValueEC, EF: currentContributionValueEF }}
                              valueTypes={{ EE: currentContributionValueTypeEE, E1: currentContributionValueTypeE1, EC: currentContributionValueTypeEC, EF: currentContributionValueTypeEF }}
                              onValueChange={(tier, val) => {
                                if (tier === 'EE') setCurrentContributionValueEE(val);
                                else if (tier === 'E1') setCurrentContributionValueE1(val);
                                else if (tier === 'EC') setCurrentContributionValueEC(val);
                                else setCurrentContributionValueEF(val);
                              }}
                              onValueTypeChange={(tier, type) => {
                                if (tier === 'EE') setCurrentContributionValueTypeEE(type);
                                else if (tier === 'E1') setCurrentContributionValueTypeE1(type);
                                else if (tier === 'EC') setCurrentContributionValueTypeEC(type);
                                else setCurrentContributionValueTypeEF(type);
                              }}
                            />
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ================================================================
                  SECTION 3: PLAN CONFIGURATION
                  (OOP, tier counts, partial switch, contribution, enrollment dates)
                  ================================================================ */}
              <div className="border-t border-gray-200 pt-6 mt-8">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Plan Configuration</h3>
                <div className="space-y-6">

                  {/* Show message when no plan config inputs are needed */}
                  {!requiredSections.has('planConfig') && !requiredSections.has('mwTierCounts') && !requiredSections.has('partialSwitch') && !requiredSections.has('contribution') && !requiredSections.has('enrollmentDates') && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200 text-gray-500 text-sm">
                      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      No additional inputs needed for the selected document(s).
                    </div>
                  )}

                  {/* OOP / Unshared Amount */}
                  {requiredSections.has('planConfig') && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">{configFieldLabel} *</label>
                      {loadingOopOptions ? (
                        <p className="text-sm text-gray-500">Loading options from product...</p>
                      ) : oopOptions.length > 0 ? (
                        <select
                          value={oopLevel} onChange={e => setOopLevel(e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        >
                          <option value="">Select {configFieldLabel.toLowerCase()}</option>
                          {oopOptions.map(opt => (
                            <option key={opt} value={opt}>${Number(opt).toLocaleString()}</option>
                          ))}
                        </select>
                      ) : (
                        <p className="text-sm text-gray-500">No configuration options found. Check that the selected templates have a product assigned.</p>
                      )}

                      {/* Plan tier prices display.
                          Grid template adapts to whether any product prices an EC tier:
                          3-tier products → 3 price columns; 4-tier products → 4 price columns. */}
                      {productTierPricingRows.length > 0 && (() => {
                        const tierPriceColTemplate = hasECPricing
                          ? 'grid grid-cols-[minmax(0,1fr)_minmax(72px,88px)_minmax(72px,88px)_minmax(72px,88px)_minmax(72px,88px)] gap-3'
                          : 'grid grid-cols-[minmax(0,1fr)_minmax(72px,88px)_minmax(72px,88px)_minmax(72px,88px)] gap-3';
                        return (
                          <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3">
                            <p className="text-xs font-semibold text-blue-800 mb-2">Plan Tier Prices by Product</p>
                            <div className="space-y-1.5">
                              <div className={`${tierPriceColTemplate} text-[11px] font-semibold text-blue-700`}>
                                <span>Product</span>
                                <span className="text-right">EE</span>
                                <span className="text-right">E1</span>
                                {hasECPricing && <span className="text-right">EC</span>}
                                <span className="text-right">EF</span>
                              </div>
                              {productTierPricingRows.map(row => (
                                <div key={row.productId} className={`${tierPriceColTemplate} items-center text-xs text-blue-900`}>
                                  <span className="truncate" title={row.productName}>{row.productName}</span>
                                  <span className="text-right">${row.ee.toLocaleString()}</span>
                                  <span className="text-right">${row.e1.toLocaleString()}</span>
                                  {hasECPricing && <span className="text-right">${(row.ec || 0).toLocaleString()}</span>}
                                  <span className="text-right">${row.ef.toLocaleString()}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* MW Tier Counts */}
                  {requiredSections.has('mwTierCounts') && (() => {
                    const mwRows = [
                      { key: 'EE', label: 'EE (Employee Only)', value: mwCountEE, setter: setMwCountEE },
                      { key: 'E1', label: 'E1 (Employee + One)', value: mwCountE1, setter: setMwCountE1 },
                      ...(hasECPricing ? [{ key: 'EC', label: 'EC (Employee + Children)', value: mwCountEC, setter: setMwCountEC }] : []),
                      { key: 'EF', label: 'EF (Employee + Family)', value: mwCountEF, setter: setMwCountEF },
                    ];
                    const total = Number(mwCountEE || 0) + Number(mwCountE1 || 0) + (hasECPricing ? Number(mwCountEC || 0) : 0) + Number(mwCountEF || 0);
                    return (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">MightyWELL Tier Enrollment Counts *</label>
                        <p className="text-xs text-gray-500 mb-3">Number of employees expected to enroll in each tier.</p>
                        <div className={hasECPricing ? 'grid grid-cols-4 gap-4' : 'grid grid-cols-3 gap-4'}>
                          {mwRows.map(({ key, label, value, setter }) => (
                            <div key={key}>
                              <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                              <input
                                type="number" min={0} value={value}
                                onChange={e => setter(e.target.value ? Number(e.target.value) : '')}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center"
                                placeholder="0"
                              />
                            </div>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Total: {total}</p>
                      </div>
                    );
                  })()}

                  {/* Partial Switch — Per-Tier Remain on Current */}
                  {requiredSections.has('partialSwitch') && (() => {
                    const remainRows = [
                      { key: 'EE', label: 'EE (Employee Only)', value: currentRemainCountEE, setter: setCurrentRemainCountEE },
                      { key: 'E1', label: 'E1 (Employee + One)', value: currentRemainCountE1, setter: setCurrentRemainCountE1 },
                      ...(hasECPricing ? [{ key: 'EC', label: 'EC (Employee + Children)', value: currentRemainCountEC, setter: setCurrentRemainCountEC }] : []),
                      { key: 'EF', label: 'EF (Employee + Family)', value: currentRemainCountEF, setter: setCurrentRemainCountEF },
                    ];
                    const total = Number(currentRemainCountEE || 0) + Number(currentRemainCountE1 || 0) + (hasECPricing ? Number(currentRemainCountEC || 0) : 0) + Number(currentRemainCountEF || 0);
                    return (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">Employees Remaining on Current Plan</label>
                        <p className="text-xs text-gray-500 mb-3">Enter the number of employees expected to stay on the existing plan per tier. Leave at 0 for a full switch.</p>
                        <div className={hasECPricing ? 'grid grid-cols-4 gap-4' : 'grid grid-cols-3 gap-4'}>
                          {remainRows.map(({ key, label, value, setter }) => (
                            <div key={key}>
                              <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                              <input
                                type="number" min={0} value={value}
                                onChange={e => setter(e.target.value ? Number(e.target.value) : '')}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-center"
                                placeholder="0"
                              />
                            </div>
                          ))}
                        </div>
                        <p className="text-xs text-gray-400 mt-1">Total: {total}</p>
                      </div>
                    );
                  })()}

                  {/* Employer Contribution */}
                  {/* MW Employer Contribution */}
                  {requiredSections.has('contribution') && (
                    <TierContributionInput
                      label="MW Employer Contribution"
                      includeEC={hasECPricing}
                      tierPrices={mwTierPrices}
                      values={{ EE: contributionValueEE, E1: contributionValueE1, EC: contributionValueEC, EF: contributionValueEF }}
                      valueTypes={{ EE: contributionValueTypeEE, E1: contributionValueTypeE1, EC: contributionValueTypeEC, EF: contributionValueTypeEF }}
                      onValueChange={(tier, val) => {
                        if (tier === 'EE') setContributionValueEE(val);
                        else if (tier === 'E1') setContributionValueE1(val);
                        else if (tier === 'EC') setContributionValueEC(val);
                        else setContributionValueEF(val);
                      }}
                      onValueTypeChange={(tier, type) => {
                        if (tier === 'EE') setContributionValueTypeEE(type);
                        else if (tier === 'E1') setContributionValueTypeE1(type);
                        else if (tier === 'EC') setContributionValueTypeEC(type);
                        else setContributionValueTypeEF(type);
                      }}
                    />
                  )}

                  {/* Enrollment Date */}
                  {requiredSections.has('enrollmentDates') && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Enrollment Date</label>
                      <input
                        type="date"
                        value={enrollmentDate}
                        onChange={e => setEnrollmentDate(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary text-sm"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* ================================================================
                  SECTION 4: DELIVERY METHOD
                  (copied from personal proposal form — radio cards style)
                  ================================================================ */}
              <div className="border-t border-gray-200 pt-6 mt-8">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Send Method</h3>
                <div className="space-y-3">
                  <label className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio" name="sendMethod" value="download"
                      checked={sendMethod === 'download'}
                      onChange={() => setSendMethod('download')}
                      className="mr-3"
                    />
                    <Download className="h-5 w-5 mr-2 text-gray-600" />
                    <span>Download Only</span>
                  </label>
                  <label className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio" name="sendMethod" value="email"
                      checked={sendMethod === 'email'}
                      onChange={() => setSendMethod('email')}
                      className="mr-3"
                    />
                    <Mail className="h-5 w-5 mr-2 text-gray-600" />
                    <span>Send via Email</span>
                  </label>
                  <label className="flex items-center p-3 border border-gray-300 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input
                      type="radio" name="sendMethod" value="text"
                      checked={sendMethod === 'text'}
                      onChange={() => setSendMethod('text')}
                      className="mr-3"
                    />
                    <MessageSquare className="h-5 w-5 mr-2 text-gray-600" />
                    <span>Send via Text/SMS</span>
                  </label>
                </div>

                {/* Email fields */}
                {sendMethod === 'email' && (
                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Email *</label>
                      <input
                        type="email" value={recipientEmail} onChange={e => setRecipientEmail(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="client@example.com"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Email Message</label>
                      <textarea
                        value={emailMessage} onChange={e => setEmailMessage(e.target.value)}
                        rows={6}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="Enter your email message..."
                      />
                      <p className="mt-1 text-xs text-gray-500">The proposal PDF(s) will be attached to this email.</p>
                    </div>
                  </div>
                )}

                {/* Text/SMS fields */}
                {sendMethod === 'text' && (
                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Phone *</label>
                      <input
                        type="tel" value={recipientPhone} onChange={e => setRecipientPhone(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="(555) 123-4567"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Text Message <span className="font-normal text-gray-500">(Document link will be inserted when sending)</span>
                      </label>
                      <textarea
                        value={textMessage} onChange={e => setTextMessage(e.target.value)}
                        rows={4}
                        maxLength={1600}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                        placeholder="Enter your text message..."
                      />
                      <p className="mt-1 text-xs text-gray-500">{textMessage.length}/1600 characters</p>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {selectedDocIds.size > 0 && !hasAnySectionVisible && (
            <div className="mt-4 p-4 rounded-lg bg-yellow-50 text-yellow-800 text-sm">
              The selected document(s) do not require additional calculation inputs.
            </div>
          )}

          {/* Error / Success messages */}
          {error && (
            <div className="mt-4 p-4 alert alert-error">
              <p>{error}</p>
            </div>
          )}
          {success && (
            <div className="mt-4 flex items-center gap-2 p-3 rounded-lg bg-green-50 text-green-700 text-sm">
              <CheckSquare className="w-4 h-4 shrink-0" /> {success}
            </div>
          )}
        </div>

        {/* Footer — matches personal proposal form */}
        <div className="flex items-center justify-end gap-4 p-6 border-t border-gray-200">
          <button
            onClick={handleClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            disabled={generating}
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating || selectedDocIds.size === 0}
            className="btn-primary flex items-center gap-2"
          >
            {generating ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                {sendMethod === 'download' ? 'Generating...' : 'Sending...'}
              </>
            ) : (
              <>
                {sendMethod === 'download' ? (
                  <>
                    <Download className="h-4 w-4" />
                    Generate {selectedDocIds.size > 0 ? `${selectedDocIds.size} Document${selectedDocIds.size > 1 ? 's' : ''}` : 'Documents'}
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Send {selectedDocIds.size > 0 ? `${selectedDocIds.size} Document${selectedDocIds.size > 1 ? 's' : ''}` : 'Documents'}
                  </>
                )}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BusinessProposalModal;
