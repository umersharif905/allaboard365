// frontend/src/pages/groups/GroupProductsTab.tsx
import {
    AlertCircle,
    ChevronDown,
    ChevronRight,
    Copy,
    ExternalLink,
    Eye,
    Info,
    Link as LinkIcon,
    MapPin,
    Package,
    Plus,
    Search,
    Settings,
    Trash2,
    XCircle
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import ASARequiredBanner, { ASAStatusItem } from '../../components/groups/ASARequiredBanner';
import ASASigningModal from '../../components/groups/ASASigningModal';
import DeleteProductConfirmModal from '../../components/groups/DeleteProductConfirmModal';
import HiddenProductsSection from '../../components/groups/HiddenProductsSection';
import VendorNetworkSelections, { VendorNetworkSelectionMap } from '../../components/groups/VendorNetworkSelections';
import ProductDocumentsLinks from '../../components/shared/ProductDocumentsLinks';
import { hasProductDocuments } from '../../utils/productDocuments';
import { useAuth } from '../../contexts/AuthContext';
import { useEnrollmentLinkTemplates } from '../../hooks/useEnrollmentLinkTemplates';
import { useGroupASAStatus } from '../../hooks/useGroupASAStatus';
import { useGroupProducts } from '../../hooks/useGroupProducts';
import { useGroupProductEnrollmentCount } from '../../hooks/groups/useGroupProductEnrollmentCount';
import { useHiddenProductsWithEnrollments } from '../../hooks/groups/useHiddenProductsWithEnrollments';
import { GroupProduct, Product, GroupProductsService, ConfigurationField } from '../../services/group-products.service';
import { EnrollmentLinkTemplatesService } from '../../services/enrollment-link-templates.service';
import type { EnrollmentLinkTemplate } from '../../services/enrollment-link-templates.service';


/** Same visibility rules as GroupsAddGroup — assigned group products may be catalog-hidden */
const isProductHiddenForGroup = (p: any) =>
  p.IsHidden === true || p.IsHidden === 1 ||
  p.isHidden === true || p.isHidden === 1 ||
  p.IsHidden === 'true' || p.isHidden === 'true';

/** Catalog-level hide (Products.IsHidden) — distinct from per-group GroupProducts.IsHidden. */
const isProductCatalogHidden = (p: any) =>
  p.IsCatalogHidden === true || p.IsCatalogHidden === 1 ||
  p.isCatalogHidden === true || p.isCatalogHidden === 1 ||
  p.IsCatalogHidden === 'true' || p.isCatalogHidden === 'true';

/**
 * Safari-safe clipboard copy. Same behavior as the helper in EnrollmentLinkTemplates.tsx —
 * Safari blocks navigator.clipboard.writeText after an `await`, so try the legacy
 * execCommand path first when Safari is detected, then fall back to the modern API.
 */
async function robustCopy(text: string): Promise<boolean> {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    if (isSafari) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) return true;
      } catch { /* fall through */ }
    }
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta2 = document.createElement('textarea');
    ta2.value = text;
    ta2.style.position = 'fixed';
    ta2.style.left = '-9999px';
    ta2.style.top = '0';
    ta2.setAttribute('readonly', '');
    document.body.appendChild(ta2);
    ta2.focus();
    ta2.select();
    const ok2 = document.execCommand('copy');
    document.body.removeChild(ta2);
    return ok2;
  } catch {
    return false;
  }
}

interface GroupProductsTabProps {
  groupId: string;
  groupName: string;
  /**
   * Current GroupType. Drives the un-hide constraint:
   *   - ListBill groups cannot un-hide Group-only products
   *   - Standard groups cannot un-hide Individual-only products
   *
   * Optional for callers that don't yet pass it through; absent value
   * defaults to permissive (matches pre-constraint behavior).
   */
  groupType?: 'Standard' | 'ListBill' | string;
  /** Opens the group editor scoped to the Products tab. Wired by GroupDetails. */
  onAddProduct?: () => void;
}

interface ProductDetailsModalProps {
  product: Product | GroupProduct;
  onClose: () => void;
}

