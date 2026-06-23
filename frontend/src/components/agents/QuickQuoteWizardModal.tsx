import {
  CheckCircle,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  MessageSquare,
  RefreshCw,
  Search,
  Sparkles,
  XCircle
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import OutboundEmailSenderNotice from '../shared/OutboundEmailSenderNotice';
import { apiService } from '../../services/api.service';
import { messageHistoryService } from '../../services/messageCenter.service';
import { ProspectService } from '../../services/prospect.service';
import { getProductDocumentItems } from '../../utils/productDocuments';
import { groupBreakdownByProduct } from './quickQuoteGrouping';

type PaymentMethod = 'ACH' | 'Card';
type TobaccoUse = 'Y' | 'N';
type TierType = 'EE' | 'ES' | 'EC' | 'EF';

interface QuickQuoteProduct {
  productId: string;
  productName: string;
  productType: string;
  isBundle?: boolean;
  subscriptionStatus?: string;
  salesType?: string;
  productDocumentUrl?: string;
  ProductDocumentUrl?: string;
  productDocuments?: Array<{
    productDocumentId?: string;
    documentUrl: string;
    displayName?: string;
    sortOrder?: number;
  }>;
  bundleProducts?: Array<{
    productId?: string;
    name?: string;
    productName?: string;
    productDocumentUrl?: string;
    ProductDocumentUrl?: string;
    productDocuments?: Array<{
      productDocumentId?: string;
      documentUrl: string;
      displayName?: string;
      sortOrder?: number;
    }>;
  }>;
}

interface QuickQuoteOptionTotals {
  subtotalPremium: number;
  processingFee: number;
  systemFees: number;
  totalPremium: number;
}

interface QuickQuoteBreakdownItem {
  quoteItemId?: string;
  productId: string;
  productName: string;
  isBundle: boolean;
  basePremium: number;
  includedProcessingFee: number;
  premiumWithIncludedFee: number;
  selectedConfigValues?: Record<string, string> | null;
  selectedConfigDetails?: Array<{ key: string; label: string; value: string }> | null;
  /** Per-option Total + Fees, sourced from the pricing authority for this product+amount. */
  optionTotals?: QuickQuoteOptionTotals | null;
}

interface QuickQuoteResponse {
  success: boolean;
  data: {
    criteria: {
      personName?: string;
      age: number;
      tobaccoUse: TobaccoUse;
      tier: TierType;
      householdSize: number;
      paymentMethod: PaymentMethod;
    };
    breakdown: QuickQuoteBreakdownItem[];
    totals: {
      subtotalPremium: number;
      processingFee: number;
      systemFees: number;
      totalPremium: number;
    };
    quoteOptions?: Array<{
      optionId: string;
      optionLabel: string;
      breakdown: QuickQuoteBreakdownItem[];
      totals: {
        subtotalPremium: number;
        processingFee: number;
        systemFees: number;
        totalPremium: number;
      };
    }>;
    /** True when products carry multiple unshared-amount options: show a per-product
     * comparison with no combined total instead of a single basket total. */
    comparison?: boolean;
  };
  message?: string;
}

interface SendQuotePayload {
  audience: 'individual' | 'group';
  criteria: {
    personName?: string;
    age: number;
    tobaccoUse: TobaccoUse;
    tier: TierType;
    householdSize: number;
    paymentMethod: PaymentMethod;
  };
  breakdown: QuickQuoteBreakdownItem[];
  totals: {
    subtotalPremium: number;
    processingFee: number;
    systemFees: number;
    totalPremium: number;
  };
  quoteOptions?: QuickQuoteResponse['data']['quoteOptions'];
  comparison?: boolean;
  recipientName?: string;
  recipientEmail?: string;
}

interface ProductPricingRow {
  ConfigField1?: string | null;
  ConfigValue1?: string | null;
  ConfigField2?: string | null;
  ConfigValue2?: string | null;
  ConfigField3?: string | null;
  ConfigValue3?: string | null;
  ConfigField4?: string | null;
  ConfigValue4?: string | null;
  ConfigField5?: string | null;
  ConfigValue5?: string | null;
}

interface ProductConfigOption {
  key: string;
  label: string;
  values: string[];
}

interface QuickQuoteWizardModalProps {
  isOpen: boolean;
  onClose: () => void;
  products: QuickQuoteProduct[];
  /** Optional: pre-fill recipient info (e.g. when opened from a Prospect's detail view). */
  initialProspect?: { name?: string; email?: string; phone?: string };
  /** Optional: called after a quote is successfully sent/downloaded to a recipient. */
  onSent?: () => void;
}

interface SelectedQuoteDocument {
  id: string;
  productId: string;
  productName: string;
  displayName: string;
  documentUrl: string;
}

const STEPS = ['Member Criteria', 'Products', 'Quote'] as const;

const normalizeTobacco = (value: string): TobaccoUse => (value === 'Y' ? 'Y' : 'N');

const tierToHouseholdSize = (tier: TierType): number => {
  if (tier === 'EE') return 1;
  if (tier === 'ES') return 2;
  if (tier === 'EC') return 2;
  return 3;
};

const currency = (value: number) => `$${Number(value || 0).toFixed(2)}`;

function QuickQuoteTotalsSummary({
  totals
}: {
  totals: {
    subtotalPremium: number;
    processingFee: number;
    systemFees: number;
    totalPremium: number;
  };
}) {
  const combinedFees = Number(totals.processingFee || 0) + Number(totals.systemFees || 0);
  const hasFeesLine = combinedFees > 0.005;
  return (
    <div className="mt-1 space-y-1 text-sm">
      {hasFeesLine ? (
        <div className="flex items-center justify-between text-gray-600">
          <span>Fees</span>
          <span className="tabular-nums">{currency(combinedFees)}</span>
        </div>
      ) : null}
      <div className="flex items-center justify-between font-semibold text-gray-900">
        <span>Total</span>
        <span className="tabular-nums">{currency(totals.totalPremium)}</span>
      </div>
    </div>
  );
}
/** Poll Message History while status is Sending (until Delivered/Failed or cap). */
const QUICK_QUOTE_EMAIL_POLL_MS = 2500;
const QUICK_QUOTE_EMAIL_POLL_MAX_MS = 60000;

type QuoteEmailDeliveryState = {
  historyId: string;
  /** Shown in the delivery banner (recipient + context). */
  recipientEmail?: string;
  status: string;
  errorMessage?: string;
  /** UI phase after polling loop ends */
  phase: 'polling' | 'complete' | 'timeout' | 'error';
  timedOut?: boolean;
};

const cleanLabel = (value: unknown): string => {
  const v = String(value || '').trim();
  if (!v) return '';
  const lower = v.toLowerCase();
  if (lower === 'null' || lower === 'undefined' || lower === 'n/a' || lower === 'na') return '';
  return v;
};

const QuickQuoteWizardModal: React.FC<QuickQuoteWizardModalProps> = ({ isOpen, onClose, products, initialProspect, onSent }) => {
  const [audienceTab, setAudienceTab] = useState<'individual' | 'group'>('individual');
  const [step, setStep] = useState(0);
  const [personName, setPersonName] = useState(initialProspect?.name ?? '');
  const [age, setAge] = useState<number>(35);
  const [tobaccoUse, setTobaccoUse] = useState<TobaccoUse>('N');
  const [tier, setTier] = useState<TierType>('EE');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('ACH');

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [pricingLoadingByProductId, setPricingLoadingByProductId] = useState<Record<string, boolean>>({});
  const [configOptionsByProductId, setConfigOptionsByProductId] = useState<Record<string, ProductConfigOption[]>>({});
  const [selectedConfigsByProductId, setSelectedConfigsByProductId] = useState<Record<string, Record<string, string[]>>>({});

  const [calculating, setCalculating] = useState(false);
  const [calculateError, setCalculateError] = useState<string>('');
  const [quoteResult, setQuoteResult] = useState<QuickQuoteResponse['data'] | null>(null);
  const [showSendQuoteModal, setShowSendQuoteModal] = useState(false);
  const [sendRecipientName, setSendRecipientName] = useState(initialProspect?.name ?? '');
  const [sendRecipientEmail, setSendRecipientEmail] = useState(initialProspect?.email ?? '');
  const [sendRecipientPhone, setSendRecipientPhone] = useState(initialProspect?.phone ?? '');
  const [sendChannel, setSendChannel] = useState<'email' | 'sms'>('email');
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [prepareError, setPrepareError] = useState('');
  const [prepareMeta, setPrepareMeta] = useState<{
    documentUrl: string;
    fromEmail: string;
    fromDisplayName: string;
    replyToEmail: string;
    replyToName: string;
    defaultEmailBody: string;
    defaultSubject: string;
  } | null>(null);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  /** Product document ids to attach to the email (premium quote PDF is always attached separately). */
  const [emailProductDocAttachments, setEmailProductDocAttachments] = useState<Record<string, boolean>>({});
  const [smsBody, setSmsBody] = useState('');
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [sendQuoteError, setSendQuoteError] = useState('');
  const [sendSuccessFeedback, setSendSuccessFeedback] = useState<string | null>(null);
  /** Email sent but Message History id missing (e.g. logging skipped) — neutral info strip, not the green “Sent” + delivery combo. */
  const [emailQuoteInfoBanner, setEmailQuoteInfoBanner] = useState<string | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [sendingSms, setSendingSms] = useState(false);
  const [copyLinkFeedback, setCopyLinkFeedback] = useState(false);
  const [resolvingDocs, setResolvingDocs] = useState(false);
  const [resolvedDocUrlsById, setResolvedDocUrlsById] = useState<Record<string, string>>({});
  const [downloadingAllDocs, setDownloadingAllDocs] = useState(false);
  const [emailDeliveryPollId, setEmailDeliveryPollId] = useState<string | null>(null);
  const [quoteEmailDelivery, setQuoteEmailDelivery] = useState<QuoteEmailDeliveryState | null>(null);
  const [emailDeliveryRefreshing, setEmailDeliveryRefreshing] = useState(false);

  const matchesAudience = (product: QuickQuoteProduct, tab: 'individual' | 'group') => {
    const salesType = String(product.salesType || '').trim().toLowerCase();
    if (!salesType || salesType === 'both') return true;
    return tab === 'individual' ? salesType === 'individual' : salesType === 'group';
  };

  const filteredProducts = useMemo(() => {
    const activeProducts = products.filter((p) => p.subscriptionStatus === 'Active' || p.subscriptionStatus === 'Pending');
    const audienceFiltered = activeProducts.filter((p) => matchesAudience(p, audienceTab));
    const searched = !searchTerm.trim()
      ? audienceFiltered
      : audienceFiltered.filter((p) => {
        const needle = searchTerm.trim().toLowerCase();
        return (
      p.productName.toLowerCase().includes(needle) || p.productType.toLowerCase().includes(needle)
        );
      });

    return [...searched].sort((a, b) => {
      const bundleSort = Number(Boolean(b.isBundle)) - Number(Boolean(a.isBundle));
      if (bundleSort !== 0) return bundleSort;
      return a.productName.localeCompare(b.productName);
    });
  }, [products, searchTerm, audienceTab]);

  const individualCount = useMemo(
    () => products.filter((p) => (p.subscriptionStatus === 'Active' || p.subscriptionStatus === 'Pending') && matchesAudience(p, 'individual')).length,
    [products]
  );
  const groupCount = useMemo(
    () => products.filter((p) => (p.subscriptionStatus === 'Active' || p.subscriptionStatus === 'Pending') && matchesAudience(p, 'group')).length,
    [products]
  );

  const selectedQuoteDocuments = useMemo<SelectedQuoteDocument[]>(() => {
    const selectedProducts = products.filter((p) => selectedProductIds.includes(p.productId));
    const docs: SelectedQuoteDocument[] = [];

    for (const product of selectedProducts) {
      const topLevelDocs = getProductDocumentItems(product);
      topLevelDocs.forEach((doc, index) => {
        docs.push({
          id: `${product.productId}-main-${doc.productDocumentId || index}-${doc.documentUrl}`,
          productId: product.productId,
          productName: product.productName,
          displayName: doc.displayName?.trim() || `Document ${index + 1}`,
          documentUrl: doc.documentUrl
        });
      });

      if (product.isBundle && Array.isArray(product.bundleProducts)) {
        product.bundleProducts.forEach((includedProduct, includedIndex) => {
          const includedDocs = getProductDocumentItems(includedProduct || {});
          if (includedDocs.length === 0) return;
          const includedName = String(includedProduct?.name || includedProduct?.productName || `Included Product ${includedIndex + 1}`).trim();
          const includedProductId = String(includedProduct?.productId || product.productId);
          includedDocs.forEach((doc, docIndex) => {
            docs.push({
              id: `${product.productId}-included-${includedProductId}-${doc.productDocumentId || docIndex}-${doc.documentUrl}`,
              productId: includedProductId,
              productName: includedName || product.productName,
              displayName: doc.displayName?.trim() || `Document ${docIndex + 1}`,
              documentUrl: doc.documentUrl
            });
          });
        });
      }
    }

    const deduped = new Map<string, SelectedQuoteDocument>();
    for (const doc of docs) {
      const key = `${doc.productId}|${doc.documentUrl}|${doc.displayName}`;
      if (!deduped.has(key)) {
        deduped.set(key, doc);
      }
    }
    return Array.from(deduped.values());
  }, [products, selectedProductIds]);

  // When the modal opens (or initialProspect changes), seed person + recipient fields.
  useEffect(() => {
    if (!isOpen) return;
    if (initialProspect?.name) setPersonName(initialProspect.name);
    if (initialProspect?.name) setSendRecipientName(initialProspect.name);
    if (initialProspect?.email) setSendRecipientEmail(initialProspect.email);
    if (initialProspect?.phone) setSendRecipientPhone(initialProspect.phone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    if (step !== 2 || !quoteResult || selectedQuoteDocuments.length === 0) {
      setResolvedDocUrlsById({});
      setResolvingDocs(false);
      return;
    }

    let cancelled = false;
    const resolveUrls = async () => {
      setResolvingDocs(true);
      const perProductUrlCache = new Map<string, string>();
      const resolvedEntries = await Promise.all(
        selectedQuoteDocuments.map(async (doc) => {
          const rawUrl = String(doc.documentUrl || '').trim();
          if (!rawUrl) return [doc.id, ''] as const;
          if (/^https?:\/\//i.test(rawUrl)) return [doc.id, rawUrl] as const;

          const cached = perProductUrlCache.get(doc.productId);
          if (cached) return [doc.id, cached] as const;

          try {
            const response = await apiService.get<{ success: boolean; data?: { downloadUrl?: string } }>(
              `/api/products/${doc.productId}/document`
            );
            const resolvedUrl = response?.success && response?.data?.downloadUrl
              ? response.data.downloadUrl
              : rawUrl;
            perProductUrlCache.set(doc.productId, resolvedUrl);
            return [doc.id, resolvedUrl] as const;
          } catch {
            return [doc.id, rawUrl] as const;
          }
        })
      );

      if (!cancelled) {
        setResolvedDocUrlsById(Object.fromEntries(resolvedEntries));
        setResolvingDocs(false);
      }
    };

    void resolveUrls();
    return () => {
      cancelled = true;
    };
  }, [quoteResult, selectedQuoteDocuments, step]);

  useEffect(() => {
    if (!sendSuccessFeedback) return;
    const t = window.setTimeout(() => setSendSuccessFeedback(null), 12000);
    return () => window.clearTimeout(t);
  }, [sendSuccessFeedback]);

  useEffect(() => {
    if (!emailQuoteInfoBanner) return;
    const t = window.setTimeout(() => setEmailQuoteInfoBanner(null), 12000);
    return () => window.clearTimeout(t);
  }, [emailQuoteInfoBanner]);

  useEffect(() => {
    if (!emailDeliveryPollId) return;
    let cancelled = false;
    const historyId = emailDeliveryPollId;
    const start = Date.now();

    const run = async () => {
      try {
        while (Date.now() - start < QUICK_QUOTE_EMAIL_POLL_MAX_MS && !cancelled) {
          const r = await messageHistoryService.getDeliveryDetails(historyId);
          if (cancelled) return;
          if (!r.success || !r.data) {
            setQuoteEmailDelivery((prev) => ({
              historyId,
              status: 'Sending',
              phase: 'error',
              errorMessage: r.message || 'Could not load delivery status',
              recipientEmail: prev?.recipientEmail
            }));
            return;
          }
          const st = r.data.status;
          const err = r.data.errorMessage;
          setQuoteEmailDelivery((prev) => {
            const base: QuoteEmailDeliveryState = {
              historyId,
              status: st,
              errorMessage: err,
              phase: 'polling',
              recipientEmail: prev?.recipientEmail
            };
            if (st !== 'Sending') {
              return { ...base, phase: 'complete' };
            }
            return base;
          });
          if (st !== 'Sending') {
            return;
          }
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, QUICK_QUOTE_EMAIL_POLL_MS);
          });
        }
        if (!cancelled) {
          setQuoteEmailDelivery((prev) =>
            prev && prev.historyId === historyId
              ? {
                  ...prev,
                  phase: 'timeout',
                  timedOut: true,
                  status: prev.status || 'Sending'
                }
              : {
                  historyId,
                  status: 'Sending',
                  phase: 'timeout',
                  timedOut: true
                }
          );
        }
      } catch {
        if (!cancelled) {
          setQuoteEmailDelivery((prev) =>
            prev && prev.historyId === historyId
              ? { ...prev, phase: 'error' }
              : { historyId, status: 'Sending', phase: 'error' }
          );
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [emailDeliveryPollId]);

  const refreshQuoteEmailDelivery = async () => {
    const historyId = quoteEmailDelivery?.historyId;
    if (!historyId) return;
    setEmailDeliveryRefreshing(true);
    try {
      const r = await messageHistoryService.getDeliveryDetails(historyId);
      if (!r.success || !r.data) {
        setQuoteEmailDelivery((prev) =>
          prev
            ? {
                ...prev,
                phase: 'error',
                errorMessage: r.message || 'Could not load delivery status'
              }
            : prev
        );
        return;
      }
      const st = r.data.status;
      const err = r.data.errorMessage;
      setQuoteEmailDelivery((prev) => {
        if (!prev) return prev;
        const next: QuoteEmailDeliveryState = {
          ...prev,
          status: st,
          errorMessage: err,
          timedOut: false
        };
        if (st !== 'Sending') {
          return { ...next, phase: 'complete' };
        }
        return { ...next, phase: 'polling' };
      });
    } finally {
      setEmailDeliveryRefreshing(false);
    }
  };

  useEffect(() => {
    if (!showSendQuoteModal || !quoteResult) {
      return;
    }
    let cancelled = false;
    const run = async () => {
      setPrepareLoading(true);
      setPrepareError('');
      setPrepareMeta(null);
      const payload: SendQuotePayload = {
        audience: audienceTab,
        criteria: quoteResult.criteria,
        breakdown: quoteResult.breakdown,
        totals: quoteResult.totals,
        quoteOptions: quoteResult.quoteOptions,
        comparison: quoteResult.comparison,
        recipientName: sendRecipientName.trim() || quoteResult.criteria.personName,
        recipientEmail: sendRecipientEmail.trim() || undefined
      };
      try {
        const res = await apiService.post<{
          success: boolean;
          data?: {
            documentUrl: string;
            fromEmail: string;
            fromDisplayName: string;
            replyToEmail: string;
            replyToName: string;
            defaultEmailBody: string;
            defaultSubject: string;
          };
          message?: string;
        }>('/api/me/agent/products/quick-quote/prepare-send', payload);
        if (cancelled) return;
        if (!res.success || !res.data) {
          throw new Error((res as { message?: string }).message || 'Failed to prepare quote for sending');
        }
        setPrepareMeta(res.data);
        setEmailSubject(res.data.defaultSubject || '');
        setEmailBody(res.data.defaultEmailBody || '');
        const first = (sendRecipientName.trim() || quoteResult.criteria.personName || 'there').split(/\s+/)[0] || 'there';
        const senderName = res.data.replyToName || 'Your agent';
        setSmsBody(
          `${senderName} sent you a link to a premium quote. Hi ${first}, use the quote link we send on the next line to view or download your PDF.`
        );
      } catch (e: unknown) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : 'Failed to prepare quote for sending';
          setPrepareError(msg);
        }
      } finally {
        if (!cancelled) setPrepareLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prepare once per open; omit recipient fields to avoid re-upload on every keystroke
  }, [showSendQuoteModal, quoteResult, audienceTab]);

  const handleAudienceTabChange = (tab: 'individual' | 'group') => {
    setAudienceTab(tab);
    setSearchTerm('');
    setSelectedProductIds([]);
    setConfigOptionsByProductId({});
    setSelectedConfigsByProductId({});
    setCalculateError('');
    setQuoteResult(null);
  };

  const loadConfigOptionsForProduct = async (productId: string) => {
    if (configOptionsByProductId[productId] || pricingLoadingByProductId[productId]) return;
    setPricingLoadingByProductId((prev) => ({ ...prev, [productId]: true }));
    try {
      const response = await apiService.get<{ success: boolean; data: ProductPricingRow[] }>(
        `/api/me/agent/products/${productId}/pricing`
      );
      const rows = response?.data || [];
      const nextOptions: ProductConfigOption[] = [];
      const nextDefaults: Record<string, string[]> = {};
      const nonEmptyLabelsBySlot: Record<string, string> = {};

      for (let i = 1; i <= 5; i += 1) {
        const fieldKey = `ConfigField${i}` as keyof ProductPricingRow;
        const slotLabel = cleanLabel(rows.find((r) => cleanLabel(r[fieldKey]))?.[fieldKey]);
        if (slotLabel) {
          nonEmptyLabelsBySlot[String(i)] = slotLabel;
        }
      }
      const availableLabels = Object.values(nonEmptyLabelsBySlot);

      for (let i = 1; i <= 5; i += 1) {
        const fieldKey = `ConfigField${i}` as keyof ProductPricingRow;
        const valueKey = `ConfigValue${i}` as keyof ProductPricingRow;
        const directLabel = cleanLabel(rows.find((r) => cleanLabel(r[fieldKey]))?.[fieldKey]);
        const values = Array.from(
          new Set(
            rows
              .map((r) => String(r[valueKey] || '').trim())
              .filter((v) => Boolean(v))
          )
        );

        if (values.length > 0) {
          const key = String(i);
          const fallbackLabel =
            i === 1
              ? 'Plan'
              : `Plan ${i}`;
          const inheritedLabel = availableLabels.length === 1 ? availableLabels[0] : '';
          nextOptions.push({
            key,
            label: directLabel || inheritedLabel || fallbackLabel,
            values
          });
          nextDefaults[key] = values[0] ? [values[0]] : [];
        }
      }

      if (nextOptions.length > 0) {
        setConfigOptionsByProductId((prev) => ({ ...prev, [productId]: nextOptions }));
        setSelectedConfigsByProductId((prev) => ({
          ...prev,
          [productId]: {
            ...nextDefaults,
            ...(prev[productId] || {})
          }
        }));
      }
    } catch {
      // Keep wizard resilient if pricing metadata fails for one product.
    } finally {
      setPricingLoadingByProductId((prev) => ({ ...prev, [productId]: false }));
    }
  };

  const toggleProduct = async (productId: string) => {
    setCalculateError('');
    setQuoteResult(null);
    setSelectedProductIds((prev) => {
      const exists = prev.includes(productId);
      if (exists) return prev.filter((id) => id !== productId);
      return [...prev, productId];
    });
    await loadConfigOptionsForProduct(productId);
  };

  const goNext = async () => {
    if (step === 1) {
      setCalculateError('');
      setQuoteResult(null);
      const payload = {
        criteria: {
          personName: personName.trim() || undefined,
          age,
          tobaccoUse: normalizeTobacco(tobaccoUse),
          tier,
          householdSize: tierToHouseholdSize(tier),
          paymentMethod,
          quoteAudience: audienceTab
        },
        selectedProducts: selectedProductIds.map((productId) => ({
          productId,
          configValues: selectedConfigsByProductId[productId] || {},
          configLabels: (configOptionsByProductId[productId] || []).reduce<Record<string, string>>((acc, option) => {
            acc[option.key] = option.label || 'Plan';
            return acc;
          }, {})
        }))
      };

      setCalculating(true);
      try {
        const response = await apiService.post<QuickQuoteResponse>('/api/me/agent/products/quick-quote/calculate', payload);
        if (!response.success || !response.data) {
          throw new Error(response.message || 'Failed to calculate quote');
        }
        setQuoteResult(response.data);
        setStep(2);
      } catch (error: any) {
        setCalculateError(error?.message || 'Failed to calculate quote');
      } finally {
        setCalculating(false);
      }
      return;
    }

    setStep((prev) => Math.min(prev + 1, STEPS.length - 1));
  };

  const goBack = () => setStep((prev) => Math.max(prev - 1, 0));

  const canContinue = () => {
    if (step === 0) return age >= 0 && age <= 120;
    if (step === 1) {
      if (selectedProductIds.length === 0 || calculating) return false;
      for (const productId of selectedProductIds) {
        const configOptions = configOptionsByProductId[productId] || [];
        if (!configOptions.length) continue;
        const selectedBySlot = selectedConfigsByProductId[productId] || {};
        for (const option of configOptions) {
          const values = selectedBySlot[option.key] || [];
          if (!Array.isArray(values) || values.length === 0) return false;
        }
      }
      return true;
    }
    return false;
  };

  const closeWizard = () => {
    setStep(0);
    setAudienceTab('individual');
    setPersonName('');
    setAge(35);
    setTobaccoUse('N');
    setTier('EE');
    setPaymentMethod('ACH');
    setSearchTerm('');
    setSelectedProductIds([]);
    setConfigOptionsByProductId({});
    setSelectedConfigsByProductId({});
    setCalculateError('');
    setQuoteResult(null);
    setShowSendQuoteModal(false);
    setSendRecipientName('');
    setSendRecipientEmail('');
    setSendRecipientPhone('');
    setSendChannel('email');
    setPrepareLoading(false);
    setPrepareError('');
    setPrepareMeta(null);
    setEmailSubject('');
    setEmailBody('');
    setEmailProductDocAttachments({});
    setSmsBody('');
    setSendingEmail(false);
    setSendingSms(false);
    setCopyLinkFeedback(false);
    setSendQuoteError('');
    setSendSuccessFeedback(null);
    setEmailQuoteInfoBanner(null);
    setEmailDeliveryPollId(null);
    setQuoteEmailDelivery(null);
    setResolvingDocs(false);
    setResolvedDocUrlsById({});
    setDownloadingAllDocs(false);
    onClose();
  };

  /** Best-effort: fire-and-forget prospect create/update when a quote is sent to a known email. */
  const createProspectBestEffort = (recipientName: string, recipientEmail: string, recipientPhone: string) => {
    if (!recipientEmail.trim()) return;
    const nameParts = recipientName.trim().split(/\s+/);
    const firstName = nameParts[0] || undefined;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
    ProspectService.create({
      firstName,
      lastName,
      email: recipientEmail.trim() || undefined,
      phone: recipientPhone.trim() || undefined,
    }).catch(() => {
      // Best-effort: silently swallow errors so they never block the quote send.
    });
  };

  const makeDownloadName = (name: string) =>
    `${name || 'document'}`
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'document';

  const isAbsoluteHttpUrl = (url: string) => /^https?:\/\//i.test(String(url || '').trim());

  const selectAllProductDocsForEmail = () => {
    const next: Record<string, boolean> = {};
    selectedQuoteDocuments.forEach((d) => {
      next[d.id] = true;
    });
    setEmailProductDocAttachments(next);
  };

  const clearProductDocsForEmail = () => setEmailProductDocAttachments({});

  const downloadDocumentToComputer = async (url: string, fileName: string): Promise<boolean> => {
    const normalizedUrl = new URL(url, window.location.origin);
    const isSameOrigin = normalizedUrl.origin === window.location.origin;
    if (!isSameOrigin) {
      return false;
    }

    try {
      const blob = await apiService.get<Blob>(
        `${normalizedUrl.pathname}${normalizedUrl.search}`,
        { responseType: 'blob' } as any
      );
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);
      return true;
    } catch {
      return false;
    }
  };

  const handleDownloadAllDocuments = async () => {
    if (selectedQuoteDocuments.length === 0 || downloadingAllDocs) return;
    setDownloadingAllDocs(true);
    try {
      for (const docItem of selectedQuoteDocuments) {
        const docUrl = resolvedDocUrlsById[docItem.id] || docItem.documentUrl;
        if (!docUrl) continue;
        const downloadName = `${makeDownloadName(docItem.productName)}-${makeDownloadName(docItem.displayName)}.pdf`;
        const didDownload = await downloadDocumentToComputer(docUrl, downloadName);
        if (!didDownload) {
          // Fallback to new tab (never navigate current app tab).
          const absoluteUrl = new URL(docUrl, window.location.origin).toString();
          window.open(absoluteUrl, '_blank', 'noopener,noreferrer');
        }
      }
    } finally {
      setDownloadingAllDocs(false);
    }
  };

  const handleDownloadQuotePdf = async () => {
    if (!quoteResult) return;
    setSendQuoteError('');
    setDownloadingPdf(true);
    try {
      const payload: SendQuotePayload = {
        audience: audienceTab,
        criteria: quoteResult.criteria,
        breakdown: quoteResult.breakdown,
        totals: quoteResult.totals,
        quoteOptions: quoteResult.quoteOptions,
        comparison: quoteResult.comparison,
        recipientName: sendRecipientName.trim() || undefined,
        recipientEmail: sendRecipientEmail.trim() || undefined
      };

      const blob = await apiService.post<Blob>(
        '/api/me/agent/products/quick-quote/pdf',
        payload,
        { responseType: 'blob' } as any
      );

      const fileName = `quick-quote-${new Date().toISOString().slice(0, 10)}.pdf`;
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      createProspectBestEffort(sendRecipientName, sendRecipientEmail, sendRecipientPhone);
      onSent?.();
      setShowSendQuoteModal(false);
    } catch (error: any) {
      setSendQuoteError(error?.message || 'Failed to generate quote PDF');
    } finally {
      setDownloadingPdf(false);
    }
  };

  const copyDocumentLink = async () => {
    if (!prepareMeta?.documentUrl) return;
    try {
      const nav = typeof globalThis !== 'undefined' ? (globalThis as unknown as { navigator?: Navigator }).navigator : undefined;
      if (!nav?.clipboard?.writeText) {
        setSendQuoteError('Clipboard is not available in this browser.');
        return;
      }
      await nav.clipboard.writeText(prepareMeta.documentUrl);
      setCopyLinkFeedback(true);
      setTimeout(() => setCopyLinkFeedback(false), 2000);
    } catch {
      setSendQuoteError('Could not copy link to clipboard');
    }
  };

  const handleSendQuickQuoteEmail = async () => {
    if (!prepareMeta?.documentUrl) {
      setSendQuoteError('Quote document is not ready yet.');
      return;
    }
    if (!sendRecipientEmail.trim() || !sendRecipientEmail.includes('@')) {
      setSendQuoteError('A valid recipient email is required.');
      return;
    }
    if (!emailBody.trim()) {
      setSendQuoteError('Message cannot be empty.');
      return;
    }
    const additionalAttachmentUrls = selectedQuoteDocuments
      .filter((d) => emailProductDocAttachments[d.id])
      .map((d) => {
        const url = String(resolvedDocUrlsById[d.id] || d.documentUrl || '').trim();
        if (!isAbsoluteHttpUrl(url)) return null;
        return {
          url,
          filename: `${makeDownloadName(d.productName)}-${makeDownloadName(d.displayName)}.pdf`
        };
      })
      .filter((x): x is { url: string; filename: string } => Boolean(x));
    const selectedButNotReady = selectedQuoteDocuments.some(
      (d) => emailProductDocAttachments[d.id] && !isAbsoluteHttpUrl(String(resolvedDocUrlsById[d.id] || d.documentUrl || '').trim())
    );
    if (selectedButNotReady) {
      setSendQuoteError('Some selected product documents are still loading. Wait a moment or uncheck them.');
      return;
    }
    setSendingEmail(true);
    setSendQuoteError('');
    setEmailDeliveryPollId(null);
    setQuoteEmailDelivery(null);
    setEmailQuoteInfoBanner(null);
    try {
      const sendRes = await apiService.post<{
        success: boolean;
        message?: string;
        messageHistoryId?: string | null;
      }>('/api/me/agent/products/quick-quote/send-email', {
        documentUrl: prepareMeta.documentUrl,
        recipientEmail: sendRecipientEmail.trim(),
        subject: emailSubject.trim() || prepareMeta.defaultSubject,
        message: emailBody.trim(),
        additionalAttachmentUrls
      });
      const recipient = sendRecipientEmail.trim();
      const hid = sendRes?.messageHistoryId;
      createProspectBestEffort(sendRecipientName, recipient, sendRecipientPhone);
      onSent?.();
      setShowSendQuoteModal(false);
      if (hid && typeof hid === 'string') {
        setSendSuccessFeedback(null);
        setQuoteEmailDelivery({
          historyId: hid,
          recipientEmail: recipient,
          status: 'Sending',
          phase: 'polling'
        });
        setEmailDeliveryPollId(hid);
      } else {
        setEmailQuoteInfoBanner(
          `Quote email was submitted to ${recipient}. If your address differs from the recipient, you were CC’d a copy. Delivery status is not tracked for this send in Message History.`
        );
      }
    } catch (error: any) {
      setSendQuoteError(error?.message || 'Failed to send email');
    } finally {
      setSendingEmail(false);
    }
  };

  const handleSendQuickQuoteSms = async () => {
    if (!prepareMeta?.documentUrl) {
      setSendQuoteError('Quote document is not ready yet.');
      return;
    }
    if (!sendRecipientPhone.trim()) {
      setSendQuoteError('A recipient phone number is required.');
      return;
    }
    if (!smsBody.trim()) {
      setSendQuoteError('Message cannot be empty.');
      return;
    }
    setSendingSms(true);
    setSendQuoteError('');
    try {
      await apiService.post<{ success: boolean; message?: string }>('/api/me/agent/products/quick-quote/send-sms', {
        documentUrl: prepareMeta.documentUrl,
        recipientPhone: sendRecipientPhone.trim(),
        message: smsBody.trim()
      });
      createProspectBestEffort(sendRecipientName, sendRecipientEmail, sendRecipientPhone);
      onSent?.();
      setSendSuccessFeedback('SMS queued successfully. The recipient will get your message and the quote link shortly.');
      setShowSendQuoteModal(false);
    } catch (error: any) {
      setSendQuoteError(error?.message || 'Failed to send SMS');
    } finally {
      setSendingSms(false);
    }
  };

  if (!isOpen) return null;

  const showQuoteEmailRefreshButton =
    quoteEmailDelivery != null &&
    !(
      quoteEmailDelivery.phase === 'complete' &&
      (quoteEmailDelivery.status === 'Delivered' || quoteEmailDelivery.status === 'Sent')
    );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="w-full max-w-4xl rounded-lg border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 p-6">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Quote</h2>
            <p className="text-sm text-gray-600">Estimate premium totals from member criteria and selected products.</p>
          </div>
          <button onClick={closeWizard} className="text-gray-500 hover:text-gray-700">
            <XCircle className="h-6 w-6" />
          </button>
        </div>

        <div className="border-b border-gray-200 px-6 py-4">
          <div className="flex flex-wrap items-center gap-3">
            {STEPS.map((label, index) => (
              <div key={label} className="flex items-center gap-3">
                <span
                  className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                    step >= index ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
                  }`}
                >
                  {index + 1}
                </span>
                <span className={`text-sm ${step >= index ? 'text-gray-900' : 'text-gray-500'}`}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-6">
          {sendSuccessFeedback && !quoteEmailDelivery ? (
            <div
              className="mb-4 flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800"
              role="status"
            >
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-green-900">Sent</p>
                <p className="mt-1 text-green-800">{sendSuccessFeedback}</p>
              </div>
              <button
                type="button"
                onClick={() => setSendSuccessFeedback(null)}
                className="shrink-0 rounded p-1 text-green-700 hover:bg-green-100"
                aria-label="Dismiss"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>
          ) : null}
          {emailQuoteInfoBanner && !quoteEmailDelivery ? (
            <div
              className="mb-4 flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm text-gray-800"
              role="status"
            >
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-gray-600" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900">Quote email</p>
                <p className="mt-1 text-gray-700">{emailQuoteInfoBanner}</p>
              </div>
              <button
                type="button"
                onClick={() => setEmailQuoteInfoBanner(null)}
                className="shrink-0 rounded p-1 text-gray-600 hover:bg-gray-100"
                aria-label="Dismiss"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>
          ) : null}
          {quoteEmailDelivery ? (
            <div
              className={`mb-4 flex flex-col gap-3 rounded-lg border p-4 text-sm sm:flex-row sm:items-start ${
                quoteEmailDelivery.status === 'Failed'
                  ? 'border-red-200 bg-red-50 text-red-800'
                  : quoteEmailDelivery.phase === 'timeout' || quoteEmailDelivery.phase === 'error'
                    ? 'border-amber-200 bg-amber-50 text-amber-900'
                    : quoteEmailDelivery.status === 'Delivered' || quoteEmailDelivery.status === 'Sent'
                      ? 'border-green-200 bg-green-50 text-green-800'
                      : 'border-gray-200 bg-gray-50 text-gray-800'
              }`}
              role="status"
            >
              <div className="flex w-full items-start gap-3">
                {emailDeliveryRefreshing ? (
                  <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[var(--oe-primary)]" aria-hidden />
                ) : quoteEmailDelivery.phase === 'polling' && quoteEmailDelivery.status === 'Sending' ? (
                  <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-[var(--oe-primary)]" aria-hidden />
                ) : quoteEmailDelivery.status === 'Failed' ? (
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" aria-hidden />
                ) : quoteEmailDelivery.phase === 'timeout' || quoteEmailDelivery.phase === 'error' ? (
                  <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden />
                ) : (
                  <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-gray-900">
                    {quoteEmailDelivery.phase === 'polling' && quoteEmailDelivery.status === 'Sending'
                      ? 'Confirming delivery'
                      : quoteEmailDelivery.phase === 'timeout'
                        ? 'Delivery status still pending'
                        : quoteEmailDelivery.phase === 'error'
                          ? 'Could not refresh delivery status'
                          : quoteEmailDelivery.status === 'Failed'
                            ? 'Delivery failed'
                            : 'Delivery confirmed'}
                  </p>
                  {quoteEmailDelivery.recipientEmail ? (
                    <p className="mt-0.5 text-xs text-gray-600">To: {quoteEmailDelivery.recipientEmail}</p>
                  ) : null}
                  <p className="mt-1">
                    {quoteEmailDelivery.phase === 'polling' && quoteEmailDelivery.status === 'Sending'
                      ? 'Checking message history until the provider reports delivered or failed (up to about a minute).'
                      : quoteEmailDelivery.phase === 'timeout'
                        ? 'We stopped auto-refreshing after one minute. Open Message History (tenant admin) to see the latest status.'
                        : quoteEmailDelivery.phase === 'error'
                          ? 'Use Refresh status below, open Message History (tenant admin), or contact support if this persists.'
                          : quoteEmailDelivery.status === 'Failed'
                            ? 'The provider reported a failure for this send. Details may appear below.'
                            : `Status: ${quoteEmailDelivery.status}. Provider details (if any) may appear below.`}
                  </p>
                  {quoteEmailDelivery.errorMessage ? (
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-gray-200 bg-white/80 p-2 font-sans text-xs text-gray-700">
                      {quoteEmailDelivery.errorMessage}
                    </pre>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setEmailDeliveryPollId(null);
                    setQuoteEmailDelivery(null);
                  }}
                  className="shrink-0 rounded p-1 text-gray-600 hover:bg-white/50"
                  aria-label="Dismiss delivery status"
                >
                  <XCircle className="h-5 w-5" />
                </button>
              </div>
              {showQuoteEmailRefreshButton ? (
                <div className="flex w-full pl-8 sm:pl-[2.75rem]">
                  <button
                    type="button"
                    onClick={() => void refreshQuoteEmailDelivery()}
                    disabled={emailDeliveryRefreshing}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50 disabled:opacity-50"
                  >
                    {emailDeliveryRefreshing ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                    ) : (
                      <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    Refresh status
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {step === 0 && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Person Name (optional)</label>
                <input
                  type="text"
                  value={personName}
                  onChange={(e) => setPersonName(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Age</label>
                <input
                  type="number"
                  min={0}
                  max={120}
                  value={age}
                  onChange={(e) => setAge(Number(e.target.value))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Tobacco Use</label>
                <select
                  value={tobaccoUse}
                  onChange={(e) => setTobaccoUse(e.target.value as TobaccoUse)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                >
                  <option value="N">No</option>
                  <option value="Y">Yes</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Tier</label>
                <select
                  value={tier}
                  onChange={(e) => setTier(e.target.value as TierType)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                >
                  <option value="EE">EE - Employee Only</option>
                  <option value="ES">ES - Employee + Spouse</option>
                  <option value="EC">EC - Employee + Child</option>
                  <option value="EF">EF - Employee + Family</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Payment Method</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                >
                  <option value="ACH">ACH</option>
                  <option value="Card">Card</option>
                </select>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div className="flex border-b border-gray-200 -mb-px gap-1">
                <button
                  type="button"
                  onClick={() => handleAudienceTabChange('individual')}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    audienceTab === 'individual'
                      ? 'border-[var(--oe-primary)] text-gray-900'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                  style={audienceTab === 'individual' ? { borderBottomColor: 'var(--oe-primary)' } : undefined}
                >
                  Individual
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    audienceTab === 'individual' ? 'bg-[var(--oe-primary)]/10 text-[var(--oe-primary)]' : 'bg-gray-100 text-gray-600'
                  }`} style={audienceTab === 'individual' ? { backgroundColor: 'rgba(31, 141, 191, 0.1)', color: 'var(--oe-primary)' } : undefined}>
                    {individualCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleAudienceTabChange('group')}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    audienceTab === 'group'
                      ? 'border-[var(--oe-primary)] text-gray-900'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                  }`}
                  style={audienceTab === 'group' ? { borderBottomColor: 'var(--oe-primary)' } : undefined}
                >
                  Group
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    audienceTab === 'group' ? 'bg-[var(--oe-primary)]/10 text-[var(--oe-primary)]' : 'bg-gray-100 text-gray-600'
                  }`} style={audienceTab === 'group' ? { backgroundColor: 'rgba(31, 141, 191, 0.1)', color: 'var(--oe-primary)' } : undefined}>
                    {groupCount}
                  </span>
                </button>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="Search products..."
                  className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="max-h-[45vh] space-y-3 overflow-y-auto rounded-lg border border-gray-200 p-3">
                {filteredProducts.map((product) => {
                  const selected = selectedProductIds.includes(product.productId);
                  const configOptions = configOptionsByProductId[product.productId];
                  const bundleProductNames = (product.bundleProducts || [])
                    .map((p) => String(p?.name || p?.productName || '').trim())
                    .filter(Boolean);
                  return (
                    <div key={product.productId} className="rounded-lg border border-gray-200 p-3">
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => void toggleProduct(product.productId)}
                          className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-gray-900">{product.productName}</p>
                            {product.isBundle ? (
                              <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                                Bundle
                              </span>
                            ) : null}
                          </div>
                          {product.isBundle && bundleProductNames.length > 0 ? (
                            <p className="text-xs text-gray-600">
                              Includes: {bundleProductNames.join(', ')}
                            </p>
                          ) : null}
                        </div>
                        {pricingLoadingByProductId[product.productId] && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
                      </label>

                      {selected && configOptions && configOptions.length > 0 && (
                        <div className="mt-3 rounded-lg bg-gray-50 p-3">
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {configOptions.map((option) => (
                              <div key={`${product.productId}-${option.key}`}>
                                <label className="mb-1 block text-xs font-medium text-gray-700">{option.label}</label>
                                <div className="max-h-32 space-y-1 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2">
                                  {option.values.map((value) => {
                                    const selectedValues = selectedConfigsByProductId[product.productId]?.[option.key] || [];
                                    const checked = selectedValues.includes(value);
                                    return (
                                      <label key={value} className="flex items-center gap-2 text-sm text-gray-700">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={(e) => {
                                            const isChecked = e.target.checked;
                                            setSelectedConfigsByProductId((prev) => {
                                              const currentProduct = prev[product.productId] || {};
                                              const currentValues = currentProduct[option.key] || [];
                                              const nextValues = isChecked
                                                ? Array.from(new Set([...currentValues, value]))
                                                : currentValues.filter((v) => v !== value);
                                              return {
                                                ...prev,
                                                [product.productId]: {
                                                  ...currentProduct,
                                                  [option.key]: nextValues
                                                }
                                              };
                                            });
                                          }}
                                          className="h-4 w-4 rounded border-gray-300 text-blue-600"
                                        />
                                        <span>{value}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {calculateError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{calculateError}</div>
              ) : null}
            </div>
          )}

          {step === 2 && quoteResult && (
            <div className="space-y-4">
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                <p className="text-sm text-blue-900">
                  Audience {audienceTab === 'individual' ? 'Individual' : 'Group'} •
                  {' '}
                  {quoteResult.criteria.personName ? `Name ${quoteResult.criteria.personName} • ` : ''}
                  Criteria: Age {quoteResult.criteria.age}, Tobacco {quoteResult.criteria.tobaccoUse}, Tier {quoteResult.criteria.tier}, Payment{' '}
                  {quoteResult.criteria.paymentMethod}
                </p>
              </div>

              <div className="rounded-lg border border-gray-200">
                <div className="border-b border-gray-200 p-4">
                  <h3 className="text-base font-semibold text-gray-900">Premium Breakdown</h3>
                </div>
                <div className="divide-y divide-gray-200">
                  {/* Split by product: each product lists its own unshared-amount options,
                      each showing its Total (and a Fees line when the product carries
                      separate fees), sourced from the pricing authority. No base premium,
                      no cross-product combined total. */}
                  {groupBreakdownByProduct(quoteResult.breakdown).map((group) => (
                    <div key={group.productId}>
                      <div className="bg-gray-50 px-4 py-2 text-sm font-semibold text-gray-900">{group.productName}</div>
                      <div className="divide-y divide-gray-100">
                        {group.items.map((item, idx) => {
                          const configText = item.selectedConfigDetails && item.selectedConfigDetails.length > 0
                            ? item.selectedConfigDetails.map((d) => `${d.label || 'Plan'}: ${d.value}`).join(', ')
                            : (item.selectedConfigValues && Object.keys(item.selectedConfigValues).length > 0
                              ? Object.values(item.selectedConfigValues).map((v) => `Plan: ${v}`).join(', ')
                              : '');
                          const optionTotals = item.optionTotals;
                          return (
                            <div key={item.quoteItemId || `${item.productId}-${idx}`} className="px-4 py-3">
                              {configText ? <p className="text-sm text-gray-900">{configText}</p> : null}
                              {optionTotals ? (
                                <QuickQuoteTotalsSummary totals={optionTotals} />
                              ) : (
                                <div className="mt-1 flex items-center justify-between text-sm font-semibold text-gray-900">
                                  <span>Total</span>
                                  <span className="tabular-nums">{currency(item.premiumWithIncludedFee)}</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border border-gray-200">
                <div className="flex items-center justify-between border-b border-gray-200 p-4">
                  <h3 className="text-base font-semibold text-gray-900">Product Documents</h3>
                  <button
                    type="button"
                    onClick={() => void handleDownloadAllDocuments()}
                    disabled={selectedQuoteDocuments.length === 0 || downloadingAllDocs || resolvingDocs}
                    className="inline-flex items-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {downloadingAllDocs ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                    Download All
                  </button>
                </div>
                <div className="p-4">
                  {resolvingDocs ? (
                    <div className="flex items-center text-sm text-gray-600">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Preparing document links...
                    </div>
                  ) : selectedQuoteDocuments.length === 0 ? (
                    <p className="text-sm text-gray-600">No product documents available for selected products.</p>
                  ) : (
                    <div className="space-y-2">
                      {selectedQuoteDocuments.map((docItem) => {
                        const openUrl = resolvedDocUrlsById[docItem.id] || docItem.documentUrl;
                        return (
                          <div key={docItem.id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 p-3">
                            <div className="min-w-0 pr-3">
                              <p className="truncate text-sm font-medium text-gray-900">{docItem.productName}</p>
                              <p className="truncate text-xs text-gray-600">{docItem.displayName}</p>
                            </div>
                            <a
                              href={openUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex shrink-0 items-center rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50"
                            >
                              <FileText className="mr-1.5 h-4 w-4" />
                              Open
                              <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-200 p-6">
          <button
            onClick={step === 0 ? closeWizard : goBack}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            disabled={calculating}
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>
          {step < 2 ? (
            <button
              onClick={() => void goNext()}
              disabled={!canContinue()}
              className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {calculating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              {step === 1 ? 'Calculate Quote' : 'Next'}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  if (!sendRecipientName && personName) setSendRecipientName(personName);
                  setSendSuccessFeedback(null);
                  setEmailProductDocAttachments({});
                  setShowSendQuoteModal(true);
                }}
                className="inline-flex items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <Sparkles className="mr-2 h-4 w-4" />
                Send Quote
              </button>
              <button
                onClick={closeWizard}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          )}
        </div>
      </div>
      {showSendQuoteModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black bg-opacity-50 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 p-5">
              <h3 className="text-lg font-semibold text-gray-900">Send quote</h3>
              <button
                type="button"
                onClick={() => setShowSendQuoteModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                <XCircle className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-4 p-5">
              <p className="text-sm text-gray-600">
                We generate a PDF and upload it so you can email or text a link. Recipients can reply to you using the
                reply-to address shown below. Email uses your tenant mail service with real PDF attachments (your
                browser cannot attach files via mailto).
              </p>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Recipient name (optional)</label>
                <input
                  type="text"
                  value={sendRecipientName}
                  onChange={(e) => setSendRecipientName(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex rounded-lg border border-gray-200 p-1">
                <button
                  type="button"
                  onClick={() => setSendChannel('email')}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                    sendChannel === 'email'
                      ? 'bg-[var(--oe-primary)] text-white'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <Mail className="h-4 w-4" />
                  Email
                </button>
                <button
                  type="button"
                  onClick={() => setSendChannel('sms')}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium ${
                    sendChannel === 'sms'
                      ? 'bg-[var(--oe-primary)] text-white'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <MessageSquare className="h-4 w-4" />
                  SMS
                </button>
              </div>

              {prepareLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Generating quote PDF and upload link…
                </div>
              ) : null}

              {prepareError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{prepareError}</div>
              ) : null}

              {prepareMeta && !prepareLoading ? (
                <div className="space-y-3">
                  <OutboundEmailSenderNotice
                    fromDisplayName={prepareMeta.fromDisplayName}
                    fromEmail={prepareMeta.fromEmail}
                    replyToName={prepareMeta.replyToName}
                    replyToEmail={prepareMeta.replyToEmail}
                  />
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Quote link</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <a
                        href={prepareMeta.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-[var(--oe-primary)] hover:underline"
                      >
                        Open quote PDF
                      </a>
                      <button
                        type="button"
                        onClick={() => void copyDocumentLink()}
                        className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        <Copy className="mr-1 h-3.5 w-3.5" />
                        {copyLinkFeedback ? 'Copied' : 'Copy link'}
                      </button>
                    </div>
                  </div>
                  </div>
                </div>
              ) : null}

              {sendChannel === 'email' && prepareMeta && !prepareLoading ? (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Recipient email</label>
                    <input
                      type="email"
                      value={sendRecipientEmail}
                      onChange={(e) => setSendRecipientEmail(e.target.value)}
                      placeholder="name@example.com"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Subject</label>
                    <input
                      type="text"
                      value={emailSubject}
                      onChange={(e) => setEmailSubject(e.target.value)}
                      placeholder={prepareMeta.defaultSubject}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Default is filled for you; change it anytime before sending. If you clear the field, the default is used.
                    </p>
                  </div>
                  <div>
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <label className="block text-sm font-medium text-gray-700">Attachments (PDF)</label>
                      {selectedQuoteDocuments.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={selectAllProductDocsForEmail}
                            disabled={resolvingDocs}
                            className="text-xs font-medium text-[var(--oe-primary)] hover:underline disabled:opacity-50"
                          >
                            Select all product docs
                          </button>
                          <button
                            type="button"
                            onClick={clearProductDocsForEmail}
                            className="text-xs font-medium text-gray-600 hover:underline"
                          >
                            Clear product docs
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <div className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <label className="flex cursor-default items-start gap-2 text-sm text-gray-800">
                        <input
                          type="checkbox"
                          checked
                          disabled
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[var(--oe-primary)]"
                          aria-label="Premium quote PDF always attached"
                        />
                        <span>
                          <span className="font-medium">Premium quote</span>
                          <span className="text-gray-500"> — always included (quick-quote.pdf)</span>
                        </span>
                      </label>
                      {selectedQuoteDocuments.length === 0 ? (
                        <p className="text-xs text-gray-500">No product-specific documents on this quote.</p>
                      ) : (
                        selectedQuoteDocuments.map((docItem) => {
                          const url = resolvedDocUrlsById[docItem.id] || docItem.documentUrl;
                          const ready = isAbsoluteHttpUrl(url);
                          return (
                            <label
                              key={docItem.id}
                              className={`flex items-start gap-2 text-sm ${ready ? 'cursor-pointer text-gray-800' : 'cursor-not-allowed text-gray-500'}`}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(emailProductDocAttachments[docItem.id])}
                                disabled={!ready || resolvingDocs}
                                onChange={(e) =>
                                  setEmailProductDocAttachments((prev) => ({
                                    ...prev,
                                    [docItem.id]: e.target.checked
                                  }))
                                }
                                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-[var(--oe-primary)]"
                              />
                              <span>
                                <span className="font-medium">{docItem.productName}</span>
                                <span className="text-gray-600"> — {docItem.displayName}</span>
                                {!ready ? (
                                  <span className="ml-1 text-xs text-amber-700">(loading URL…)</span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                    <p className="mt-1 text-xs text-gray-500">
                      Selected files are downloaded server-side and attached to the email (up to 25 MB total). SMS still
                      sends a link only.
                    </p>
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Message</label>
                    <textarea
                      value={emailBody}
                      onChange={(e) => setEmailBody(e.target.value)}
                      rows={10}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Your text appears in the email body. When your account email is different from the recipient, you
                      are CC’d so you get a copy ({prepareMeta.replyToEmail || 'your profile email'}).
                    </p>
                  </div>
                </div>
              ) : null}

              {sendChannel === 'sms' && prepareMeta && !prepareLoading ? (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Recipient phone</label>
                    <input
                      type="tel"
                      value={sendRecipientPhone}
                      onChange={(e) => setSendRecipientPhone(e.target.value)}
                      placeholder="+1…"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium text-gray-700">Message</label>
                    <textarea
                      value={smsBody}
                      onChange={(e) => setSmsBody(e.target.value)}
                      rows={5}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      When you send this SMS, your message goes first, then a blank line, then &quot;View quote:&quot; and the PDF link on its own line. The link is not shown in this box.
                    </p>
                  </div>
                </div>
              ) : null}

              {sendQuoteError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{sendQuoteError}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 p-5">
              <button
                type="button"
                onClick={() => setShowSendQuoteModal(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                disabled={downloadingPdf || sendingEmail || sendingSms}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadQuotePdf()}
                className="inline-flex items-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                disabled={downloadingPdf || sendingEmail || sendingSms || !quoteResult}
              >
                {downloadingPdf ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Download PDF only
              </button>
              {sendChannel === 'email' ? (
                <button
                  type="button"
                  onClick={() => void handleSendQuickQuoteEmail()}
                  className="inline-flex items-center rounded-lg bg-[var(--oe-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--oe-dark)] disabled:opacity-50"
                  disabled={
                    sendingEmail ||
                    sendingSms ||
                    prepareLoading ||
                    !prepareMeta ||
                    !sendRecipientEmail.trim()
                  }
                >
                  {sendingEmail ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
                  Send email
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleSendQuickQuoteSms()}
                  className="inline-flex items-center rounded-lg bg-[var(--oe-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--oe-dark)] disabled:opacity-50"
                  disabled={
                    sendingSms ||
                    sendingEmail ||
                    prepareLoading ||
                    !prepareMeta ||
                    !sendRecipientPhone.trim()
                  }
                >
                  {sendingSms ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <MessageSquare className="mr-2 h-4 w-4" />}
                  Send SMS
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default QuickQuoteWizardModal;
