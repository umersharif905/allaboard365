import { ChevronDown, ChevronRight, Code, Copy, CreditCard, Eye, FileText, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import IDCard from '../../IDCard';
import SearchableDropdown from '../../common/SearchableDropdown';
import { apiService } from '../../../services/api.service';
import {
  ID_CARD_HEADER_IMAGE_PLACEMENTS,
  normalizeHeaderImagePlacement,
  type IdCardHeaderImagePlacement,
} from '../../../utils/idCardHeaderImagePlacement';

interface IDCardData {
  DisableIDCard?: boolean;
  Card_Front: {
    Header: {
      Image: string;
      ImagePlacement?: IdCardHeaderImagePlacement;
      HeaderText?: string;
    };
    Footer: {
      Header: string;
      Text1: string;
      Text2: string;
    };
  };
  Card_Back: {
    Top_Left: CardSection;
    Top_Right: CardSection;
    Middle: CardSection;
    Bottom_Left: CardSection;
    Bottom_Right: CardSection;
  };
  NetworkVariations?: Record<string, IDCardData>;
}

interface CardSection {
  Image: string;
  Header: string;
  Text1: string;
  Link_Name1: string;
  URL1: string;
  Link_Name2: string;
  URL2: string;
}

interface VendorNetwork {
  vendorNetworkId: string;
  vendorId: string;
  title: string;
  isDefault: boolean;
}

import { ProductFormData, productUsesVendorGroupId, ConfigurationField } from '../../../types/sysadmin/addproductswizard.types';

interface StepProps {
  formData: ProductFormData;
  updateFormData: (data: Partial<ProductFormData>) => void;
  existingMediaUrls?: {
    productImageUrl: string;
    productLogoUrl: string;
    productDocumentUrl: string;
  };
}

const defaultIDCardData: IDCardData = {
  DisableIDCard: false,
  Card_Front: {
    Header: {
      Image: ""
    },
    Footer: {
      Header: "Contact Information",
      Text1: "For Eligibility, Benefits & Customer Service",
      Text2: "(904) 373-6872"
    }
  },
  Card_Back: {
    Top_Left: {
      Image: "",
      Header: "ER Visits",
      Text1: "Request an Itemized Bill\n(Submit Sharing Request)",
      Link_Name1: "",
      URL1: "",
      Link_Name2: "",
      URL2: ""
    },
    Top_Right: {
      Image: "",
      Header: "Planned Healthcare",
      Text1: "Contact Member Success\nfor Payment Services",
      Link_Name1: "",
      URL1: "",
      Link_Name2: "",
      URL2: ""
    },
    Middle: {
      Image: "",
      Header: "Contact ShareWELL Partners",
      Text1: "Member Success Phone (904) 373-6872\nHow to Submit a Share Request",
      Link_Name1: "How to Submit a Share Request",
      URL1: "https://sharewellpartners.com/sharingrequest/",
      Link_Name2: "",
      URL2: ""
    },
    Bottom_Left: {
      Image: "",
      Header: "Member Success Email",
      Text1: "",
      Link_Name1: "membersuccess@sharewellpartners.com",
      URL1: "mailto:membersuccess@sharewellpartners.com",
      Link_Name2: "",
      URL2: ""
    },
    Bottom_Right: {
      Image: "",
      Header: "",
      Text1: "",
      Link_Name1: "",
      URL1: "",
      Link_Name2: "",
      URL2: ""
    }
  }
};

const CARD_BACK_SECTION_KEYS = ['Top_Left', 'Top_Right', 'Middle', 'Bottom_Left', 'Bottom_Right'] as const;
type CardBackSections = (typeof CARD_BACK_SECTION_KEYS)[number];

const DEFAULT_COPY_KEY = '__default__';

function normalizeCardData(parsed: any, base: IDCardData = defaultIDCardData): IDCardData | null {
  if (!parsed?.Card_Front?.Header || !parsed.Card_Back) return null;
  return {
    DisableIDCard: parsed?.DisableIDCard === true,
    Card_Front: {
      ...base.Card_Front,
      ...parsed.Card_Front,
      Header: { ...base.Card_Front.Header, ...parsed.Card_Front?.Header }
    },
    Card_Back: {
      Top_Left: { ...base.Card_Back.Top_Left, ...parsed.Card_Back?.Top_Left },
      Top_Right: { ...base.Card_Back.Top_Right, ...parsed.Card_Back?.Top_Right },
      Middle: { ...base.Card_Back.Middle, ...parsed.Card_Back?.Middle },
      Bottom_Left: { ...base.Card_Back.Bottom_Left, ...parsed.Card_Back?.Bottom_Left },
      Bottom_Right: { ...base.Card_Back.Bottom_Right, ...parsed.Card_Back?.Bottom_Right }
    }
  };
}

// Strip the variations key for display/editing of one card
function withoutVariations(card: IDCardData | undefined): IDCardData {
  if (!card) return JSON.parse(JSON.stringify(defaultIDCardData));
  const { NetworkVariations: _omit, ...rest } = card as any;
  return rest as IDCardData;
}

// Deep clone the default (no variations) for use when adding/syncing a variation
function cloneDefaultForVariation(idCardData: IDCardData): IDCardData {
  return JSON.parse(JSON.stringify(withoutVariations(idCardData)));
}

/** Preview only: replace {{ConfigValue1}} with demo value; otherwise return display metadata for Member Details (matches member API hydration). */
function buildStep7PreviewIdCardState(
  idCardData: IDCardData,
  configurationFields: ConfigurationField[] | undefined,
  disableCard: boolean
): { cardData: IDCardData; idCardConfigurationDisplay: { label: string; value: string } | null } {
  if (disableCard || !idCardData || typeof idCardData !== 'object') {
    return { cardData: idCardData, idCardConfigurationDisplay: null };
  }
  if (!configurationFields || !Array.isArray(configurationFields) || configurationFields.length === 0) {
    return { cardData: idCardData, idCardConfigurationDisplay: null };
  }
  const first = configurationFields[0];
  if (!first?.fieldName) {
    return { cardData: idCardData, idCardConfigurationDisplay: null };
  }
  const fieldName = String(first.fieldName);
  const opts = first.fieldOptions;
  const demoValue =
    Array.isArray(opts) && opts.length > 0 && String(opts[0]).trim() !== ''
      ? String(opts[0]).trim()
      : '6000';

  const CONFIG_TOKEN_REPLACE = /\{\{\s*ConfigValue1\s*\}\}/gi;
  const CONFIG_TOKEN_TEST = /\{\{\s*ConfigValue1\s*\}\}/i;

  const deepReplaceTokens = (obj: unknown): boolean => {
    if (!obj || typeof obj !== 'object') return false;
    let any = false;
    for (const key of Object.keys(obj as object)) {
      const v = (obj as Record<string, unknown>)[key];
      if (typeof v === 'string' && CONFIG_TOKEN_TEST.test(v)) {
        (obj as Record<string, string>)[key] = v.replace(CONFIG_TOKEN_REPLACE, demoValue);
        any = true;
      } else if (v && typeof v === 'object') {
        any = deepReplaceTokens(v) || any;
      }
    }
    return any;
  };

  if (CONFIG_TOKEN_TEST.test(JSON.stringify(idCardData))) {
    const cloned = JSON.parse(JSON.stringify(idCardData)) as IDCardData;
    const replacedToken = deepReplaceTokens(cloned);
    return {
      cardData: cloned,
      idCardConfigurationDisplay: replacedToken ? null : { label: fieldName, value: demoValue }
    };
  }

  return {
    cardData: idCardData,
    idCardConfigurationDisplay: { label: fieldName, value: demoValue }
  };
}

export default function Step7IDCard({ formData, updateFormData }: StepProps) {
  const usesVendorGroupId = productUsesVendorGroupId(formData.vendorGroupIdProductType);

  useEffect(() => {
    if (!usesVendorGroupId && formData.showGroupIdOnIDCard) {
      updateFormData({ showGroupIdOnIDCard: false });
    }
  }, [usesVendorGroupId, formData.showGroupIdOnIDCard, updateFormData]);

  const [activeTab, setActiveTab] = useState<'front' | 'back'>('front');
  const [viewMode, setViewMode] = useState<'visual' | 'json' | 'preview'>('visual');
  const [showAdvancedIdCardSettings, setShowAdvancedIdCardSettings] = useState(false);

  // Networks
  const [vendorNetworks, setVendorNetworks] = useState<VendorNetwork[]>([]);
  // null = editing the default; otherwise a vendorNetworkId
  const [activeNetworkId, setActiveNetworkId] = useState<string | null>(null);
  const [showAddVariationPicker, setShowAddVariationPicker] = useState(false);

  // Copy from another product modal
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState('');
  const [productOptions, setProductOptions] = useState<{ id: string; label: string; value: string }[]>([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [copyLoading, setCopyLoading] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<{
    default: IDCardData | null;
    variations: { sourceNetworkId: string; title: string; isDefault: boolean; matchedTargetNetworkId: string | null; data: IDCardData }[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [selectedCopyKeys, setSelectedCopyKeys] = useState<Set<string>>(new Set());

  // Blob URLs are tracked per (variationKey, section). 'default' = null active variation.
  const [logoBlobUrls, setLogoBlobUrls] = useState<Record<string, string | null>>({});
  const [cardBackBlobUrls, setCardBackBlobUrls] = useState<Record<string, Record<CardBackSections, string | null>>>({});

  const variationKey = activeNetworkId ?? 'default';

  // ----- Active card data accessors -----
  const activeCardData: IDCardData = useMemo(() => {
    if (!activeNetworkId) {
      return withoutVariations(formData.idCardData as IDCardData);
    }
    const variation = (formData.idCardData as IDCardData).NetworkVariations?.[activeNetworkId];
    return variation ? withoutVariations(variation) : cloneDefaultForVariation(formData.idCardData as IDCardData);
  }, [formData.idCardData, activeNetworkId]);

  const setActiveCardData = useCallback((updater: (prev: IDCardData) => IDCardData) => {
    const fullData = (formData.idCardData ?? cloneDefaultForVariation(defaultIDCardData)) as IDCardData;
    if (!activeNetworkId) {
      const next = updater(withoutVariations(fullData));
      updateFormData({
        idCardData: {
          ...next,
          NetworkVariations: fullData.NetworkVariations
        } as ProductFormData['idCardData']
      });
    } else {
      const currentVariation = fullData.NetworkVariations?.[activeNetworkId] ?? cloneDefaultForVariation(fullData);
      const nextVariation = updater(withoutVariations(currentVariation));
      const nextVariations = {
        ...(fullData.NetworkVariations ?? {}),
        [activeNetworkId]: nextVariation
      };
      updateFormData({
        idCardData: {
          ...withoutVariations(fullData),
          NetworkVariations: nextVariations
        } as ProductFormData['idCardData']
      });
    }
  }, [formData.idCardData, activeNetworkId, updateFormData]);

  // Pending-file accessors keyed by current variation
  const activeLogoFile: File | null | undefined = useMemo(() => {
    if (!activeNetworkId) return formData.idCardLogoFile ?? null;
    return formData.idCardLogoFileByNetwork?.[activeNetworkId] ?? null;
  }, [activeNetworkId, formData.idCardLogoFile, formData.idCardLogoFileByNetwork]);

  const activeBackFiles = useMemo(() => {
    if (!activeNetworkId) return formData.idCardBackImageFiles ?? {};
    return formData.idCardBackImageFilesByNetwork?.[activeNetworkId] ?? {};
  }, [activeNetworkId, formData.idCardBackImageFiles, formData.idCardBackImageFilesByNetwork]);

  const setActiveLogoFile = useCallback((file: File | null) => {
    if (!activeNetworkId) {
      updateFormData({ idCardLogoFile: file });
      return;
    }
    const next = { ...(formData.idCardLogoFileByNetwork ?? {}) };
    next[activeNetworkId] = file;
    updateFormData({ idCardLogoFileByNetwork: next });
  }, [activeNetworkId, formData.idCardLogoFileByNetwork, updateFormData]);

  const setActiveBackFiles = useCallback((updater: (prev: any) => any) => {
    if (!activeNetworkId) {
      const next = updater(formData.idCardBackImageFiles ?? {});
      updateFormData({ idCardBackImageFiles: next });
      return;
    }
    const allByNetwork = { ...(formData.idCardBackImageFilesByNetwork ?? {}) };
    const next = updater(allByNetwork[activeNetworkId] ?? {});
    allByNetwork[activeNetworkId] = next;
    updateFormData({ idCardBackImageFilesByNetwork: allByNetwork });
  }, [activeNetworkId, formData.idCardBackImageFiles, formData.idCardBackImageFilesByNetwork, updateFormData]);

  const currentLogoBlobUrl = logoBlobUrls[variationKey] ?? null;
  const currentCardBackBlobUrls: Record<CardBackSections, string | null> = useMemo(() => {
    return cardBackBlobUrls[variationKey] ?? {
      Top_Left: null, Top_Right: null, Middle: null, Bottom_Left: null, Bottom_Right: null
    };
  }, [cardBackBlobUrls, variationKey]);

  // ---- Initialization & blob URL bookkeeping ----
  useEffect(() => {
    if (!formData.idCardData || Object.keys(formData.idCardData).length === 0) {
      updateFormData({ idCardData: JSON.parse(JSON.stringify(defaultIDCardData)) });
    } else if (formData.idCardData.DisableIDCard === undefined) {
      updateFormData({ idCardData: { ...formData.idCardData, DisableIDCard: false } });
    }
  }, []);

  // Fetch vendor networks when we know the vendor
  useEffect(() => {
    if (!formData.vendorId) {
      setVendorNetworks([]);
      return;
    }
    apiService
      .get<{ success: boolean; data: VendorNetwork[] }>(`/api/vendors/${formData.vendorId}/networks`)
      .then((res) => setVendorNetworks(res?.data ?? []))
      .catch(() => setVendorNetworks([]));
  }, [formData.vendorId]);

  // Recreate logo blob URL if file is in formData but no blob URL exists for this variation
  useEffect(() => {
    if (activeLogoFile instanceof File && !currentLogoBlobUrl) {
      const blobUrl = URL.createObjectURL(activeLogoFile);
      setLogoBlobUrls((prev) => ({ ...prev, [variationKey]: blobUrl }));
    } else if (!activeLogoFile && currentLogoBlobUrl) {
      URL.revokeObjectURL(currentLogoBlobUrl);
      setLogoBlobUrls((prev) => ({ ...prev, [variationKey]: null }));
    }
  }, [activeLogoFile, currentLogoBlobUrl, variationKey]);

  // Sync card-back blob URLs for current variation when files map changes
  useEffect(() => {
    let changed = false;
    const next: Record<CardBackSections, string | null> = { ...currentCardBackBlobUrls };
    CARD_BACK_SECTION_KEYS.forEach((section) => {
      const file = (activeBackFiles as any)[section];
      if (file instanceof File) {
        if (!next[section]) {
          next[section] = URL.createObjectURL(file);
          changed = true;
        }
      } else if (next[section]) {
        URL.revokeObjectURL(next[section]!);
        next[section] = null;
        changed = true;
      }
    });
    if (changed) setCardBackBlobUrls((prev) => ({ ...prev, [variationKey]: next }));
  }, [activeBackFiles, variationKey]);

  // Cleanup all blob URLs on unmount
  useEffect(() => {
    return () => {
      Object.values(logoBlobUrls).forEach((url) => { if (url) URL.revokeObjectURL(url); });
      Object.values(cardBackBlobUrls).forEach((map) => {
        Object.values(map).forEach((url) => { if (url) URL.revokeObjectURL(url); });
      });
    };
  }, [logoBlobUrls, cardBackBlobUrls]);

  useEffect(() => {
    const t = formData.idCardMemberIdPrefixMask?.trim();
    if (t) setShowAdvancedIdCardSettings(true);
    if (formData.idCardData?.DisableIDCard === true) setShowAdvancedIdCardSettings(true);
  }, [formData.idCardMemberIdPrefixMask, formData.idCardData?.DisableIDCard]);

  // Fetch products (non-bundle) when copy modal opens
  useEffect(() => {
    if (!showCopyModal) return;
    setCopyError(null);
    setSelectedProductId('');
    setSourcePreview(null);
    setSelectedCopyKeys(new Set());
    setProductsLoading(true);
    apiService.get<{ success: boolean; products: { ProductId: string; Name: string; IsBundle?: boolean }[] }>('/api/products')
      .then(res => {
        const list = res?.products ?? [];
        const nonBundle = list.filter((p) => !p.IsBundle);
        setProductOptions(nonBundle.map((p) => ({ id: p.ProductId, label: p.Name, value: p.ProductId })));
      })
      .catch(() => setProductOptions([]))
      .finally(() => setProductsLoading(false));
  }, [showCopyModal]);

  // Load source product's ID card config (default + variations) when one is selected
  useEffect(() => {
    if (!showCopyModal || !selectedProductId) {
      setSourcePreview(null);
      setSelectedCopyKeys(new Set());
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setCopyError(null);
    (async () => {
      try {
        const data = await apiService.get<{ product?: any; data?: any; IDCardData?: any }>(`/api/products/${selectedProductId}`);
        const product = data?.product ?? data?.data ?? data;
        const rawIdCard = product?.IDCardData;
        if (!rawIdCard) {
          if (!cancelled) {
            setSourcePreview({ default: null, variations: [] });
            setCopyError('Selected product has no ID card configuration.');
          }
          return;
        }
        const parsed = typeof rawIdCard === 'string' ? JSON.parse(rawIdCard) : rawIdCard;
        const def = normalizeCardData(parsed);
        if (!def) {
          if (!cancelled) {
            setSourcePreview({ default: null, variations: [] });
            setCopyError('Selected product ID card format is invalid.');
          }
          return;
        }
        const sourceVendorId = product?.VendorId ?? product?.vendorId;
        let sourceNetworks: VendorNetwork[] = [];
        if (sourceVendorId) {
          try {
            const r = await apiService.get<{ success: boolean; data: VendorNetwork[] }>(`/api/vendors/${sourceVendorId}/networks`);
            sourceNetworks = r?.data ?? [];
          } catch { /* ignore */ }
        }
        const targetByTitle = new Map<string, string>();
        vendorNetworks.forEach((n) => targetByTitle.set(n.title.trim().toLowerCase(), n.vendorNetworkId));
        const rawVariations = (parsed?.NetworkVariations && typeof parsed.NetworkVariations === 'object')
          ? (parsed.NetworkVariations as Record<string, any>)
          : {};
        const variations = Object.entries(rawVariations).map(([id, v]) => {
          const merged = normalizeCardData(v, def) ?? def;
          const found = sourceNetworks.find((n) => n.vendorNetworkId === id);
          const title = found?.title ?? id;
          const matched = targetByTitle.get(title.trim().toLowerCase()) ?? null;
          return { sourceNetworkId: id, title, isDefault: !!found?.isDefault, matchedTargetNetworkId: matched, data: merged };
        });
        if (cancelled) return;
        setSourcePreview({ default: def, variations });
        const allKeys = new Set<string>([DEFAULT_COPY_KEY, ...variations.map((v) => v.sourceNetworkId)]);
        setSelectedCopyKeys(allKeys);
      } catch (e: any) {
        if (!cancelled) setCopyError(e?.message || 'Failed to load product.');
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedProductId, showCopyModal, vendorNetworks]);

  const fetchImageAsFile = useCallback(async (url: string, defaultName: string): Promise<File | null> => {
    if (!url || url.startsWith('blob:')) return null;
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) return null;
      const blob = await r.blob();
      const ext = (url.split('.').pop()?.split('?')[0]) || 'png';
      return new File([blob], defaultName.replace(/\s/g, '-') + '.' + ext, { type: blob.type || 'image/png' });
    } catch {
      return null;
    }
  }, []);

  const fetchVariationFiles = useCallback(async (cardData: IDCardData) => {
    const frontImageUrl = cardData.Card_Front?.Header?.Image;
    const idCardLogoFile = frontImageUrl ? await fetchImageAsFile(frontImageUrl, 'id-card-logo') : null;
    const idCardBackImageFiles: Record<string, File | null> = {};
    for (const section of CARD_BACK_SECTION_KEYS) {
      const imgUrl = cardData.Card_Back[section]?.Image;
      if (imgUrl) {
        const file = await fetchImageAsFile(imgUrl, `card-back-${section}`);
        if (file) idCardBackImageFiles[section] = file;
      }
    }
    return { idCardLogoFile, idCardBackImageFiles };
  }, [fetchImageAsFile]);

  const handleCopyFromProductConfirm = useCallback(async () => {
    if (!selectedProductId || !sourcePreview) return;
    if (selectedCopyKeys.size === 0) {
      setCopyError('Select at least one card to copy.');
      return;
    }
    setCopyLoading(true);
    setCopyError(null);
    try {
      const fullData = (formData.idCardData ?? cloneDefaultForVariation(defaultIDCardData)) as IDCardData;
      const existingDefault = withoutVariations(fullData);
      const existingVariations: Record<string, IDCardData> = { ...(fullData.NetworkVariations ?? {}) };
      const existingLogoByNetwork: Record<string, File | null> = { ...(formData.idCardLogoFileByNetwork ?? {}) };
      const existingBackByNetwork: Record<string, Record<string, File | null>> = { ...(formData.idCardBackImageFilesByNetwork ?? {}) } as Record<string, Record<string, File | null>>;

      const updates: Partial<ProductFormData> = {};
      let nextDefault: IDCardData = existingDefault;

      if (selectedCopyKeys.has(DEFAULT_COPY_KEY) && sourcePreview.default) {
        nextDefault = sourcePreview.default;
        const { idCardLogoFile, idCardBackImageFiles } = await fetchVariationFiles(nextDefault);
        updates.idCardLogoFile = idCardLogoFile ?? undefined;
        updates.idCardBackImageFiles = idCardBackImageFiles as ProductFormData['idCardBackImageFiles'];
      }

      for (const v of sourcePreview.variations) {
        if (!selectedCopyKeys.has(v.sourceNetworkId)) continue;
        const targetKey = v.matchedTargetNetworkId ?? v.sourceNetworkId;
        existingVariations[targetKey] = v.data;
        const { idCardLogoFile, idCardBackImageFiles } = await fetchVariationFiles(v.data);
        existingLogoByNetwork[targetKey] = idCardLogoFile;
        existingBackByNetwork[targetKey] = idCardBackImageFiles;
      }

      updates.idCardData = { ...nextDefault, NetworkVariations: existingVariations } as ProductFormData['idCardData'];
      updates.idCardLogoFileByNetwork = existingLogoByNetwork;
      updates.idCardBackImageFilesByNetwork = existingBackByNetwork as ProductFormData['idCardBackImageFilesByNetwork'];

      updateFormData(updates);
      setActiveNetworkId(null);
      setShowCopyModal(false);
    } catch (e: any) {
      setCopyError(e?.message || 'Failed to copy ID card configuration.');
    } finally {
      setCopyLoading(false);
    }
  }, [selectedProductId, sourcePreview, selectedCopyKeys, updateFormData, fetchVariationFiles, formData.idCardData, formData.idCardLogoFileByNetwork, formData.idCardBackImageFilesByNetwork]);

  const currentLogoUrl = activeCardData?.Card_Front?.Header?.Image || '';
  const headerImagePlacement = normalizeHeaderImagePlacement(
    activeCardData?.Card_Front?.Header?.ImagePlacement
  );

  const setHeaderImagePlacement = (placement: IdCardHeaderImagePlacement) => {
    setActiveCardData((prev) => {
      const { ImagePlacement: _omit, ...restHeader } = prev.Card_Front.Header;
      return {
        ...prev,
        Card_Front: {
          ...prev.Card_Front,
          Header:
            placement === 'Center'
              ? restHeader
              : { ...restHeader, ImagePlacement: placement },
        },
      };
    });
  };

  const updateCardData = (path: string[], value: string) => {
    setActiveCardData((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      let cur: any = next;
      for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]];
      cur[path[path.length - 1]] = value;
      return next;
    });
  };

  const toggleDisableIDCard = (disabled: boolean) => {
    setActiveCardData((prev) => ({ ...prev, DisableIDCard: disabled }));
  };

  // ---- Variation actions ----
  const networkLookup = useMemo(() => {
    const m = new Map<string, VendorNetwork>();
    vendorNetworks.forEach((n) => m.set(n.vendorNetworkId, n));
    return m;
  }, [vendorNetworks]);

  const existingVariationIds = useMemo(() => {
    return Object.keys((formData.idCardData as IDCardData)?.NetworkVariations ?? {});
  }, [formData.idCardData]);

  const unusedNetworks = vendorNetworks.filter((n) => !existingVariationIds.includes(n.vendorNetworkId));

  const addVariation = (networkId: string) => {
    if (!networkId) return;
    const fullData = (formData.idCardData ?? cloneDefaultForVariation(defaultIDCardData)) as IDCardData;
    const cloned = cloneDefaultForVariation(fullData);
    const nextVariations = { ...(fullData.NetworkVariations ?? {}), [networkId]: cloned };
    updateFormData({
      idCardData: { ...withoutVariations(fullData), NetworkVariations: nextVariations } as ProductFormData['idCardData']
    });
    // Pre-seed pending file uploads from default so saving uploads them too.
    if (formData.idCardLogoFile instanceof File) {
      const m = { ...(formData.idCardLogoFileByNetwork ?? {}) };
      m[networkId] = formData.idCardLogoFile;
      updateFormData({ idCardLogoFileByNetwork: m });
    }
    if (formData.idCardBackImageFiles && Object.keys(formData.idCardBackImageFiles).length > 0) {
      const allByNetwork = { ...(formData.idCardBackImageFilesByNetwork ?? {}) };
      allByNetwork[networkId] = { ...formData.idCardBackImageFiles };
      updateFormData({ idCardBackImageFilesByNetwork: allByNetwork });
    }
    setActiveNetworkId(networkId);
    setShowAddVariationPicker(false);
  };

  const removeActiveVariation = () => {
    if (!activeNetworkId) return;
    const fullData = formData.idCardData as IDCardData;
    const nextVariations = { ...(fullData.NetworkVariations ?? {}) };
    delete nextVariations[activeNetworkId];

    const nextLogoByNetwork = { ...(formData.idCardLogoFileByNetwork ?? {}) };
    delete nextLogoByNetwork[activeNetworkId];
    const nextBackByNetwork = { ...(formData.idCardBackImageFilesByNetwork ?? {}) };
    delete nextBackByNetwork[activeNetworkId];

    updateFormData({
      idCardData: { ...withoutVariations(fullData), NetworkVariations: nextVariations } as ProductFormData['idCardData'],
      idCardLogoFileByNetwork: nextLogoByNetwork,
      idCardBackImageFilesByNetwork: nextBackByNetwork
    });
    setActiveNetworkId(null);
  };

  const syncWithDefault = () => {
    if (!activeNetworkId) return;
    const fullData = formData.idCardData as IDCardData;
    const cloned = cloneDefaultForVariation(fullData);
    const nextVariations = { ...(fullData.NetworkVariations ?? {}), [activeNetworkId]: cloned };
    updateFormData({
      idCardData: { ...withoutVariations(fullData), NetworkVariations: nextVariations } as ProductFormData['idCardData']
    });
    // Re-seed pending file uploads from default
    const m = { ...(formData.idCardLogoFileByNetwork ?? {}) };
    if (formData.idCardLogoFile instanceof File) m[activeNetworkId] = formData.idCardLogoFile;
    else delete m[activeNetworkId];
    updateFormData({ idCardLogoFileByNetwork: m });

    const allByNetwork = { ...(formData.idCardBackImageFilesByNetwork ?? {}) };
    if (formData.idCardBackImageFiles && Object.keys(formData.idCardBackImageFiles).length > 0) {
      allByNetwork[activeNetworkId] = { ...formData.idCardBackImageFiles };
    } else {
      delete allByNetwork[activeNetworkId];
    }
    updateFormData({ idCardBackImageFilesByNetwork: allByNetwork });

    // Clear blob URLs for this variation; they'll regenerate from the new files
    setLogoBlobUrls((prev) => ({ ...prev, [activeNetworkId]: null }));
    setCardBackBlobUrls((prev) => ({ ...prev, [activeNetworkId]: { Top_Left: null, Top_Right: null, Middle: null, Bottom_Left: null, Bottom_Right: null } }));
  };

  // ---- Logo handlers (write to active variation) ----
  const handleLogoFileSelect = (file: File | null) => {
    if (!file) {
      if (currentLogoBlobUrl) {
        URL.revokeObjectURL(currentLogoBlobUrl);
        setLogoBlobUrls((prev) => ({ ...prev, [variationKey]: null }));
      }
      setActiveLogoFile(null);
      return;
    }
    if (currentLogoBlobUrl) URL.revokeObjectURL(currentLogoBlobUrl);
    const blobUrl = URL.createObjectURL(file);
    setLogoBlobUrls((prev) => ({ ...prev, [variationKey]: blobUrl }));
    setActiveLogoFile(file);
  };

  const handleLogoRemove = () => {
    if (currentLogoBlobUrl) {
      URL.revokeObjectURL(currentLogoBlobUrl);
      setLogoBlobUrls((prev) => ({ ...prev, [variationKey]: null }));
    }
    setActiveLogoFile(null);
    updateCardData(['Card_Front', 'Header', 'Image'], '');
  };

  const handleCardBackImageSelect = (section: string, file: File) => {
    const sectionKey = section as CardBackSections;
    if (currentCardBackBlobUrls[sectionKey]) {
      URL.revokeObjectURL(currentCardBackBlobUrls[sectionKey]!);
    }
    const blobUrl = URL.createObjectURL(file);
    setCardBackBlobUrls((prev) => ({
      ...prev,
      [variationKey]: { ...currentCardBackBlobUrls, [sectionKey]: blobUrl }
    }));
    setActiveBackFiles((prev: any) => ({ ...prev, [section]: file }));
  };

  const handleCardBackImageRemove = (section: string) => {
    const sectionKey = section as CardBackSections;
    if (currentCardBackBlobUrls[sectionKey]) {
      URL.revokeObjectURL(currentCardBackBlobUrls[sectionKey]!);
      setCardBackBlobUrls((prev) => ({
        ...prev,
        [variationKey]: { ...currentCardBackBlobUrls, [sectionKey]: null }
      }));
    }
    setActiveBackFiles((prev: any) => {
      const next = { ...prev };
      delete next[section];
      return next;
    });
    updateCardData(['Card_Back', section, 'Image'], '');
  };

  // ---- Display helpers ----
  const logoDisplay = useMemo(() => {
    if (currentLogoBlobUrl) {
      const fileName = activeLogoFile?.name || 'Selected image';
      return { type: 'file' as const, name: fileName, url: currentLogoBlobUrl };
    }
    if (currentLogoUrl && !activeLogoFile) {
      return { type: 'existing' as const, url: currentLogoUrl };
    }
    return null;
  }, [activeLogoFile, currentLogoBlobUrl, currentLogoUrl]);

  const getCardBackImageDisplay = (section: string) => {
    const sectionKey = section as CardBackSections;
    const file = (activeBackFiles as any)?.[section];
    const blobUrl = currentCardBackBlobUrls[sectionKey];
    if (file && blobUrl) {
      return { type: 'file' as const, name: file.name, url: blobUrl };
    }
    const existingUrl = activeCardData.Card_Back[section as keyof typeof activeCardData.Card_Back]?.Image;
    if (existingUrl && !existingUrl.startsWith('blob:') && !file) {
      return { type: 'existing' as const, url: existingUrl };
    }
    return null;
  };

  const renderSectionEditor = (sectionPath: string[], section: any, title: string) => {
    const sectionKey = sectionPath[sectionPath.length - 1];
    const imageDisplay = getCardBackImageDisplay(sectionKey);
    const isMiddleSection = sectionKey === 'Middle';

    return (
      <div className="card">
        <h4 className="font-semibold text-gray-800 mb-3">{title}</h4>
        <div className={`space-y-3 ${isMiddleSection ? 'text-center' : ''}`}>
          <div>
            <label className={`block text-sm font-medium text-gray-700 mb-1 ${isMiddleSection ? 'text-center' : ''}`}>Section Image (Optional)</label>
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-3">
              {imageDisplay ? (
                <div className="space-y-3">
                  <div className={`flex items-center space-x-3 ${isMiddleSection ? 'justify-center' : ''}`}>
                    <div className="w-32 h-32 bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center">
                      <img
                        src={imageDisplay.url}
                        alt="Section image"
                        className="max-w-full max-h-full object-contain"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                          e.currentTarget.nextElementSibling?.classList.remove('hidden');
                        }}
                      />
                      <Upload className="w-6 h-6 text-gray-400 hidden" />
                    </div>
                    <div className={`${isMiddleSection ? '' : 'flex-1'}`}>
                      <p className="text-sm font-medium text-gray-700">{imageDisplay.type === 'file' ? imageDisplay.name : ''}</p>
                      <p className="text-xs text-gray-500">{imageDisplay.type === 'file' ? 'New image selected' : ''}</p>
                    </div>
                  </div>
                  <div className="flex gap-4 justify-center">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleCardBackImageSelect(sectionKey, file);
                      }}
                      className="hidden"
                      id={`image-replace-${sectionKey}-${variationKey}`}
                    />
                    <label htmlFor={`image-replace-${sectionKey}-${variationKey}`} className="text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer transition-colors">
                      Upload Image
                    </label>
                    <button
                      onClick={() => handleCardBackImageRemove(sectionKey)}
                      className="text-sm text-red-500 hover:text-red-700 cursor-pointer transition-colors"
                      title="Delete Image"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center">
                  <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleCardBackImageSelect(sectionKey, file);
                    }}
                    className="hidden"
                    id={`image-upload-${sectionKey}-${variationKey}`}
                  />
                  <label
                    htmlFor={`image-upload-${sectionKey}-${variationKey}`}
                    className="text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer transition-colors"
                  >
                    Upload Image
                  </label>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className={`block text-sm font-medium text-gray-700 mb-1 ${isMiddleSection ? 'text-center' : ''}`}>Header</label>
            <input
              type="text"
              value={section.Header || ''}
              onChange={(e) => updateCardData([...sectionPath, 'Header'], e.target.value)}
              className={`form-input ${isMiddleSection ? 'text-center' : ''}`}
              placeholder="Section header"
            />
          </div>

          <div>
            <label className={`block text-sm font-medium text-gray-700 mb-1 ${isMiddleSection ? 'text-center' : ''}`}>Text Content</label>
            <textarea
              value={section.Text1 || ''}
              onChange={(e) => updateCardData([...sectionPath, 'Text1'], e.target.value)}
              className={`form-input ${isMiddleSection ? 'text-center' : ''}`}
              rows={2}
              placeholder="Text content (use \n for line breaks)"
            />
          </div>

          {section.Link_Name1 !== undefined && (
            <>
              <div>
                <label className={`block text-sm font-medium text-gray-700 mb-1 ${isMiddleSection ? 'text-center' : ''}`}>Link 1 (Optional)</label>
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" value={section.Link_Name1 || ''} onChange={(e) => updateCardData([...sectionPath, 'Link_Name1'], e.target.value)} className={`form-input ${isMiddleSection ? 'text-center' : ''}`} placeholder="Link text" />
                  <input type="text" value={section.URL1 || ''} onChange={(e) => updateCardData([...sectionPath, 'URL1'], e.target.value)} className={`form-input ${isMiddleSection ? 'text-center' : ''}`} placeholder="URL" />
                </div>
              </div>

              <div>
                <label className={`block text-sm font-medium text-gray-700 mb-1 ${isMiddleSection ? 'text-center' : ''}`}>Link 2 (Optional)</label>
                <div className="grid grid-cols-2 gap-2">
                  <input type="text" value={section.Link_Name2 || ''} onChange={(e) => updateCardData([...sectionPath, 'Link_Name2'], e.target.value)} className={`form-input ${isMiddleSection ? 'text-center' : ''}`} placeholder="Link text" />
                  <input type="text" value={section.URL2 || ''} onChange={(e) => updateCardData([...sectionPath, 'URL2'], e.target.value)} className={`form-input ${isMiddleSection ? 'text-center' : ''}`} placeholder="URL" />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  const renderFrontEditor = () => {
    return (
      <div className="space-y-4">
        <div className="card">
          <h4 className="font-semibold text-gray-800 mb-3">Card Header</h4>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-4 text-center">
            {logoDisplay ? (
              <div className="space-y-3">
                <div className="w-full h-32 flex items-center justify-center bg-gray-50 rounded-lg overflow-hidden">
                  {logoDisplay.type === 'file' ? (
                    <div className="text-center">
                      <img src={logoDisplay.url} alt="Selected header image" className="max-h-24 max-w-full object-contain mx-auto" />
                      <p className="text-sm text-green-600 font-medium mt-2">✓ {logoDisplay.name}</p>
                    </div>
                  ) : (
                    <img src={logoDisplay.url} alt="Current header image" className="max-h-24 max-w-full object-contain" />
                  )}
                </div>
                <p className="text-sm text-gray-600">{logoDisplay.type === 'file' ? 'New Image Selected' : 'Current Image'}</p>
                <div className="flex gap-2 justify-center">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleLogoFileSelect(file);
                      e.target.value = '';
                    }}
                    className="hidden"
                    id={`logo-update-${variationKey}`}
                  />
                  <label htmlFor={`logo-update-${variationKey}`} className="btn-primary cursor-pointer">Replace Image</label>
                  <button onClick={handleLogoRemove} className="btn-danger">Remove</button>
                </div>
              </div>
            ) : (
              <div className="text-center">
                <Upload className="w-8 h-8 text-gray-400 mx-auto mb-2" />
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleLogoFileSelect(file);
                    e.target.value = '';
                  }}
                  className="hidden"
                  id={`logo-upload-${variationKey}`}
                />
                <label htmlFor={`logo-upload-${variationKey}`} className="text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer transition-colors">
                  Upload Image
                </label>
              </div>
            )}
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Placement</label>
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden">
              {ID_CARD_HEADER_IMAGE_PLACEMENTS.map((placement) => (
                <button
                  key={placement}
                  type="button"
                  onClick={() => setHeaderImagePlacement(placement)}
                  className={`px-4 py-2 text-sm font-medium transition-colors ${
                    headerImagePlacement === placement
                      ? 'bg-oe-primary text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-50'
                  } ${placement !== 'Right' ? 'border-r border-gray-300' : ''}`}
                >
                  {placement}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-600">
              Center is the default. With left or right placement, header text (if set) appears on the opposite
              side; with center placement, text appears below the image.
            </p>
          </div>
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Header Text (Optional)</label>
            <textarea
              value={activeCardData.Card_Front.Header.HeaderText || ''}
              onChange={(e) => updateCardData(['Card_Front', 'Header', 'HeaderText'], e.target.value)}
              className="form-input"
              rows={2}
              placeholder="e.g. Member ID Card"
            />
            <p className="mt-1 text-xs text-gray-600">
              Shown in the card banner with the header image. Use line breaks for multiple lines.
            </p>
          </div>
          <p className="mt-2 text-xs text-gray-600">The image will be uploaded when you save the product.</p>
        </div>

        <div className="card">
          <h4 className="font-semibold text-gray-800 mb-3">Card Footer</h4>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Footer Header</label>
              <input
                type="text"
                value={activeCardData.Card_Front.Footer.Header}
                onChange={(e) => updateCardData(['Card_Front', 'Footer', 'Header'], e.target.value)}
                className="form-input"
                placeholder="e.g., Contact Information"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Footer Text Line 1</label>
              <input
                type="text"
                value={activeCardData.Card_Front.Footer.Text1}
                onChange={(e) => updateCardData(['Card_Front', 'Footer', 'Text1'], e.target.value)}
                className="form-input"
                placeholder="e.g., For Eligibility, Benefits & Customer Service"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Footer Text Line 2</label>
              <input
                type="text"
                value={activeCardData.Card_Front.Footer.Text2}
                onChange={(e) => updateCardData(['Card_Front', 'Footer', 'Text2'], e.target.value)}
                className="form-input"
                placeholder="e.g., (904) 373-6872"
              />
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderBackEditor = () => (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {renderSectionEditor(['Card_Back', 'Top_Left'], activeCardData.Card_Back.Top_Left, 'Top Left Section')}
        {renderSectionEditor(['Card_Back', 'Top_Right'], activeCardData.Card_Back.Top_Right, 'Top Right Section')}
      </div>
      {renderSectionEditor(['Card_Back', 'Middle'], activeCardData.Card_Back.Middle, 'Middle Section (Full Width)')}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {renderSectionEditor(['Card_Back', 'Bottom_Left'], activeCardData.Card_Back.Bottom_Left, 'Bottom Left Section')}
        {renderSectionEditor(['Card_Back', 'Bottom_Right'], activeCardData.Card_Back.Bottom_Right, 'Bottom Right Section')}
      </div>
    </div>
  );

  const renderPreview = () => {
    const mockMemberInfo = {
      firstName: 'John',
      lastName: 'Doe',
      memberId: '1',
      dateOfBirth: '1990-01-01',
      planName: formData.name || '[Product Name]',
      effectiveDate: '2024-01-01',
      dependents: [
        { name: 'Jane Doe', dob: '1992-05-15', gender: '' },
        { name: 'Child Doe', dob: '2015-08-20', gender: '' }
      ]
    };

    const updatedIdCardData = {
      ...activeCardData,
      Card_Front: {
        ...activeCardData.Card_Front,
        Header: {
          ...activeCardData.Card_Front.Header,
          Image: logoDisplay?.url || activeCardData.Card_Front.Header.Image || '',
        },
      },
      Card_Back: {
        ...activeCardData.Card_Back,
        Top_Left: { ...activeCardData.Card_Back.Top_Left, Image: getCardBackImageDisplay('Top_Left')?.url || activeCardData.Card_Back.Top_Left.Image },
        Top_Right: { ...activeCardData.Card_Back.Top_Right, Image: getCardBackImageDisplay('Top_Right')?.url || activeCardData.Card_Back.Top_Right.Image },
        Middle: { ...activeCardData.Card_Back.Middle, Image: getCardBackImageDisplay('Middle')?.url || activeCardData.Card_Back.Middle.Image },
        Bottom_Left: { ...activeCardData.Card_Back.Bottom_Left, Image: getCardBackImageDisplay('Bottom_Left')?.url || activeCardData.Card_Back.Bottom_Left.Image },
        Bottom_Right: { ...activeCardData.Card_Back.Bottom_Right, Image: getCardBackImageDisplay('Bottom_Right')?.url || activeCardData.Card_Back.Bottom_Right.Image }
      }
    };

    const { cardData: previewIdCardData, idCardConfigurationDisplay: previewIdCardConfigurationDisplay } =
      buildStep7PreviewIdCardState(
        updatedIdCardData,
        formData.configurationFields,
        activeCardData.DisableIDCard === true
      );

    return (
      <div className="space-y-8 p-4 bg-gray-50 rounded-lg">
        {formData.configurationFields &&
          Array.isArray(formData.configurationFields) &&
          formData.configurationFields.length > 0 &&
          activeCardData.DisableIDCard !== true && (
            <p className="text-xs text-gray-600 -mt-2 mb-2 max-w-xl">
              Preview uses a <strong>sample</strong> configuration value (first option from Step 3, or 6000), matching the
              member card. Use <code className="text-[11px] bg-gray-200 px-1 rounded">{`{{ConfigValue1}}`}</code> in card copy to
              place the value inline; otherwise it appears under Member Details.
            </p>
          )}
        <IDCard
          idCardData={previewIdCardData}
          memberInfo={mockMemberInfo}
          productName={formData.name || '[Product Name]'}
          isPreview={true}
          showGroupId={usesVendorGroupId && formData.showGroupIdOnIDCard === true}
          groupId={formData.eligibilityIndividualVendorGroupId?.trim() || '12345'}
          idCardConfigurationDisplay={previewIdCardConfigurationDisplay}
        />
      </div>
    );
  };

  const renderJsonEditor = () => {
    const cleanedData = JSON.parse(JSON.stringify(activeCardData));
    Object.keys(cleanedData.Card_Back).forEach((section) => {
      if (cleanedData.Card_Back[section].Image && cleanedData.Card_Back[section].Image.startsWith('blob:')) {
        cleanedData.Card_Back[section].Image = '';
      }
    });

    return (
      <div className="card">
        <h4 className="font-semibold text-gray-800 mb-3">JSON Editor</h4>
        <textarea
          value={JSON.stringify(cleanedData, null, 2)}
          onChange={(e) => {
            try {
              const parsed = JSON.parse(e.target.value);
              setActiveCardData(() => parsed);
            } catch {
              // ignore invalid JSON
            }
          }}
          className="w-full h-96 px-3 py-2 font-mono text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
        />
        <p className="mt-2 text-xs text-gray-600">Edit the JSON directly. Invalid JSON will be ignored. Blob URLs are hidden from display.</p>
      </div>
    );
  };

  const renderVariationSelector = () => {
    if (!formData.vendorId) return null;
    if (vendorNetworks.length === 0) return null;

    const variations = existingVariationIds
      .map((id) => ({ id, network: networkLookup.get(id) }))
      .filter((v) => v.network);

    return (
      <div className="bg-white rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-700">Variation:</span>
            <button
              type="button"
              onClick={() => setActiveNetworkId(null)}
              className={`px-3 py-1.5 text-sm rounded-lg border ${activeNetworkId === null ? 'bg-oe-primary text-white border-oe-primary' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
            >
              Default
            </button>
            {variations.map(({ id, network }) => (
              <button
                key={id}
                type="button"
                onClick={() => setActiveNetworkId(id)}
                className={`px-3 py-1.5 text-sm rounded-lg border ${activeNetworkId === id ? 'bg-oe-primary text-white border-oe-primary' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'}`}
              >
                {network!.title}
                {network!.isDefault ? <span className="ml-1 text-xs opacity-70">(default)</span> : null}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              disabled={unusedNetworks.length === 0}
              onClick={() => setShowAddVariationPicker(true)}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              title={unusedNetworks.length === 0 ? 'All vendor networks already have a variation' : 'Add a variation for an unused network'}
            >
              <Plus className="w-4 h-4" /> Add variation
            </button>
            <button
              type="button"
              disabled={!activeNetworkId}
              onClick={syncWithDefault}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Reset this variation to match the default ID card"
            >
              <RefreshCw className="w-4 h-4" /> Sync with default
            </button>
            <button
              type="button"
              disabled={!activeNetworkId}
              onClick={removeActiveVariation}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-red-300 bg-white text-red-600 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" /> Remove variation
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-600">
          {activeNetworkId
            ? 'Editing the ID card variation for this network. Members in groups using this network will see this card.'
            : 'Editing the default ID card. Used when a group has not selected a network for this vendor, and for all individual (non-group) members.'}
        </p>
        {showAddVariationPicker && (
          <div className="mt-3 flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs font-medium text-gray-700 mb-1">Choose a network</label>
              <select
                className="form-input"
                defaultValue=""
                onChange={(e) => addVariation(e.target.value)}
              >
                <option value="" disabled>Select a network...</option>
                {unusedNetworks.map((n) => (
                  <option key={n.vendorNetworkId} value={n.vendorNetworkId}>
                    {n.title}{n.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="px-3 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
              onClick={() => setShowAddVariationPicker(false)}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h3 className="text-xl font-bold text-gray-800">ID Card Configuration</h3>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setShowCopyModal(true)}
            className="btn-primary !bg-gray-100 !text-gray-700 hover:!bg-gray-200 border border-gray-300"
          >
            <Copy className="w-4 h-4 inline-block mr-2" />
            Copy from another product
          </button>
          <button onClick={() => setViewMode('visual')} className={`btn-primary ${viewMode !== 'visual' ? '!bg-gray-200 !text-gray-700 hover:!bg-gray-300' : ''}`}>
            <FileText className="w-4 h-4 inline-block mr-2" /> Visual Editor
          </button>
          <button onClick={() => setViewMode('preview')} className={`btn-primary ${viewMode !== 'preview' ? '!bg-gray-200 !text-gray-700 hover:!bg-gray-300' : ''}`}>
            <Eye className="w-4 h-4 inline-block mr-2" /> Preview
          </button>
          <button onClick={() => setViewMode('json')} className={`btn-primary ${viewMode !== 'json' ? '!bg-gray-200 !text-gray-700 hover:!bg-gray-300' : ''}`}>
            <Code className="w-4 h-4 inline-block mr-2" /> JSON
          </button>
        </div>
      </div>

      {showCopyModal && (() => {
        const totalSelectable =
          (sourcePreview?.default ? 1 : 0) + (sourcePreview?.variations.length ?? 0);
        const allSelected = totalSelectable > 0 && selectedCopyKeys.size === totalSelectable;
        const toggleKey = (key: string) => {
          setSelectedCopyKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        };
        const toggleAll = () => {
          if (!sourcePreview) return;
          if (allSelected) {
            setSelectedCopyKeys(new Set());
          } else {
            const all = new Set<string>();
            if (sourcePreview.default) all.add(DEFAULT_COPY_KEY);
            sourcePreview.variations.forEach((v) => all.add(v.sourceNetworkId));
            setSelectedCopyKeys(all);
          }
        };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => !copyLoading && setShowCopyModal(false)}>
            <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <h4 className="text-lg font-semibold text-gray-900 mb-2">Copy ID card from another product</h4>
              <p className="text-sm text-gray-600 mb-4">Select a product (bundles excluded), then choose which cards to copy. Images are re-uploaded when you save.</p>
              <div className="mb-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">Product</label>
                <SearchableDropdown
                  options={productOptions}
                  value={selectedProductId}
                  onChange={(value) => setSelectedProductId(value)}
                  placeholder={productsLoading ? 'Loading products...' : 'Select a product'}
                  loading={productsLoading}
                />
              </div>

              {selectedProductId && (
                <div className="mb-4 border border-gray-200 rounded-lg">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
                    <span className="text-sm font-medium text-gray-900">Cards to copy</span>
                    {previewLoading ? (
                      <span className="text-xs text-gray-500">Loading...</span>
                    ) : (
                      totalSelectable > 0 && (
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                          />
                          <span className="text-xs text-gray-700">Select all</span>
                        </label>
                      )
                    )}
                  </div>
                  <div className="divide-y divide-gray-100">
                    {!previewLoading && totalSelectable === 0 && (
                      <div className="px-3 py-3 text-sm text-gray-500">No ID card configuration to copy.</div>
                    )}
                    {sourcePreview?.default && (
                      <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
                        <input
                          type="checkbox"
                          checked={selectedCopyKeys.has(DEFAULT_COPY_KEY)}
                          onChange={() => toggleKey(DEFAULT_COPY_KEY)}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                        />
                        <div>
                          <div className="text-sm font-medium text-gray-900">Default card</div>
                          <div className="text-xs text-gray-500">Replaces this product's top-level ID card.</div>
                        </div>
                      </label>
                    )}
                    {sourcePreview?.variations.map((v) => {
                      const noMatch = !v.matchedTargetNetworkId;
                      return (
                        <label key={v.sourceNetworkId} className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={selectedCopyKeys.has(v.sourceNetworkId)}
                            onChange={() => toggleKey(v.sourceNetworkId)}
                            className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                          />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-gray-900">
                              {v.title}
                              {v.isDefault && <span className="ml-1 text-xs text-gray-500">(source default)</span>}
                            </div>
                            <div className={`text-xs ${noMatch ? 'text-amber-600' : 'text-gray-500'}`}>
                              {noMatch
                                ? 'No matching network in current vendor — variation will copy under source network ID.'
                                : 'Will copy onto this vendor\'s matching network.'}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {copyError && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-sm">{copyError}</div>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowCopyModal(false)} disabled={copyLoading} className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Cancel</button>
                <button
                  type="button"
                  onClick={handleCopyFromProductConfirm}
                  disabled={!selectedProductId || copyLoading || previewLoading || !sourcePreview || selectedCopyKeys.size === 0}
                  className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {copyLoading ? 'Copying...' : `Copy ${selectedCopyKeys.size || ''} ${selectedCopyKeys.size === 1 ? 'card' : 'cards'}`.trim()}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="alert-info">
        <h4 className="font-semibold mb-2">About ID Cards</h4>
        <p className="text-sm">
          Configure the digital ID card template for the mobile app. Member-specific data will be populated automatically when cards are generated.
          {vendorNetworks.length > 0 && (
            <> Optionally add per-network variations below; groups can choose a network so their members see the matching card.</>
          )}
        </p>
      </div>

      {/* Network variations selector */}
      {renderVariationSelector()}

      <div className="bg-white rounded-lg border border-gray-200">
        <button
          type="button"
          onClick={() => setShowAdvancedIdCardSettings((o) => !o)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left hover:bg-gray-50 rounded-lg transition-colors"
          aria-expanded={showAdvancedIdCardSettings}
        >
          <span className="text-sm font-medium text-gray-900">Advanced ID card settings</span>
          {showAdvancedIdCardSettings ? <ChevronDown className="h-5 w-5 text-gray-500 shrink-0" /> : <ChevronRight className="h-5 w-5 text-gray-500 shrink-0" />}
        </button>
        {showAdvancedIdCardSettings && (
          <div className="px-4 pb-4 pt-0 border-t border-gray-100 space-y-5">
            <div>
              <label className="inline-flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeCardData?.DisableIDCard === true}
                  onChange={(e) => toggleDisableIDCard(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                />
                <span className="text-sm font-medium text-gray-900">Disable ID Card{activeNetworkId ? ' for this variation' : ''}</span>
              </label>
              <p className="mt-2 text-xs text-gray-600">
                {activeNetworkId
                  ? 'When enabled, members in groups using this network will not see an ID card for this product.'
                  : 'When enabled, this product will not show an ID card for members.'}
              </p>
            </div>
            {!activeNetworkId && usesVendorGroupId && (
              <div>
                <label className="inline-flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={formData.showGroupIdOnIDCard === true}
                    onChange={(e) => updateFormData({ showGroupIdOnIDCard: e.target.checked })}
                    className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  />
                  <span className="text-sm font-medium text-gray-900">Show Vendor Group ID on ID cards</span>
                </label>
                <p className="mt-2 text-xs text-gray-600">
                  When enabled, displays the vendor group ID on the card front. Group members use the group&apos;s assigned ID; individuals use <strong>Individuals Group ID</strong> from Step 1.
                </p>
              </div>
            )}
            {!activeNetworkId && !usesVendorGroupId && (
              <p className="text-xs text-gray-600">
                Enable <strong>Use vendor group ID for this product</strong> in Step 1 to show vendor group IDs on ID cards.
              </p>
            )}
            {!activeNetworkId && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Member ID prefix (ID card and eligibility)</label>
                <input
                  type="text"
                  value={formData.idCardMemberIdPrefixMask ?? ''}
                  onChange={(e) => updateFormData({ idCardMemberIdPrefixMask: e.target.value.slice(0, 10) })}
                  className="w-full max-w-xs px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. SW (optional)"
                  maxLength={10}
                />
                <p className="mt-2 text-xs text-gray-600">
                  When set, if the household member ID starts with the tenant&apos;s group prefix, that prefix is replaced with this value on this product&apos;s ID card and in eligibility exports. Leave blank to show the stored ID everywhere.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {activeCardData?.DisableIDCard ? (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center">
          <CreditCard className="h-6 w-6 text-gray-400 mx-auto mb-2" />
          <p className="text-sm font-medium text-gray-900">ID card settings are hidden</p>
          <p className="text-xs text-gray-600 mt-1">Uncheck "Disable ID Card" to configure or preview this product's ID card.</p>
        </div>
      ) : (
        <>
          {viewMode === 'visual' && (
            <>
              <div className="flex gap-2">
                <button onClick={() => setActiveTab('front')} className={`btn-primary ${activeTab !== 'front' ? '!bg-gray-200 !text-gray-700 hover:!bg-gray-300' : ''}`}>
                  <CreditCard className="w-4 h-4 inline-block mr-2" /> Card Front
                </button>
                <button onClick={() => setActiveTab('back')} className={`btn-primary ${activeTab !== 'back' ? '!bg-gray-200 !text-gray-700 hover:!bg-gray-300' : ''}`}>
                  <FileText className="w-4 h-4 inline-block mr-2" /> Card Back
                </button>
              </div>
              {activeTab === 'front' ? renderFrontEditor() : renderBackEditor()}
            </>
          )}

          {viewMode === 'preview' && renderPreview()}
          {viewMode === 'json' && renderJsonEditor()}
        </>
      )}
    </div>
  );
}