const GroupProductsTab: React.FC<GroupProductsTabProps> = ({ groupId, groupName, onAddProduct }) => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const showEnrollmentLinksSection = user?.currentRole && ['Agent', 'TenantAdmin', 'SysAdmin'].includes(user.currentRole);
  const canEditProducts = !!user?.currentRole && ['Agent', 'TenantAdmin', 'SysAdmin'].includes(user.currentRole);
  const canSignASA = user?.currentRole === 'GroupAdmin';

  const { data: templatesData, isLoading: templatesLoading } = useEnrollmentLinkTemplates(
    showEnrollmentLinksSection ? { groupId, templateType: 'Group', limit: 100 } : undefined
  );
  const templates = templatesData?.data ?? [];

  // Use our custom hooks
  const { 
    data,
    isLoading: loading,
    isError,
    error: fetchError,
    refetch
  } = useGroupProducts(groupId);
  
  // Get ASA status for all products
  const { 
    data: asaStatus,
    refetch: refetchASAStatus
  } = useGroupASAStatus(groupId);

  // ---- Vendor networks selection (per-vendor for this group) ----
  const [groupVendors, setGroupVendors] = useState<Array<{ VendorId: string; VendorName: string }>>([]);
  const [vendorNetworkSelections, setVendorNetworkSelections] = useState<VendorNetworkSelectionMap>({});

  useEffect(() => {
    if (!groupId) return;
    let cancelled = false;
    (async () => {
      try {
        const [vendorsResp, selectionsResp] = await Promise.all([
          apiService.get<{ success: boolean; data?: Array<{ VendorId: string; VendorName: string }> }>(`/api/groups/${groupId}/vendors`),
          apiService.get<{ success: boolean; data?: Array<{ vendorId: string; vendorNetworkId: string }> }>(`/api/groups/${groupId}/vendor-networks`)
        ]);
        if (cancelled) return;
        if (vendorsResp?.success && Array.isArray(vendorsResp.data)) {
          setGroupVendors(vendorsResp.data);
        }
        if (selectionsResp?.success && Array.isArray(selectionsResp.data)) {
          const map: VendorNetworkSelectionMap = {};
          for (const r of selectionsResp.data) {
            if (r?.vendorId) map[r.vendorId] = r.vendorNetworkId || null;
          }
          setVendorNetworkSelections(map);
        }
      } catch (err) {
        console.warn('Failed to load group vendors / vendor-networks', err);
      }
    })();
    return () => { cancelled = true; };
  }, [groupId]);
  
  // Extract data from the hook
  // The useGroupProducts hook from useGroupProducts.ts returns response.data directly
  // Extract groupProducts from the response data
  // Handle both possible data structures
  let groupProducts = [];
  if (data && Array.isArray(data)) {
    // If data is an array, it might be the groupProducts directly
    groupProducts = data;
  } else if (data && data.groupProducts) {
    // If data is an object with groupProducts property
    groupProducts = data.groupProducts;
  } else if (data && (data as any).data && (data as any).data.groupProducts) {
    // If data has a nested data property
    groupProducts = (data as any).data.groupProducts;
  } else if (data && (data as any).data && Array.isArray((data as any).data)) {
    // If data.data is an array (this seems to be the case)
    groupProducts = (data as any).data;
  }
  
  // Helper function to get ASA status for a product (used to detect bundle expansion data)
  const getProductASAStatus = (productId: string) => {
    if (!asaStatus?.products) return null;
    const want = productId ? String(productId).toLowerCase() : '';
    return asaStatus.products.find(
      (p) => (p.productId ? String(p.productId).toLowerCase() : '') === want
    );
  };

  /**
   * Flatten the group ASA status response into the banner's `ASAStatusItem[]` shape.
   * Includes bundle subproducts so a bundle's required ASA documents appear in the banner.
   */
  const buildASABannerItems = (): ASAStatusItem[] => {
    const items: ASAStatusItem[] = [];
    const products = asaStatus?.products ?? [];
    for (const p of products) {
      if (p.requiresASA && p.asaAgreement) {
        items.push({
          productId: p.productId,
          productName: p.productName,
          documentId: p.asaAgreement.documentId,
          documentName: p.asaAgreement.documentName,
          documentUrl: p.asaAgreement.documentUrl,
          signed: !!p.isSigned,
        });
      }
      for (const sub of p.bundleProducts ?? []) {
        if (sub.requiresASA && sub.asaAgreement) {
          items.push({
            productId: sub.productId,
            productName: sub.productName,
            documentId: sub.asaAgreement.documentId,
            documentName: sub.asaAgreement.documentName,
            documentUrl: sub.asaAgreement.documentUrl,
            signed: !!sub.isSigned,
          });
        }
      }
    }
    return items;
  };

  /**
   * Adapter: ASARequiredBanner emits a documentId; the existing ASASigningModal
   * opens by product. Find the first product (top-level or bundle subproduct)
   * whose ASA agreement matches the documentId and open the modal with that product.
   */
  const openASAModalForDocument = (documentId: string) => {
    const products = asaStatus?.products ?? [];
    for (const p of products) {
      if (p.asaAgreement?.documentId === documentId) {
        setSelectedProductForASA({
          productId: p.productId,
          productName: p.productName,
          asaAgreement: p.asaAgreement,
        });
        setShowASAModal(true);
        return;
      }
      for (const sub of p.bundleProducts ?? []) {
        if (sub.asaAgreement?.documentId === documentId) {
          setSelectedProductForASA({
            productId: sub.productId,
            productName: sub.productName,
            asaAgreement: sub.asaAgreement,
          });
          setShowASAModal(true);
          return;
        }
      }
    }
  };


  // State
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedProductType, setSelectedProductType] = useState<string>('');
  const [showProductModal, setShowProductModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | GroupProduct | null>(null);
  const [showASAModal, setShowASAModal] = useState(false);
  const [selectedProductForASA, setSelectedProductForASA] = useState<any>(null);
  const [showDeductibleConfigModal, setShowDeductibleConfigModal] = useState(false);
  const [selectedProductForConfig, setSelectedProductForConfig] = useState<GroupProduct | null>(null);
  const [deductibleConfig, setDeductibleConfig] = useState<Record<string, string[]>>({});
  const [savingConfig, setSavingConfig] = useState(false);
  const [templateToView, setTemplateToView] = useState<EnrollmentLinkTemplate | null>(null);
  // Per-template UI state for the inline Copy/Open Group link buttons.
  const [copyingTemplateId, setCopyingTemplateId] = useState<string | null>(null);
  const [copiedTemplateId, setCopiedTemplateId] = useState<string | null>(null);
  const [openingTemplateId, setOpeningTemplateId] = useState<string | null>(null);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);

  /**
   * Resolve the canonical Group enrollment URL — same get-or-create the
   * employee-facing PDFs use, so the agent's Copy/Open buttons hand out the
   * exact link members will follow (LinkType=Agent-Static, GroupId set).
   * Idempotent on the backend so re-calling is safe.
   */
  const fetchGroupEnrollmentLinkUrl = async (): Promise<string | null> => {
    const res = await apiService.get<{ success: boolean; data?: { enrollmentUrl?: string } }>(
      `/api/groups/${groupId}/enrollment-link`
    );
    return (res?.success && res.data?.enrollmentUrl) || null;
  };

  const handleCopyGroupLink = async (template: EnrollmentLinkTemplate) => {
    setLinkActionError(null);
    setCopyingTemplateId(template.TemplateId);
    try {
      const url = await fetchGroupEnrollmentLinkUrl();
      if (!url) {
        setLinkActionError('Could not get the group enrollment link.');
        return;
      }
      const ok = await robustCopy(url);
      if (ok) {
        setCopiedTemplateId(template.TemplateId);
        setTimeout(() => setCopiedTemplateId(null), 2000);
      } else {
        // Fall back to prompt — keeps the URL visible for manual copy.
        window.prompt('Copy this link:', url);
      }
    } catch (err) {
      console.error('Copy group link failed:', err);
      setLinkActionError(err instanceof Error ? err.message : 'Failed to copy group link.');
    } finally {
      setCopyingTemplateId(null);
    }
  };

  const handleOpenGroupLink = async (template: EnrollmentLinkTemplate) => {
    setLinkActionError(null);
    setOpeningTemplateId(template.TemplateId);
    try {
      const url = await fetchGroupEnrollmentLinkUrl();
      if (!url) {
        setLinkActionError('Could not get the group enrollment link.');
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      console.error('Open group link failed:', err);
      setLinkActionError(err instanceof Error ? err.message : 'Failed to open group link.');
    } finally {
      setOpeningTemplateId(null);
    }
  };
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(new Set());
  const [pendingMutation, setPendingMutation] = useState<{ description: string; run: () => void | Promise<void> } | null>(null);
  const [runningMutation, setRunningMutation] = useState(false);
  const [productPendingDelete, setProductPendingDelete] = useState<{
    productId: string;
    productName: string;
  } | null>(null);
  const [restoringProductId, setRestoringProductId] = useState<string | null>(null);

  const handleRestoreProduct = async (productId: string, productName: string) => {
    setRestoringProductId(productId);
    try {
      const response = await GroupProductsService.toggleProductVisibility(
        groupId,
        productId,
        false /* isHidden — false means "make active again" */
      );
      if (response.success) {
        await refetch();
        await queryClient.invalidateQueries({
          queryKey: ['group-hidden-with-enrollments', groupId],
        });
      } else if ((response as any).message) {
        window.alert((response as any).message);
      } else {
        window.alert(`Failed to add "${productName}" back to the group.`);
      }
    } finally {
      setRestoringProductId(null);
    }
  };

  const { data: enrollmentCountData, isLoading: enrollmentCountLoading } =
    useGroupProductEnrollmentCount(groupId, productPendingDelete?.productId ?? null);

  // Hidden products with active enrollments — only loaded for editors.
  const { data: hiddenWithEnrollments = [] } = useHiddenProductsWithEnrollments(
    groupId,
    canEditProducts /* enabled */
  );

  const getProductTypes = () => {
    const types = new Set(groupProducts.map((p: any) => p.ProductType).filter(Boolean));
    return Array.from(types);
  };

  const PRODUCT_TYPE_ORDER = ['Bundle', 'Healthcare', 'Dental', 'Vision', 'Telemedicine', 'Other'];

  const filteredGroupProducts = groupProducts.filter((product: any) => {
    // Hidden products live in the separate "Products with Active Enrollments"
    // section below; the active list never shows them.
    if (isProductHiddenForGroup(product)) return false;
    // Catalog-hidden (Products.IsHidden) products are bundle-only / retired —
    // never surface them as standalone manageable rows, even if a stale
    // GroupProducts row points at one.
    if (isProductCatalogHidden(product)) return false;
    const matchesSearch = !searchTerm ||
      product.Name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      product.Description?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = !selectedProductType || product.ProductType === selectedProductType;
    return matchesSearch && matchesType;
  }).sort((a: any, b: any) => {
    const ai = PRODUCT_TYPE_ORDER.indexOf(a.ProductType);
    const bi = PRODUCT_TYPE_ORDER.indexOf(b.ProductType);
    const orderA = ai === -1 ? PRODUCT_TYPE_ORDER.length : ai;
    const orderB = bi === -1 ? PRODUCT_TYPE_ORDER.length : bi;
    if (orderA !== orderB) return orderA - orderB;
    return (a.Name || '').localeCompare(b.Name || '');
  });

  // Handle opening deductible configuration modal
  const handleOpenDeductibleConfig = (product: GroupProduct) => {
    setSelectedProductForConfig(product);
    
    const customSettings = product.CustomSettings || {};
    const allowedOptions = customSettings.allowedDeductibleOptions || {};
    const allowedByProduct = customSettings.allowedDeductibleOptionsByProduct || {};
    
    const initialConfig: Record<string, string[]> = {};
    if (product.DeductibleFields && product.DeductibleFields.length > 0) {
      product.DeductibleFields.forEach((field: ConfigurationField & { sourceProductId?: string; sourceProductName?: string; productAllowedOptions?: string[] }) => {
        const key = field.sourceProductId ? `${field.sourceProductId}|${field.fieldName}` : field.fieldName;
        const productOpts = field.sourceProductId ? allowedByProduct[field.sourceProductId]?.[field.fieldName] : undefined;
        let opts = productOpts ?? allowedOptions[field.fieldName] ?? field.fieldOptions ?? [];
        if (field.productAllowedOptions && field.productAllowedOptions.length > 0) {
          opts = opts.filter((opt: string) => field.productAllowedOptions!.includes(opt));
        }
        initialConfig[key] = opts;
      });
    }
    
    setDeductibleConfig(initialConfig);
    setShowDeductibleConfigModal(true);
  };

  // Handle saving deductible configuration
  const handleSaveDeductibleConfig = async () => {
    if (!selectedProductForConfig) return;
    
    const fields = selectedProductForConfig.DeductibleFields || [];
    const validationErrors: string[] = [];
    fields.forEach((field: ConfigurationField & { sourceProductId?: string; sourceProductName?: string }) => {
      const key = field.sourceProductId ? `${field.sourceProductId}|${field.fieldName}` : field.fieldName;
      const selectedOptions = deductibleConfig[key] || [];
      if (selectedOptions.length === 0) {
        const label = field.sourceProductName ? `${field.fieldName} (${field.sourceProductName})` : field.fieldName;
        validationErrors.push(`${label} requires at least one option to be selected`);
      }
    });
    
    if (validationErrors.length > 0) {
      alert(`Please select at least one option for each field:\n\n${validationErrors.join('\n')}`);
      return;
    }
    
    const hasBundleFields = fields.some((f: ConfigurationField & { sourceProductId?: string }) => f.sourceProductId);
    const filterByProductAllowed = (field: ConfigurationField & { productAllowedOptions?: string[] }, options: string[]) => {
      const allowed = field.productAllowedOptions;
      if (!allowed || allowed.length === 0) return options;
      return options.filter(opt => allowed.includes(opt));
    };
    let payload: { allowedOptions?: Record<string, string[]>; allowedOptionsByProduct?: Record<string, Record<string, string[]>> };
    if (hasBundleFields) {
      const byProduct: Record<string, Record<string, string[]>> = {};
      fields.forEach((field: ConfigurationField & { sourceProductId?: string; productAllowedOptions?: string[] }) => {
        const key = field.sourceProductId ? `${field.sourceProductId}|${field.fieldName}` : field.fieldName;
        const options = filterByProductAllowed(field, deductibleConfig[key] || []);
        if (field.sourceProductId) {
          if (!byProduct[field.sourceProductId]) byProduct[field.sourceProductId] = {};
          byProduct[field.sourceProductId][field.fieldName] = options;
        }
      });
      payload = { allowedOptionsByProduct: byProduct };
    } else {
      const allowedOptions: Record<string, string[]> = {};
      fields.forEach((field: ConfigurationField & { productAllowedOptions?: string[] }) => {
        allowedOptions[field.fieldName] = filterByProductAllowed(field, deductibleConfig[field.fieldName] || []);
      });
      payload = { allowedOptions };
    }
    
    setSavingConfig(true);
    try {
      const result = await GroupProductsService.updateDeductibleConfig(
        groupId,
        selectedProductForConfig.ProductId,
        payload
      );
      
      if (result.success) {
        refetch();
        setShowDeductibleConfigModal(false);
        setSelectedProductForConfig(null);
        setDeductibleConfig({});
      } else {
        alert(`Failed to save configuration: ${result.message}`);
      }
    } catch (error) {
      console.error('Error saving deductible config:', error);
      alert('Failed to save configuration. Please try again.');
    } finally {
      setSavingConfig(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  if (isError && fetchError instanceof Error && fetchError.message.includes('404')) {
    return (
      <div className="text-center py-12">
        <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">Product Management Not Available</h3>
        <p className="text-gray-600">
          The product management feature is not currently available for this group.
          This may be because the server needs to be restarted to apply recent changes.
        </p>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-center py-12">
        <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
        <h3 className="text-lg font-medium text-gray-900 mb-2">Error Loading Products</h3>
        <p className="text-gray-600 mb-4">
          {fetchError instanceof Error ? fetchError.message : 'Failed to load products'}
        </p>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-oe-primary hover:bg-oe-primary-dark"
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold text-gray-900">Group Products</h2>
        <p className="text-sm text-gray-600">Products currently assigned to {groupName}</p>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search products..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
              />
            </div>
          </div>
          <div className="sm:w-48">
            <select
              value={selectedProductType}
              onChange={(e) => setSelectedProductType(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            >
              <option value="">All Product Types</option>
              {getProductTypes().map((type: any) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ASA signature banner — single rollup for all unsigned ASAs (replaces per-row pills) */}
      <ASARequiredBanner
        asaStatus={buildASABannerItems()}
        canSign={canSignASA}
        onSign={openASAModalForDocument}
      />

      {/* Assigned Products */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-medium text-gray-900">Assigned Products</h3>
            <p className="text-sm text-gray-600">
              Products currently available to group members.
            </p>
          </div>
          {canEditProducts && onAddProduct && (
            <button
              type="button"
              onClick={onAddProduct}
              className="inline-flex items-center px-3 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark flex-shrink-0"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Product
            </button>
          )}
        </div>
        
        {filteredGroupProducts.length === 0 ? (
          <div className="p-6 text-center">
            <Package className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No products assigned</h3>
            <p className="text-gray-600">This group doesn't have any products assigned yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Product</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {filteredGroupProducts.map((product: any) => {
                  const asaStatus = getProductASAStatus(product.ProductId);
                  const isBundle = !!(product.IsBundle === true || product.IsBundle === 1 || asaStatus?.isBundle);
                  
                  const hidden = isProductHiddenForGroup(product);

                  return (
                    <React.Fragment key={product.ProductId}>
                      {/* Main Product Row */}
                      <tr className={hidden ? 'bg-gray-50 opacity-60' : 'hover:bg-gray-50'}>
                        <td className="px-6 py-4">
                          <div className="flex items-center max-w-md">
                            <div className="h-10 w-10 flex-shrink-0">
                              {product.ProductLogoUrl ? (
                                <img 
                                  src={product.ProductLogoUrl} 
                                  alt={product.Name}
                                  className="h-full w-full rounded-lg object-contain bg-white p-1"
                                />
                              ) : (
                                <div className="h-full w-full bg-oe-primary/10 rounded-lg flex items-center justify-center">
                                  <Package className="h-6 w-6 text-oe-primary" />
                                </div>
                              )}
                            </div>
                            <div className="ml-4 min-w-0 flex-1">
                              <div className="text-sm font-medium text-gray-900 flex items-center flex-wrap gap-x-2 gap-y-1">
                                <span className="truncate">{product.Name}</span>
                                {isBundle && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 flex-shrink-0">
                                    Bundle
                                  </span>
                                )}
                              </div>
                              {product.Description && (
                                <div className="text-sm text-gray-500 line-clamp-2 break-words">{product.Description}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                            {product.ProductType}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            hidden
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-green-100 text-green-800'
                          }`}>
                            {hidden ? 'Removed' : 'Active'}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                          <div className="flex items-center space-x-2">
                            <button
                              onClick={() => {
                                setSelectedProduct(product);
                                setShowProductModal(true);
                              }}
                              className="text-oe-primary hover:text-oe-primary-dark"
                              title="View Details"
                            >
                              <Info className="h-4 w-4" />
                            </button>
                            {canEditProducts && product.DeductibleFields && product.DeductibleFields.length > 0 && (
                              <button
                                onClick={() => handleOpenDeductibleConfig(product)}
                                className="text-green-600 hover:text-green-700"
                                title="Configure Deductible or UnShared Amount Options"
                              >
                                <Settings className="h-4 w-4" />
                              </button>
                            )}
                            {canEditProducts && (
                              <button
                                type="button"
                                onClick={() => setProductPendingDelete({
                                  productId: product.ProductId,
                                  productName: product.Name,
                                })}
                                className="text-red-600 hover:text-red-700"
                                title={`Delete ${product.Name}`}
                                aria-label={`Delete ${product.Name}`}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden />
                              </button>
                            )}
                            {isBundle && asaStatus?.bundleProducts && asaStatus.bundleProducts.length > 0 && (
                              <button
                                onClick={() => {
                                  setExpandedBundles(prev => {
                                    const next = new Set(prev);
                                    if (next.has(product.ProductId)) {
                                      next.delete(product.ProductId);
                                    } else {
                                      next.add(product.ProductId);
                                    }
                                    return next;
                                  });
                                }}
                                className="text-gray-400 hover:text-gray-600"
                                title={expandedBundles.has(product.ProductId) ? 'Collapse bundle' : 'Expand bundle'}
                              >
                                {expandedBundles.has(product.ProductId)
                                  ? <ChevronDown className="h-4 w-4" />
                                  : <ChevronRight className="h-4 w-4" />}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      
                      {/* Bundle Subproducts (accordion) */}
                      {isBundle && expandedBundles.has(product.ProductId) && asaStatus?.bundleProducts && asaStatus.bundleProducts.length > 0 && (
                        asaStatus.bundleProducts.map((bundleProduct) => (
                          <tr key={`${product.ProductId}-${bundleProduct.productId}`} className="bg-gray-50 hover:bg-gray-100">
                            <td className="px-6 py-3 pl-12">
                              <div className="flex items-center max-w-md">
                                <div className="h-8 w-8 flex-shrink-0">
                                  <div className="h-full w-full bg-gray-200 rounded-lg flex items-center justify-center">
                                    <Package className="h-4 w-4 text-gray-600" />
                                  </div>
                                </div>
                                <div className="ml-3 min-w-0 flex-1">
                                  <div className="text-sm font-medium text-gray-700 flex items-center">
                                    <span className="truncate">{bundleProduct.productName}</span>
                                  </div>
                                  <div className="text-xs text-gray-500 truncate">{bundleProduct.productType}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-3 whitespace-nowrap">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                                {bundleProduct.productType}
                              </span>
                            </td>
                            <td className="px-6 py-3 whitespace-nowrap">
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700">
                                Included
                              </span>
                            </td>
                            <td className="px-6 py-3 whitespace-nowrap text-sm font-medium">
                              <span className="text-gray-400">-</span>
                            </td>
                          </tr>
                        ))
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Removed Products — items the agent has deleted from this group; restorable here */}
      {canEditProducts && (
        <HiddenProductsSection
          products={hiddenWithEnrollments}
          onRestore={handleRestoreProduct}
          restoringProductId={restoringProductId}
        />
      )}

      {/* Vendor network selection — auto-saves per change. Hidden if no vendors of the group's products have networks. */}
      <VendorNetworkSelections
        selectedProducts={groupVendors.map((v) => ({ VendorId: v.VendorId, VendorName: v.VendorName }))}
        value={vendorNetworkSelections}
        onChange={setVendorNetworkSelections}
        groupId={groupId}
        autoSave={true}
      />

      {/* Enrollment Link section - Agent, TenantAdmin, SysAdmin only */}
      {showEnrollmentLinksSection && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-medium text-gray-900">Enrollment Link</h3>
            <p className="text-sm text-gray-600">
              Products shown during enrollment are automatically driven by the assigned products above.
            </p>
          </div>
          <div className="p-6">
            {templatesLoading ? (
              <div className="flex justify-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
              </div>
            ) : templates.length === 0 ? (
              <div className="text-center py-8">
                <LinkIcon className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">
                  No enrollment link template for this group yet. One will be auto-created when products are assigned.
                </p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Template row with preview + copy/open buttons */}
                {templates.map((tpl) => {
                  const isCopying = copyingTemplateId === tpl.TemplateId;
                  const isCopied = copiedTemplateId === tpl.TemplateId;
                  const isOpening = openingTemplateId === tpl.TemplateId;
                  const busy = isCopying || isOpening;
                  return (
                    <div key={tpl.TemplateId} className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center space-x-3 min-w-0">
                        <LinkIcon className="h-5 w-5 text-oe-primary flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {EnrollmentLinkTemplatesService.getDisplayTemplateName(tpl.TemplateName)}
                          </p>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            tpl.IsActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                          }`}>
                            {tpl.IsActive ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleCopyGroupLink(tpl)}
                          disabled={busy}
                          className={`inline-flex items-center justify-center min-w-[100px] px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                            isCopied || isCopying
                              ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-default'
                              : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <Copy className="h-4 w-4 mr-1 flex-shrink-0" />
                          {isCopied ? 'Copied!' : isCopying ? 'Copying…' : 'Copy Link'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleOpenGroupLink(tpl)}
                          disabled={busy}
                          className={`inline-flex items-center justify-center min-w-[100px] px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
                            isOpening
                              ? 'border-gray-200 bg-gray-50 text-gray-400 cursor-default'
                              : 'border-gray-300 text-gray-700 bg-white hover:bg-gray-50'
                          }`}
                        >
                          <ExternalLink className="h-4 w-4 mr-1 flex-shrink-0" />
                          {isOpening ? 'Opening…' : 'Open Link'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setTemplateToView(tpl)}
                          className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-oe-primary border border-oe-primary rounded-lg hover:bg-blue-50"
                        >
                          <Eye className="h-4 w-4 mr-1" />
                          Preview Enrollment
                        </button>
                      </div>
                    </div>
                  );
                })}

                {linkActionError && (
                  <p className="text-sm text-red-600">{linkActionError}</p>
                )}

                {/* Household data collection is configured in the group creation/edit wizard under Products tab */}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Product Details Modal */}
      {showProductModal && selectedProduct && (
        <ProductDetailsModal
          product={selectedProduct}
          onClose={() => {
            setShowProductModal(false);
            setSelectedProduct(null);
          }}
        />
      )}

      {/* ASA Signing Modal */}
      {showASAModal && selectedProductForASA && (
        <ASASigningModal
          isOpen={showASAModal}
          onClose={() => {
            setShowASAModal(false);
            setSelectedProductForASA(null);
          }}
          onSuccess={() => {
            // Invalidate and refetch all related queries to ensure fresh data
            queryClient.invalidateQueries({ queryKey: ['groupASAStatus', groupId] });
            queryClient.invalidateQueries({ queryKey: ['groupProducts', groupId] });
            queryClient.invalidateQueries({ queryKey: ['groupSetupStatus', groupId] });
            queryClient.invalidateQueries({ queryKey: ['productASAStatus', groupId] });
            // Also trigger refetch
            refetch();
            refetchASAStatus();
          }}
          groupId={groupId}
          productId={selectedProductForASA.productId}
          productName={selectedProductForASA.productName}
          asaAgreement={selectedProductForASA.asaAgreement}
          groupName={groupName}
        />
      )}

      {/* Deductible Configuration Modal */}
      {showDeductibleConfigModal && selectedProductForConfig && (
        <DeductibleConfigModal
          product={selectedProductForConfig}
          config={deductibleConfig}
          onConfigChange={setDeductibleConfig}
          onSave={() => {
            const productName = selectedProductForConfig.Name;
            setPendingMutation({
              description: `change deductible options for "${productName}"`,
              run: handleSaveDeductibleConfig,
            });
          }}
          onClose={() => {
            setShowDeductibleConfigModal(false);
            setSelectedProductForConfig(null);
            setDeductibleConfig({});
          }}
          saving={savingConfig}
        />
      )}

      {/* Delete product confirmation modal */}
      {productPendingDelete && (
        <DeleteProductConfirmModal
          productName={productPendingDelete.productName}
          enrollmentCount={enrollmentCountData?.count ?? null}
          isLoading={enrollmentCountLoading}
          onCancel={() => setProductPendingDelete(null)}
          onConfirm={async () => {
            const response = await GroupProductsService.toggleProductVisibility(
              groupId,
              productPendingDelete.productId,
              true /* isHidden */
            );
            setProductPendingDelete(null);
            if (response.success) {
              await refetch();
              await queryClient.invalidateQueries({
                queryKey: ['group-hidden-with-enrollments', groupId],
              });
            } else if ((response as any).message) {
              window.alert(response.message);
            }
          }}
        />
      )}

      {/* Confirmation modal — warns about in-flight enrollments before any product mutation */}
      {pendingMutation && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[110]">
          <div className="bg-white rounded-lg max-w-md w-full">
            <div className="p-6">
              <div className="flex items-start gap-3">
                <AlertCircle className="h-6 w-6 text-yellow-600 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    This will affect members currently enrolling
                  </h3>
                  <p className="mt-2 text-sm text-gray-700">
                    You're about to {pendingMutation.description}.
                  </p>
                  <p className="mt-2 text-sm text-gray-700">
                    Any member who already has an enrollment wizard open will see a
                    pricing error and have to refresh and start over. Only continue if
                    you've confirmed nobody is mid-enrollment, or you're okay
                    interrupting them.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-gray-50 rounded-b-lg">
              <button
                onClick={() => setPendingMutation(null)}
                disabled={runningMutation}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!pendingMutation) return;
                  const action = pendingMutation;
                  setRunningMutation(true);
                  try {
                    await action.run();
                  } finally {
                    setRunningMutation(false);
                    setPendingMutation(null);
                  }
                }}
                disabled={runningMutation}
                className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark disabled:opacity-50"
              >
                {runningMutation ? 'Working…' : 'Yes, change products'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Enrollment Modal — shows exactly what the enrollment wizard will pull */}
      {templateToView && (() => {
        const enrollmentProducts = groupProducts.filter((p: any) => p.IsActive && !isProductHiddenForGroup(p) && !isProductCatalogHidden(p));
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[100]">
            <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
              <div className="flex items-center justify-between p-4 border-b border-gray-200">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">Enrollment Preview</h2>
                  <p className="text-xs text-gray-500 mt-0.5">These are the products members will see when they open the enrollment link.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setTemplateToView(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <XCircle className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-gray-900">Products Available During Enrollment</h3>
                    <span className="text-xs text-gray-500">{enrollmentProducts.length} products</span>
                  </div>
                  <div className="bg-gray-50 rounded-lg divide-y divide-gray-200">
                    {enrollmentProducts.length === 0 ? (
                      <p className="p-4 text-sm text-gray-500 text-center">No active products assigned to this group.</p>
                    ) : (
                      enrollmentProducts.map((product: any) => (
                        <div key={product.ProductId} className="flex items-center space-x-3 p-3">
                          <div className="h-8 w-8 flex-shrink-0">
                            {product.ProductLogoUrl ? (
                              <img src={product.ProductLogoUrl} alt={product.Name} className="h-full w-full rounded object-contain bg-white p-0.5" />
                            ) : (
                              <div className="h-full w-full bg-blue-50 rounded flex items-center justify-center">
                                <Package className="h-4 w-4 text-oe-primary" />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900 truncate">{product.Name}</p>
                            <p className="text-xs text-gray-500">{product.ProductType}</p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="flex justify-end p-4 border-t border-gray-200">
                <button
                  type="button"
                  onClick={() => setTemplateToView(null)}
                  className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-primary-dark"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
};

// Product Details Modal Component
const ProductDetailsModal: React.FC<ProductDetailsModalProps> = ({ product, onClose }) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-900">Product Details</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XCircle className="h-6 w-6" />
            </button>
          </div>

          <div className="space-y-6">
            {/* Product Header */}
            <div className="bg-gradient-to-r from-oe-primary/10 to-oe-primary/5 p-4 rounded-lg">
              <div className="flex items-center space-x-4">
                <div className="h-16 w-16 flex-shrink-0">
                  {product.ProductLogoUrl ? (
                    <img 
                      src={product.ProductLogoUrl} 
                      alt={product.Name}
                      className="h-full w-full rounded-lg object-contain bg-white p-1"
                    />
                  ) : (
                    <div className="h-full w-full bg-white rounded-lg flex items-center justify-center">
                      <Package className="h-8 w-8 text-oe-primary" />
                    </div>
                  )}
                </div>
                <div>
                  <h3 className="text-lg font-medium text-gray-900">{product.Name}</h3>
                  <p className="text-sm text-gray-600">{product.ProductType}</p>
                </div>
              </div>
            </div>

            {/* Product Information */}
            <div>
              <h4 className="text-sm font-medium text-gray-900 mb-3">Product Information</h4>
              <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                {product.Description && (
                  <div className="flex justify-between">
                    <span className="text-gray-600">Description</span>
                    <span className="font-medium text-right max-w-xs">{product.Description}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-600">Provider</span>
                  <span className="font-medium">{product.ProductOwner}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Sales Type</span>
                  <span className="font-medium">{product.SalesType}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Age Range</span>
                  <span className="font-medium">{product.MinAge} - {product.MaxAge} years</span>
                </div>
              </div>
            </div>

            {/* States */}
            {product.AllowedStates && product.AllowedStates.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Available States</h4>
                <div className="flex flex-wrap gap-2">
                  {product.AllowedStates.map((state, index) => (
                    <span key={index} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                      <MapPin className="h-3 w-3 mr-1" />
                      {state}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Documents */}
            {hasProductDocuments(product as any) && (
              <div>
                <h4 className="text-sm font-medium text-gray-900 mb-3">Product Documents</h4>
                <ProductDocumentsLinks
                  product={product}
                  variant="button"
                  size="md"
                  label="View Product Documentation"
                />
              </div>
            )}
          </div>

          <div className="flex justify-end space-x-3 mt-8 pt-6 border-t">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-primary-dark"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Deductible Configuration Modal Component
interface DeductibleConfigModalProps {
  product: GroupProduct;
  config: Record<string, string[]>;
  onConfigChange: (config: Record<string, string[]>) => void;
  onSave: () => void;
  onClose: () => void;
  saving: boolean;
}

const getConfigKey = (field: ConfigurationField & { sourceProductId?: string }) =>
  field.sourceProductId ? `${field.sourceProductId}|${field.fieldName}` : field.fieldName;

const DeductibleConfigModal: React.FC<DeductibleConfigModalProps> = ({
  product,
  config,
  onConfigChange,
  onSave,
  onClose,
  saving
}) => {
  if (!product.DeductibleFields || product.DeductibleFields.length === 0) {
    return null;
  }

  const isOptionEnabledByProduct = (field: ConfigurationField & { productAllowedOptions?: string[] }, option: string) => {
    const allowed = field.productAllowedOptions;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(option);
  };

  const toggleOption = (configKey: string, option: string, enabledByProduct: boolean) => {
    if (!enabledByProduct) return;
    const currentOptions = config[configKey] || [];
    const newOptions = currentOptions.includes(option)
      ? currentOptions.filter(opt => opt !== option)
      : [...currentOptions, option];
    onConfigChange({ ...config, [configKey]: newOptions });
  };

  const selectAll = (configKey: string) => {
    const field = product.DeductibleFields?.find(f => getConfigKey(f as ConfigurationField & { sourceProductId?: string }) === configKey) as (ConfigurationField & { productAllowedOptions?: string[] }) | undefined;
    if (field) {
      const opts = field.fieldOptions || [];
      const toSelect = field.productAllowedOptions && field.productAllowedOptions.length > 0
        ? opts.filter(opt => field.productAllowedOptions!.includes(opt))
        : opts;
      onConfigChange({ ...config, [configKey]: [...toSelect] });
    }
  };

  const deselectAll = (configKey: string) => {
    onConfigChange({ ...config, [configKey]: [] });
  };

  const isValid = product.DeductibleFields?.every((field) => {
    const configKey = getConfigKey(field as ConfigurationField & { sourceProductId?: string });
    const selectedOptions = config[configKey] || [];
    return selectedOptions.length > 0;
  }) ?? false;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-xl font-semibold text-gray-900">Configure Deductible or UnShared Amount Options</h2>
              <p className="text-sm text-gray-600 mt-1">{product.Name}</p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
              <XCircle className="h-6 w-6" />
            </button>
          </div>

          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-800">
              Select which deductible options should be available to members during enrollment.
              Only selected options will appear in the enrollment wizard for this group.
              {product.DeductibleFields.some((f: ConfigurationField & { sourceProductName?: string }) => f.sourceProductName) && (
                <span className="block mt-1">For bundles, each product in the bundle is listed separately so options stay scoped to the right product.</span>
              )}
              {product.DeductibleFields.some((f: ConfigurationField & { productAllowedOptions?: string[] }) => f.productAllowedOptions && f.productAllowedOptions.length > 0) && (
                <span className="block mt-1">Options greyed out are disabled at the product level and cannot be enabled for this group.</span>
              )}
            </p>
          </div>

          {!isValid && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800 font-medium">
                ⚠️ At least one option must be selected for each field before saving.
              </p>
            </div>
          )}

          <div className="space-y-6">
            {product.DeductibleFields.map((field: ConfigurationField & { sourceProductId?: string; sourceProductName?: string }) => {
              const configKey = getConfigKey(field);
              const selectedOptions = config[configKey] || [];
              const allSelected = selectedOptions.length === (field.fieldOptions?.length ?? 0);
              const noneSelected = selectedOptions.length === 0;
              const hasError = noneSelected;
              const fieldLabel = field.sourceProductName ? `${field.fieldName} — ${field.sourceProductName}` : field.fieldName;

              return (
                <div key={configKey} className={`border rounded-lg p-4 ${hasError ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <h3 className="text-lg font-medium text-gray-900">{fieldLabel}</h3>
                      <p className={`text-sm ${hasError ? 'text-red-600 font-medium' : 'text-gray-600'}`}>
                        {selectedOptions.length} of {field.fieldOptions?.length ?? 0} options selected
                        {hasError && ' • At least one option is required'}
                      </p>
                    </div>
                    <div className="flex space-x-2">
                      <button
                        onClick={() => selectAll(configKey)}
                        disabled={allSelected}
                        className="px-3 py-1 text-xs font-medium text-oe-primary bg-oe-primary-light rounded hover:bg-oe-primary-light disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Select All
                      </button>
                      <button
                        onClick={() => deselectAll(configKey)}
                        disabled={noneSelected}
                        className="px-3 py-1 text-xs font-medium text-gray-600 bg-gray-50 rounded hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Deselect All
                      </button>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {(field.fieldOptions || []).map((option) => {
                      const isSelected = selectedOptions.includes(option);
                      const enabledByProduct = isOptionEnabledByProduct(field, option);
                      return (
                        <label
                          key={option}
                          className={`flex items-center p-3 border-2 rounded-lg transition-colors ${
                            !enabledByProduct
                              ? 'border-gray-200 bg-gray-100 cursor-not-allowed opacity-75'
                              : isSelected
                                ? 'border-oe-primary bg-blue-50 cursor-pointer'
                                : 'border-gray-200 bg-white hover:border-gray-300 cursor-pointer'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={!enabledByProduct}
                            onChange={() => toggleOption(configKey, option, enabledByProduct)}
                            className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded disabled:cursor-not-allowed"
                          />
                          <span className={`ml-3 text-sm font-medium ${!enabledByProduct ? 'text-gray-500' : isSelected ? 'text-blue-900' : 'text-gray-700'}`}>
                            {option}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-end space-x-3 mt-8 pt-6 border-t">
            <button
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving || !isValid}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroupProductsTab;