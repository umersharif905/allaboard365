// frontend/src/components/proposal-editor/ProposalEditor.tsx
// Component for editing proposal document templates with drag-and-drop fields

import { AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Calculator, ChevronDown, Copy, DollarSign, Image, Link as LinkIcon, Save, Square, Trash2, Type, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { v4 as uuidv4 } from 'uuid';
import { apiService } from '../../services/api.service';
import ProposalService, { ProductSlot, ProposalField } from '../../services/proposal.service';
import CalcTypeDropdown from '../proposal-editor/CalcTypeDropdown';

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface ProposalEditorProps {
  proposalDocumentId?: string;
  documentId: string;
  documentUrl: string;
  category?: string;
  onClose: () => void;
  onSave: () => void;
}

interface Product {
  productId?: string;
  ProductId?: string;
  name?: string;
  Name?: string;
  requiredDataFields?: Array<{
    fieldName: string;
    fieldOptions: string[];
  }> | string;
  RequiredDataFields?: Array<{
    fieldName: string;
    fieldOptions: string[];
  }> | string;
  availableConfigs?: string[];
  AvailableConfigs?: string[];
  isBundle?: boolean;
  IsBundle?: boolean;
  salesType?: string;
  SalesType?: string;
}

const BRAND_COLOR_PRESETS = [
  { color: '#000000', label: 'Black' },
  { color: '#FFFFFF', label: 'White' },
  { color: '#7ac943', label: 'Lime Green' },
  { color: '#254e96', label: 'Navy Blue' },
  { color: '#4a4a4a', label: 'Grey' },
];

const DEFAULT_PROPOSAL_FONT = 'Outfit';
const FONT_FAMILY_OPTIONS = ['Outfit', 'Inter', 'Arial', 'Helvetica', 'Times New Roman'] as const;

const AUTO_FILL_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'None' },
  { value: 'AgentName', label: 'Agent Name' },
  { value: 'AgentAddress', label: 'Agent Address' },
  { value: 'AgentPhone', label: 'Agent Phone' },
  { value: 'AgentEmail', label: 'Agent Email' },
  { value: 'AgencyName', label: 'Agency Name' },
  { value: 'ClientName', label: 'Client Name' },
  { value: 'ClientAddress', label: 'Client Address' },
  { value: 'TierDescription', label: 'Family Size Description' },
  { value: 'TodaysDate', label: "Today's Date" },
  { value: 'TodaysDateNumeric', label: "Today's Date (MM/DD/YYYY)" },
  { value: 'CustomText', label: 'Custom Text' },
  { value: 'GroupContributionEE', label: 'Group Contribution (EE)' },
  { value: 'GroupContributionES', label: 'Group Contribution (EE+Spouse)' },
  { value: 'GroupContributionEC', label: 'Group Contribution (EE+Child)' },
  { value: 'GroupContributionEF', label: 'Group Contribution (Family)' },
  { value: 'EmployeeCostEE', label: 'Employee Cost (EE)' },
  { value: 'EmployeeCostES', label: 'Employee Cost (EE+Spouse)' },
  { value: 'EmployeeCostEC', label: 'Employee Cost (EE+Child)' },
  { value: 'EmployeeCostEF', label: 'Employee Cost (Family)' },
];

function ColorPresetSwatches({ currentColor, onSelect }: { currentColor: string; onSelect: (color: string) => void }) {
  return (
    <div className="flex gap-1.5 mt-1.5">
      {BRAND_COLOR_PRESETS.map(({ color, label }) => (
        <button
          key={color}
          type="button"
          title={label}
          onClick={() => onSelect(color)}
          className={`w-6 h-6 rounded-full border-2 cursor-pointer transition-all ${
            currentColor?.toLowerCase() === color.toLowerCase()
              ? 'border-blue-600 ring-2 ring-blue-300'
              : 'border-gray-300 hover:border-gray-400'
          }`}
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  );
}

const ProposalEditor: React.FC<ProposalEditorProps> = ({
  proposalDocumentId,
  documentId,
  documentUrl,
  category,
  onClose,
  onSave
}) => {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageWidth] = useState<number>(800);
  const [fields, setFields] = useState<ProposalField[]>([]);
  const [selectedField, setSelectedField] = useState<ProposalField | null>(null);
  const [selectedFields, setSelectedFields] = useState<ProposalField[]>([]);
  const [clipboardFields, setClipboardFields] = useState<ProposalField[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDirection, setResizeDirection] = useState<'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticatedDocumentUrl, setAuthenticatedDocumentUrl] = useState<string>(documentUrl);
  const [pdfLoading, setPdfLoading] = useState(true); // Track PDF blob loading state
  const [localCategory, setLocalCategory] = useState<'General' | 'Business' | 'Employee'>(
    (category === 'Business' || category === 'Employee') ? category : 'General'
  );
  useEffect(() => {
    if (category === 'General' || category === 'Business' || category === 'Employee') {
      setLocalCategory(category);
    }
  }, [category]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productSlots, setProductSlots] = useState<ProductSlot[]>([]);

  const [docSettingsOpen, setDocSettingsOpen] = useState(false);
  const [fieldPlacementOpen, setFieldPlacementOpen] = useState(false);
  const [showAlignmentGuides, setShowAlignmentGuides] = useState(false);
  const [isCanvasFocused, setIsCanvasFocused] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const blobUrlRef = useRef<string | null>(null);

  const isFontSupportedFieldType = (fieldType: ProposalField['fieldType']) =>
    fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation';

  const getFieldFontFamily = (field: ProposalField) =>
    field.fontFamily || (isFontSupportedFieldType(field.fieldType) ? DEFAULT_PROPOSAL_FONT : undefined);

  const getFieldVerticalAlign = (field: ProposalField) =>
    field.verticalAlign || (isFontSupportedFieldType(field.fieldType) ? 'top' : undefined);

  const parseConfigObject = (configValue?: string): Record<string, any> | undefined => {
    if (!configValue || typeof configValue !== 'string') return undefined;
    try {
      const parsed = JSON.parse(configValue);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  const getPriceConfigValue = (field: ProposalField) => {
    if (!field.configValue) return '';
    const parsed = parseConfigObject(field.configValue);
    if (parsed && typeof parsed._priceConfig === 'string') {
      return parsed._priceConfig;
    }
    return field.configValue;
  };

  const persistImageStyleConfig = (field: ProposalField): ProposalField => {
    if (field.fieldType !== 'image') return field;
    const parsed = parseConfigObject(field.configValue) || {};
    const nextConfig: Record<string, any> = { ...parsed };
    if (field.borderColor) nextConfig.borderColor = field.borderColor; else delete nextConfig.borderColor;
    if (typeof field.borderWidth === 'number' && field.borderWidth > 0) nextConfig.borderWidth = field.borderWidth;
    else delete nextConfig.borderWidth;
    const hasConfig = Object.keys(nextConfig).length > 0;
    return { ...field, configValue: hasConfig ? JSON.stringify(nextConfig) : undefined };
  };

  const persistTextStyleConfig = (field: ProposalField): ProposalField => {
    if (!isFontSupportedFieldType(field.fieldType)) return field;

    const fontFamily = field.fontFamily || DEFAULT_PROPOSAL_FONT;
    const verticalAlign = field.verticalAlign || 'top';
    const parsed = parseConfigObject(field.configValue) || {};

    if (field.fieldType === 'calculation') {
      const calcConfig = { ...(field.calculationConfig || {}) as Record<string, any>, fontFamily, verticalAlign };
      return {
        ...field,
        fontFamily,
        verticalAlign,
        calculationConfig: calcConfig,
        configValue: JSON.stringify(calcConfig)
      };
    }

    if (field.fieldType === 'price') {
      const rawPriceConfig = typeof parsed._priceConfig === 'string'
        ? parsed._priceConfig
        : (field.configValue && !parseConfigObject(field.configValue) ? field.configValue : undefined);
      const nextConfig = { ...parsed, fontFamily, verticalAlign } as Record<string, any>;
      if (rawPriceConfig) nextConfig._priceConfig = rawPriceConfig;
      return {
        ...field,
        fontFamily,
        verticalAlign,
        configValue: JSON.stringify(nextConfig)
      };
    }

    return {
      ...field,
      fontFamily,
      verticalAlign,
      configValue: JSON.stringify({ ...parsed, fontFamily, verticalAlign })
    };
  };

  const isSameField = useCallback((a: ProposalField, b: ProposalField) => {
    if (a.fieldId && b.fieldId) return a.fieldId === b.fieldId;
    return a === b;
  }, []);

  const replaceField = useCallback((oldField: ProposalField, updatedField: ProposalField) => {
    setFields(prev => prev.map(f => (isSameField(f, oldField) ? updatedField : f)));
  }, [isSameField]);

  const removeField = useCallback((fieldToRemove: ProposalField) => {
    setFields(prev => prev.filter(f => !isSameField(f, fieldToRemove)));
  }, [isSameField]);

  // Load products for price field selection (all available products for the tenant)
  useEffect(() => {
    loadProducts();
  }, []);

  // Load existing template and get authenticated document URL
  useEffect(() => {
    if (proposalDocumentId) {
      loadTemplate();
    } else {
      setLoading(false);
    }
    loadAuthenticatedUrl();
    
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [proposalDocumentId, documentId]);

  const loadProducts = async () => {
    try {
      setLoadingProducts(true);
      // Use the dedicated proposal-documents products endpoint
      // Load all available products for the tenant (not filtered by product/bundle)
      const endpoint = '/api/proposal-documents/products';
      
      const response: any = await apiService.get(endpoint);
      let productData: any[] = [];
      
      if (response.success && response.data) {
        productData = response.data;
      } else if (Array.isArray(response)) {
        productData = response;
      }
      
      // Transform products to ensure consistent field names
      // The new endpoint already returns RequiredDataFields and AvailableConfigs
      const transformedProducts = productData.map((p: any) => {
        const transformed: any = {
          productId: p.productId || p.ProductId,
          name: p.name || p.Name || 'Unnamed Product',
          requiredDataFields: p.requiredDataFields || p.RequiredDataFields || [],
          availableConfigs: p.availableConfigs || p.AvailableConfigs || [],
          isBundle: p.isBundle || p.IsBundle || false,
          salesType: p.salesType || p.SalesType || undefined
        };
        // Keep both PascalCase and camelCase for compatibility
        if (p.ProductId && !p.productId) {
          transformed.ProductId = p.ProductId;
        }
        if (p.Name && !p.name) {
          transformed.Name = p.Name;
        }
        if (p.RequiredDataFields && !p.requiredDataFields) {
          transformed.RequiredDataFields = p.RequiredDataFields;
        }
        if (p.AvailableConfigs && !p.availableConfigs) {
          transformed.AvailableConfigs = p.AvailableConfigs;
        }
        if (p.SalesType && !p.salesType) {
          transformed.SalesType = p.SalesType;
        }
        return transformed;
      });
      
      setProducts(transformedProducts);
    } catch (err: any) {
      console.error('Error loading products:', err);
    } finally {
      setLoadingProducts(false);
    }
  };

  const loadAuthenticatedUrl = async () => {
    try {
      setPdfLoading(true);
      setError(null);
      
      // Always fetch PDF as blob through authenticated API to avoid CORS/auth issues
      if (!documentId) {
        setError('No PDF file selected. Please ensure the document was uploaded correctly.');
        setPdfLoading(false);
        return;
      }
      
      const blob = await apiService.get<Blob>(
        `/api/proposal-documents/documents/${documentId}/proxy`,
        { responseType: 'blob' }
      );
      
      // Create object URL from blob
      const blobUrl = URL.createObjectURL(blob);
      
      // Cleanup previous blob URL if exists
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
      
      blobUrlRef.current = blobUrl;
      setAuthenticatedDocumentUrl(blobUrl);
      setPdfLoading(false);
    } catch (err: any) {
      console.error('Could not load PDF:', err);
      setError(err.message || 'Failed to load PDF document');
      setPdfLoading(false);
      // Fallback to original URL if available
      if (documentUrl) {
        setAuthenticatedDocumentUrl(documentUrl);
      }
    }
  };

  const loadTemplate = async () => {
    if (!proposalDocumentId) return;
    
    try {
      setLoading(true);
      const response = await ProposalService.getProposalDocument(proposalDocumentId);
      
      if (response.success && response.data) {
        // Fields are already transformed by ProposalService.transformProposalDocument
        // So they should already be in camelCase with fontSize and isBold
        const loadedFields: ProposalField[] = (response.data.fields || []).map((field: ProposalField) => {
          const fieldType = field.fieldType;
          const imageShape = field.imageShape || (fieldType === 'image' ? 'square' : undefined);
          let width = field.width;
          let height = field.height;
          
          // For image fields with circle or square shape, ensure 1:1 aspect ratio
          if (fieldType === 'image' && (imageShape === 'circle' || imageShape === 'square')) {
            const size = Math.max(width, height);
            width = size;
            height = size;
          }
          
          // Fields are already transformed, just use them directly
          // But we need to handle image shape resizing and defaults for fontSize/isBold
          return {
            ...field,
            fieldType,
            width,
            height,
            imageShape,
            // Ensure fontSize defaults to 12 for text/price fields if not set
            fontSize: field.fontSize !== undefined && field.fontSize !== null 
              ? field.fontSize 
              : (fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? 12 : undefined),
            // Ensure isBold defaults to false if not set
            isBold: field.isBold !== undefined && field.isBold !== null 
              ? Boolean(field.isBold) 
              : false,
            verticalAlign: field.verticalAlign || (fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation'
              ? 'top'
              : undefined),
            fontFamily: field.fontFamily || (fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation'
              ? DEFAULT_PROPOSAL_FONT
              : undefined)
          };
        });
        setFields(loadedFields);
        
        // Load product slots
        if (response.data.productSlots && Array.isArray(response.data.productSlots)) {
          setProductSlots(response.data.productSlots);
        }
        
      }
    } catch (err: any) {
      console.error('Error loading template:', err);
      setError(err.message || 'Failed to load template');
    } finally {
      setLoading(false);
    }
  };

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const addNewField = (fieldType: ProposalField['fieldType'] = 'text') => {
    // For image fields, start with square dimensions (1:1 aspect ratio)
    const isImage = fieldType === 'image';
    const defaultSize = isImage ? 0.15 : 0.2; // Square size for images
    
    const newField: ProposalField = {
      fieldId: uuidv4().toUpperCase(),
      fieldType,
      xPosition: 0.4,
      yPosition: 0.5,
      width: defaultSize,
      height: isImage ? defaultSize : 0.05, // Square for images (same width and height), rectangle for others
      pageNumber: currentPage,
      autoFillType: fieldType === 'text' ? 'AgentName' : (fieldType === 'image' ? 'AgentPhoto' : undefined),
      textColor: fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? '#000000' : undefined,
      backgroundColor: fieldType === 'whitespace' ? '#FFFFFF' : (fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? '#FFFFFF' : undefined),
      fillBackground: fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? true : (fieldType === 'whitespace' ? true : false),
      imageShape: fieldType === 'image' ? 'square' : undefined,
      fontSize: fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? 12 : undefined,
      verticalAlign: fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? 'top' : undefined,
      fontFamily: fieldType === 'text' || fieldType === 'price' || fieldType === 'custom' || fieldType === 'calculation' ? DEFAULT_PROPOSAL_FONT : undefined,
      isBold: false,
      // productId is no longer defaulted - user selects product for each price field
      linkType: fieldType === 'link' ? 'static_url' : undefined, // Default to static_url for link fields
      customLabel: fieldType === 'custom' ? '' : undefined, // Initialize custom label for custom fields
      customFieldId: fieldType === 'custom' ? uuidv4().toUpperCase() : undefined // Generate unique ID for new custom fields
    };

    // Ensure image fields are exactly square (1:1 ratio)
    if (isImage) {
      newField.width = defaultSize;
      newField.height = defaultSize; // Force exact same value
    }

    setFields(prev => [...prev, newField]);
    setSelectedField(newField);
    setSelectedFields([]);
  };

  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDragging || isResizing) return;

    const target = e.target as HTMLElement;
    if (target.closest('.absolute.border-2')) return;

    // If there's any selection, clicking empty canvas clears it
    if (selectedField || selectedFields.length > 0) {
      setSelectedField(null);
      setSelectedFields([]);
      return;
    }

    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;

    const newField: ProposalField = {
      fieldId: uuidv4().toUpperCase(),
      fieldType: 'text',
      xPosition: Math.max(0, Math.min(1, x - 0.1)),
      yPosition: Math.max(0, Math.min(1, y - 0.05)),
      width: 0.2,
      height: 0.05,
      pageNumber: currentPage,
      autoFillType: 'AgentName',
      textColor: '#000000',
      backgroundColor: '#FFFFFF',
      fillBackground: true,
      fontSize: 12,
      isBold: false
    };

    setFields(prev => [...prev, newField]);
    setSelectedField(newField);
    setSelectedFields([]);
  };

  const handleFieldMouseDown = (e: React.MouseEvent, field: ProposalField) => {
    e.stopPropagation();

    if (e.shiftKey) {
      // Shift+click: toggle field in multi-selection
      setSelectedFields(prev => {
        const isAlreadySelected = prev.some(f => isSameField(f, field));
        let next: ProposalField[];
        if (isAlreadySelected) {
          next = prev.filter(f => !isSameField(f, field));
        } else {
          // If there's a single selectedField not yet in the array, include it
          const base = prev.length === 0 && selectedField && !isSameField(selectedField, field)
            ? [selectedField]
            : prev;
          next = [...base, field];
        }
        // Keep selectedField in sync: use first item or null
        if (next.length === 1) {
          setSelectedField(next[0]);
        } else if (next.length === 0) {
          setSelectedField(null);
        } else {
          // Multi-select: keep selectedField as the most recently shift-clicked
          setSelectedField(field);
        }
        return next;
      });
      // Don't start dragging on shift+click
      return;
    }

    // Normal click: single-select
    setSelectedField(field);
    setSelectedFields([]);
    setIsDragging(true);

    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const fieldX = field.xPosition * rect.width;
    const fieldY = (1 - field.yPosition) * rect.height;
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    setDragOffset({
      x: mouseX - fieldX,
      y: mouseY - fieldY
    });
  };

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging || !selectedField || !pageRef.current) return;

    const rect = pageRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - dragOffset.x) / rect.width;
    const y = 1 - (e.clientY - rect.top - dragOffset.y) / rect.height;

    const updatedField = {
      ...selectedField,
      xPosition: Math.max(0, Math.min(1, x)),
      yPosition: Math.max(0, Math.min(1, y))
    };

    setFields(prev => prev.map(f => (isSameField(f, selectedField) ? updatedField : f)));
    setSelectedField(updatedField);
  }, [isDragging, selectedField, dragOffset, isSameField]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const handleResizeStart = (field: ProposalField, direction: 'nw' | 'ne' | 'sw' | 'se', e: React.MouseEvent) => {
    e.stopPropagation();
    setIsResizing(true);
    setResizeDirection(direction);
    setSelectedField(field);
    
    if (pageRef.current) {
      setResizeStart({
        x: field.xPosition,
        y: field.yPosition,
        width: field.width,
        height: field.height
      });
    }
  };

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing || !selectedField || !resizeDirection || !pageRef.current) return;

    const pageRect = pageRef.current.getBoundingClientRect();
    const pageWidth = pageRect.width;
    const pageHeight = pageRect.height;

    const mouseX = (e.clientX - pageRect.left) / pageWidth;
    const mouseY = 1 - ((e.clientY - pageRect.top) / pageHeight);

    const startLeft = resizeStart.x;
    const startBottom = resizeStart.y;
    const startRight = startLeft + resizeStart.width;
    const startTop = startBottom + resizeStart.height;

    // Check if this field should maintain 1:1 aspect ratio (circle or square image)
    const isSquareOrCircle = selectedField.fieldType === 'image' && 
                             (selectedField.imageShape === 'circle' || selectedField.imageShape === 'square');

    let newX = startLeft;
    let newY = startBottom;
    let newWidth = resizeStart.width;
    let newHeight = resizeStart.height;

    // Calculate raw dimensions based on mouse position
    let rawWidth = 0;
    let rawHeight = 0;

    if (resizeDirection === 'se') {
      // Bottom-right corner: mouse moves right and up (in normalized coords, up means smaller Y)
      rawWidth = mouseX - startLeft;
      rawHeight = startTop - mouseY; // mouseY is smaller when mouse is higher
      newX = startLeft;
      newY = startTop - newHeight;
    } else if (resizeDirection === 'sw') {
      // Bottom-left corner: mouse moves left and up
      rawWidth = startRight - mouseX;
      rawHeight = startTop - mouseY;
      newX = startRight - newWidth;
      newY = startTop - newHeight;
    } else if (resizeDirection === 'ne') {
      // Top-right corner: mouse moves right and down
      rawWidth = mouseX - startLeft;
      rawHeight = mouseY - startBottom;
      newX = startLeft;
      newY = startBottom;
    } else if (resizeDirection === 'nw') {
      // Top-left corner: mouse moves left and down
      rawWidth = startRight - mouseX;
      rawHeight = mouseY - startBottom;
      newX = startRight - newWidth;
      newY = startBottom;
    }

    // For square/circle, use the larger dimension to maintain 1:1 aspect ratio
    if (isSquareOrCircle) {
      const size = Math.max(Math.abs(rawWidth), Math.abs(rawHeight));
      newWidth = Math.max(0.01, Math.min(1, size));
      newHeight = newWidth; // Force 1:1
      
      // Recalculate position based on resize direction
      if (resizeDirection === 'se') {
        // Keep bottom-left corner fixed
        newX = startLeft;
        newY = startTop - newHeight;
      } else if (resizeDirection === 'sw') {
        // Keep bottom-right corner fixed
        newX = startRight - newWidth;
        newY = startTop - newHeight;
      } else if (resizeDirection === 'ne') {
        // Keep top-left corner fixed
        newX = startLeft;
        newY = startBottom;
      } else if (resizeDirection === 'nw') {
        // Keep top-right corner fixed
        newX = startRight - newWidth;
        newY = startBottom;
      }
    } else {
      // For non-square/circle fields, use raw dimensions
      newWidth = Math.max(0.01, Math.min(1 - startLeft, Math.abs(rawWidth)));
      newHeight = Math.max(0.01, Math.min(1 - startBottom, Math.abs(rawHeight)));
      
      // Recalculate position based on resize direction
      if (resizeDirection === 'se') {
        newX = startLeft;
        newY = startTop - newHeight;
      } else if (resizeDirection === 'sw') {
        newX = startRight - newWidth;
        newY = startTop - newHeight;
      } else if (resizeDirection === 'ne') {
        newX = startLeft;
        newY = startBottom;
      } else if (resizeDirection === 'nw') {
        newX = startRight - newWidth;
        newY = startBottom;
      }
    }

    // Ensure field stays within bounds
    newX = Math.max(0, Math.min(1 - newWidth, newX));
    newY = Math.max(0, Math.min(1 - newHeight, newY));

    // For square/circle images, ensure stored values are exactly equal
    if (isSquareOrCircle) {
      // Use the exact same value for both width and height
      const finalSize = newWidth; // Already calculated as equal
      newWidth = finalSize;
      newHeight = finalSize;
    }

    const updatedField = {
      ...selectedField,
      width: newWidth,
      height: newHeight,
      xPosition: newX,
      yPosition: newY
    };

    setFields(prev => prev.map(f => (isSameField(f, selectedField) ? updatedField : f)));
    setSelectedField(updatedField);
  }, [isResizing, selectedField, resizeDirection, resizeStart, isSameField]);

  const handleResizeEnd = useCallback(() => {
    // Normalize dimensions for circle/square images after resize
    if (selectedField && selectedField.fieldType === 'image' && 
        (selectedField.imageShape === 'circle' || selectedField.imageShape === 'square')) {
      const size = Math.max(selectedField.width, selectedField.height);
      if (selectedField.width !== size || selectedField.height !== size) {
        const updated = {
          ...selectedField,
          width: size,
          height: size
        };
        setFields(prev => prev.map(f => (isSameField(f, selectedField) ? updated : f)));
        setSelectedField(updated);
      }
    }
    setIsResizing(false);
    setResizeDirection(null);
  }, [selectedField, isSameField]);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', handleResizeMove);
      window.addEventListener('mouseup', handleResizeEnd);
      return () => {
        window.removeEventListener('mousemove', handleResizeMove);
        window.removeEventListener('mouseup', handleResizeEnd);
      };
    }
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  // Normalize dimensions for circle/square image fields when selected
  useEffect(() => {
    if (!selectedField) return;
    
    if (selectedField.fieldType === 'image' && 
        (selectedField.imageShape === 'circle' || selectedField.imageShape === 'square')) {
      const size = Math.max(selectedField.width, selectedField.height);
      // Only update if dimensions are not equal (with small tolerance for floating point)
      if (Math.abs(selectedField.width - selectedField.height) > 0.0001) {
        const updated = {
          ...selectedField,
          width: size,
          height: size
        };
        setFields(prev => prev.map(f => (isSameField(f, selectedField) ? updated : f)));
        setSelectedField(updated);
      }
    }
  }, [selectedField, isSameField]);

  const handleDuplicateField = (field: ProposalField) => {
    // Duplicate either multi-selected fields or the single given field
    const fieldsToDuplicate = selectedFields.length > 1 ? selectedFields : [field];
    const offset = 0.025;

    const duplicatedFields: ProposalField[] = fieldsToDuplicate.map(f => {
      const isCalculation = f.fieldType === 'calculation';
      return {
        ...f,
        fieldId: uuidv4().toUpperCase(),
        xPosition: Math.min(0.95, f.xPosition + offset),
        yPosition: Math.max(0.05, f.yPosition - offset),
        fieldName: isCalculation ? f.fieldName : (f.fieldName ? `${f.fieldName} (Copy)` : undefined)
      };
    });

    setFields(prev => [...prev, ...duplicatedFields]);

    // Select the duplicated field(s)
    if (duplicatedFields.length === 1) {
      setSelectedField(duplicatedFields[0]);
      setSelectedFields([]);
    } else {
      setSelectedField(duplicatedFields[0]);
      setSelectedFields(duplicatedFields);
    }
  };

  const handleDeleteField = (field: ProposalField) => {
    // Delete either multi-selected fields or the single given field
    if (selectedFields.length > 1) {
      setFields(prev => prev.filter(f => !selectedFields.some(d => isSameField(f, d))));
    } else {
      removeField(field);
    }
    setSelectedField(null);
    setSelectedFields([]);
  };

  const getFieldDisplayBounds = useCallback((field: ProposalField) => {
    const isSquareOrCircle = field.fieldType === 'image' && (field.imageShape === 'circle' || field.imageShape === 'square');
    const displaySize = isSquareOrCircle ? Math.max(field.width, field.height) : undefined;
    const width = isSquareOrCircle ? displaySize! : field.width;
    const height = isSquareOrCircle ? displaySize! : field.height;

    const left = Math.max(0, Math.min(1, field.xPosition));
    const bottom = Math.max(0, Math.min(1, field.yPosition));
    const right = Math.max(0, Math.min(1, left + width));
    const top = Math.max(0, Math.min(1, bottom + height));

    return { left, bottom, right, top, width, height };
  }, []);

  const nudgeSelectedField = useCallback((deltaXPx: number, deltaYPx: number) => {
    if (!pageRef.current) return false;

    const fieldsToNudge = selectedFields.length > 1 ? selectedFields : (selectedField ? [selectedField] : []);
    if (fieldsToNudge.length === 0) return false;

    const rect = pageRef.current.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;

    const deltaX = deltaXPx / rect.width;
    const deltaY = deltaYPx / rect.height;

    const updatedMap = new Map<string, ProposalField>();
    for (const f of fieldsToNudge) {
      const bounds = getFieldDisplayBounds(f);
      const updated = {
        ...f,
        xPosition: Math.max(0, Math.min(1 - bounds.width, f.xPosition + deltaX)),
        yPosition: Math.max(0, Math.min(1 - bounds.height, f.yPosition + deltaY))
      };
      const key = f.fieldId || `${f.fieldType}-${f.xPosition}-${f.yPosition}`;
      updatedMap.set(key, updated);
    }

    setFields(prev => prev.map(f => {
      const key = f.fieldId || `${f.fieldType}-${f.xPosition}-${f.yPosition}`;
      return updatedMap.get(key) || f;
    }));

    if (selectedFields.length > 1) {
      setSelectedFields(fieldsToNudge.map(f => {
        const key = f.fieldId || `${f.fieldType}-${f.xPosition}-${f.yPosition}`;
        return updatedMap.get(key) || f;
      }));
      // Keep selectedField in sync
      if (selectedField) {
        const key = selectedField.fieldId || `${selectedField.fieldType}-${selectedField.xPosition}-${selectedField.yPosition}`;
        setSelectedField(updatedMap.get(key) || selectedField);
      }
    } else if (selectedField) {
      const key = selectedField.fieldId || `${selectedField.fieldType}-${selectedField.xPosition}-${selectedField.yPosition}`;
      const updated = updatedMap.get(key) || selectedField;
      setSelectedField(updated);
    }

    return true;
  }, [selectedField, selectedFields, getFieldDisplayBounds]);

  const handleCanvasKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const hasSelection = selectedField || selectedFields.length > 0;
    if (!hasSelection) return;

    let handled = false;

    // Arrow key nudging (works for single and multi-select)
    if (event.key === 'ArrowUp') {
      handled = nudgeSelectedField(0, 1);
    } else if (event.key === 'ArrowDown') {
      handled = nudgeSelectedField(0, -1);
    } else if (event.key === 'ArrowLeft') {
      handled = nudgeSelectedField(-1, 0);
    } else if (event.key === 'ArrowRight') {
      handled = nudgeSelectedField(1, 0);
    }

    // Copy (Ctrl+C / Cmd+C)
    if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
      const fieldsToCopy = selectedFields.length > 1 ? selectedFields : (selectedField ? [selectedField] : []);
      if (fieldsToCopy.length > 0) {
        setClipboardFields(fieldsToCopy.map(f => ({ ...f })));
        handled = true;
      }
    }

    // Paste (Ctrl+V / Cmd+V)
    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      if (clipboardFields.length > 0) {
        const pasteOffset = 0.02;
        const pastedFields: ProposalField[] = clipboardFields.map(f => {
          const isCalculation = f.fieldType === 'calculation';
          return {
            ...f,
            fieldId: uuidv4().toUpperCase(),
            xPosition: Math.min(0.95, f.xPosition + pasteOffset),
            yPosition: Math.max(0.05, f.yPosition - pasteOffset),
            pageNumber: currentPage,
            fieldName: isCalculation ? f.fieldName : (f.fieldName ? `${f.fieldName} (Copy)` : undefined)
          };
        });
        setFields(prev => [...prev, ...pastedFields]);
        // Select the pasted fields
        if (pastedFields.length === 1) {
          setSelectedField(pastedFields[0]);
          setSelectedFields([]);
        } else {
          setSelectedField(pastedFields[0]);
          setSelectedFields(pastedFields);
        }
        handled = true;
      }
    }

    // Delete / Backspace — only if not typing in an input
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const active = document.activeElement;
      const isTyping = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
      if (!isTyping) {
        const fieldsToDelete = selectedFields.length > 1 ? selectedFields : (selectedField ? [selectedField] : []);
        if (fieldsToDelete.length > 0) {
          setFields(prev => prev.filter(f => !fieldsToDelete.some(d => isSameField(f, d))));
          setSelectedField(null);
          setSelectedFields([]);
          handled = true;
        }
      }
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [selectedField, selectedFields, nudgeSelectedField, clipboardFields, currentPage, isSameField]);

  const visibleFields = fields.filter(field => field.pageNumber === currentPage || field.repeatOnAllPages);

  const alignmentGuides = showAlignmentGuides
    ? visibleFields.flatMap(field => {
      const bounds = getFieldDisplayBounds(field);
      return [
        { id: `${field.fieldId || `${field.fieldType}-${bounds.left}-${bounds.bottom}`}-left`, orientation: 'vertical' as const, position: bounds.left },
        { id: `${field.fieldId || `${field.fieldType}-${bounds.left}-${bounds.bottom}`}-right`, orientation: 'vertical' as const, position: bounds.right },
        { id: `${field.fieldId || `${field.fieldType}-${bounds.left}-${bounds.bottom}`}-top`, orientation: 'horizontal' as const, position: bounds.top },
        { id: `${field.fieldId || `${field.fieldType}-${bounds.left}-${bounds.bottom}`}-bottom`, orientation: 'horizontal' as const, position: bounds.bottom }
      ];
    })
    : [];

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Auto-initialize productSlot for pricing-related calculation fields that don't have one set.
      // This ensures existing templates saved before multi-slot support get proper slot assignments.
      const PRICING_CALC_TYPES = new Set([
        // calc* keys that depend on product slot pricing
        'calcMwTierPrice_EE', 'calcMwTierPrice_E1', 'calcMwTierPrice_EC', 'calcMwTierPrice_EF',
        'calcMwTierCost_EE', 'calcMwTierCost_E1', 'calcMwTierCost_EC', 'calcMwTierCost_EF',
        'calcMwTotalMonthly', 'calcMwTotalYearly',
        'calcUnsharedAmountDisplay',
        'calcEmployerContrib_EE', 'calcEmployerContrib_E1', 'calcEmployerContrib_EC', 'calcEmployerContrib_EF',
        'calcEmployeeCost_EE', 'calcEmployeeCost_E1', 'calcEmployeeCost_EC', 'calcEmployeeCost_EF',
        'calcTotalEmployerMwMonthly', 'calcTotalEmployerMwYearly',
        'calcTotalEmployeeCostMonthly',
        'calcTotalEmployeeCostYearly',
        'calcAvgEmployeeCostMonthly', 'calcAvgEmployeeCostYearly',
        'calcAvgEmployeeCostChangeMonthly', 'calcAvgEmployeeCostChangeYearly',
        'calcNetCostChangeMonthly', 'calcNetCostChangeYearly',
        'calcNetCostChangeMonthly_generic', 'calcNetCostChangeYearly_generic',
        'calcSavingsMonthly', 'calcSavingsYearly',
        'calcOverallSavingsYearly_partial_beforeContrib',
        'calcSavingsMonthly_generic', 'calcSavingsYearly_generic',
        'calcHeadlineGenericQuote',
        'calcStepTierCost_EE', 'calcStepTierCost_E1', 'calcStepTierCost_EC', 'calcStepTierCost_EF',
        'calcStepTotalCost',
        'calcEmployerContribDisplay_EE', 'calcEmployerContribDisplay_E1', 'calcEmployerContribDisplay_EC', 'calcEmployerContribDisplay_EF',
        'calcEmployerSharePct_EE', 'calcEmployerSharePct_E1', 'calcEmployerSharePct_EC', 'calcEmployerSharePct_EF',
        'calcEmployeeSharePct_EE', 'calcEmployeeSharePct_E1', 'calcEmployeeSharePct_EC', 'calcEmployeeSharePct_EF',
        'calcEmployeeMonthlyCost_EE', 'calcEmployeeMonthlyCost_E1', 'calcEmployeeMonthlyCost_EC', 'calcEmployeeMonthlyCost_EF',
        'calcEmployeeAnnualCost_EE', 'calcEmployeeAnnualCost_E1', 'calcEmployeeAnnualCost_EC', 'calcEmployeeAnnualCost_EF',
        'calcEmployerAnnualContrib_EE', 'calcEmployerAnnualContrib_E1', 'calcEmployerAnnualContrib_EC', 'calcEmployerAnnualContrib_EF',
        'calcEmployeeSavingsMonthly_EE', 'calcEmployeeSavingsMonthly_E1', 'calcEmployeeSavingsMonthly_EC', 'calcEmployeeSavingsMonthly_EF',
        'calcEmployeeSavingsYearly_EE', 'calcEmployeeSavingsYearly_E1', 'calcEmployeeSavingsYearly_EC', 'calcEmployeeSavingsYearly_EF',
      ]);
      let fieldsToSave = fields;
      if (productSlots.length > 0) {
        let anyAutoInitialized = false;
        fieldsToSave = fields.map(f => {
          if (f.fieldType === 'calculation' && f.calculationType && PRICING_CALC_TYPES.has(f.calculationType) && !f.calculationConfig?.productSlot) {
            const config = { ...(f.calculationConfig || {}), productSlot: 1 };
            anyAutoInitialized = true;
            return { ...f, calculationConfig: config, configValue: JSON.stringify(config) };
          }
          return f;
        });
        // Update in-memory state so UI reflects the auto-initialized product slots
        if (anyAutoInitialized) {
          setFields(fieldsToSave);
        }
      }

      // Persist font family selections in ConfigValue JSON so backend rendering can use them.
      fieldsToSave = fieldsToSave.map(persistTextStyleConfig);
      fieldsToSave = fieldsToSave.map(persistImageStyleConfig);

      if (proposalDocumentId) {
        // Update existing
        const response = await ProposalService.updateProposalDocument({
          proposalDocumentId,
          fields: fieldsToSave,
          productSlots,
          category: localCategory
        });

        if (response.success) {
          onSave();
        } else {
          setError('Failed to save template');
        }
      } else {
        // This shouldn't happen - we need a proposalDocumentId to save fields
        setError('Cannot save: Proposal document not found');
      }
    } catch (err: any) {
      console.error('Error saving template:', err);
      setError(err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const getFieldIcon = (fieldType: ProposalField['fieldType']) => {
    switch (fieldType) {
      case 'text':
        return <Type className="h-4 w-4" />;
      case 'image':
        return <Image className="h-4 w-4" />;
      case 'price':
        return <DollarSign className="h-4 w-4" />;
      case 'whitespace':
        return <Square className="h-4 w-4" />;
      case 'link':
        return <LinkIcon className="h-4 w-4" />;
      case 'custom':
        return <Type className="h-4 w-4" />;
      case 'calculation':
        return <Calculator className="h-4 w-4" />;
    }
  };

  const getPlaceholderText = (field: ProposalField): string => {
    if (field.fieldType === 'price') {
      // Always show "$Price" - the actual calculated price will be filled in when generating the document
      // Configuration values just determine which price to calculate, but the placeholder stays generic
      return '$Price';
    }
    
    if (field.fieldType === 'link') {
      // Show link type or URL for link fields
      if (field.linkType === 'static_url' && field.linkUrl) {
        return `🔗 ${field.linkUrl}`;
      } else if (field.linkType === 'enrollment_link') {
        return '🔗 Enrollment Link';
      } else if (field.linkType === 'dynamic_url') {
        return '🔗 Custom URL';
      }
      return '🔗 Link';
    }
    
    if (field.fieldType === 'custom') {
      // Show custom label or placeholder
      return field.customLabel || 'Custom Field';
    }
    
    if (field.fieldType === 'calculation') {
      // Show calculation type label
      if (field.calculationType) {
        const typeLabels: Record<string, string> = {
          'total_monthly': 'Total Monthly',
          'total_yearly': 'Total Yearly',
          'tier_monthly': `Family Size Monthly (${field.calculationConfig?.tier || 'EE'})`,
          'tier_yearly': `Family Size Yearly (${field.calculationConfig?.tier || 'EE'})`,
          'total_employee_count': 'Total Employees',
          'percentage': `% ${field.calculationConfig?.tier || 'EE'}`,
          // Business proposal calc* labels
          'calcTotalMwEnrollees': 'MW Total Enrollees',
          'calcTierMixPct_EE': 'Tier Mix % (EE)',
          'calcTierMixPct_E1': 'Tier Mix % (E1)',
          'calcTierMixPct_EF': 'Tier Mix % (EF)',
          'calcMwEnrollmentPct': 'MW Enrollment %',
          'calcCurrentEnrollmentPct': 'Current Enrollment %',
          'calcNotEnrolledCount': 'Not Enrolled Count',
          'calcMwTierPrice_EE': 'MW Price (EE)',
          'calcMwTierPrice_E1': 'MW Price (E1)',
          'calcMwTierPrice_EF': 'MW Price (EF)',
          'calcMwTierCost_EE': 'MW Cost (EE)',
          'calcMwTierCost_E1': 'MW Cost (E1)',
          'calcMwTierCost_EF': 'MW Cost (EF)',
          'calcMwTotalMonthly': 'MW Total Monthly',
          'calcMwTotalYearly': 'MW Total Yearly',
          'calcUnsharedAmountDisplay': 'Unshared Amount',
          'calcEmployerContrib_EE': 'Employer Contrib (EE)',
          'calcEmployerContrib_E1': 'Employer Contrib (E1)',
          'calcEmployerContrib_EF': 'Employer Contrib (EF)',
          'calcEmployeeCost_EE': 'Employee Cost (EE)',
          'calcEmployeeCost_E1': 'Employee Cost (E1)',
          'calcEmployeeCost_EF': 'Employee Cost (EF)',
          'calcTotalEmployerMwMonthly': 'Employer Total Monthly',
          'calcTotalEmployerMwYearly': 'Employer Total Yearly',
          'calcTotalEmployeeCostMonthly': 'Employee Total Monthly',
          'calcCurrentPremiumYearly': 'Current Premium Yearly',
          'calcHeadlinePartialSwitch': 'Headline (Partial Switch)',
          'calcHeadlineGenericQuote': 'Headline (Generic Quote)',
          'calcEnrollmentDatesDisplay': 'Enrollment Dates',
          'combinedPrice': '$Combined',
        };
        return typeLabels[field.calculationType] || field.calculationType || 'Calculation';
      }
      return 'Calculation';
    }
    
    if (field.autoFillType) {
      switch (field.autoFillType) {
        case 'AgentName':
          return 'Agent Name';
        case 'AgentAddress':
          return 'Agent Address';
        case 'AgentPhone':
          return 'Agent Phone';
        case 'AgentEmail':
          return 'Agent Email';
        case 'AgentPhoto':
          return '[Agent Photo]';
        case 'AgencyName':
          return 'Agency Name';
        case 'ClientName':
          return 'Client Name';
        case 'ClientAddress':
          return 'Client Address';
        case 'TierDescription':
          return 'Family Size Description';
        case 'TodaysDate':
          return "Today's Date";
        case 'TodaysDateNumeric':
          return "Today's Date (MM/DD/YYYY)";
        case 'CustomText':
          return field.fieldName || 'Custom Text';
        default:
          return '';
      }
    }
    
    if (field.fieldName) {
      return field.fieldName;
    }
    
    return field.fieldType;
  };

  const getSelectedProduct = () => {
    if (!selectedField?.productId) return null;
    return products.find(p => (p.productId || p.ProductId) === selectedField.productId);
  };

  const getSalesTypeLabel = (product: Product): string => {
    const rawSalesType = (product.salesType || product.SalesType || '').toString().trim();
    if (!rawSalesType) return '';

    const normalized = rawSalesType.toLowerCase();
    if (normalized === 'both') return 'Group & Individual';
    if (normalized === 'group') return 'Group';
    if (normalized === 'individual') return 'Individual';

    return rawSalesType;
  };

  const getProductDisplayLabel = (product: Product, format: 'paren' | 'dash' = 'paren'): string => {
    const productName = product.name || product.Name || 'Unnamed Product';
    const isBundle = product.isBundle || product.IsBundle || false;
    const salesTypeLabel = getSalesTypeLabel(product);

    const parts: string[] = [];
    if (isBundle) {
      parts.push('Bundle');
    }
    if (salesTypeLabel) {
      parts.push(salesTypeLabel);
    }
    if (parts.length === 0) {
      return productName;
    }

    return format === 'dash'
      ? `${productName} - ${parts.join(' | ')}`
      : `${productName} (${parts.join(', ')})`;
  };

  const getConfigOptions = () => {
    const product = getSelectedProduct();
    if (!product) {
      return [];
    }
    
    // If the selected product is a bundle, get config options from included products
    const isBundle = product.isBundle || product.IsBundle;
    if (isBundle) {
      // Get all included products (sub-products) from the products list
      // When bundleProductId is provided, included products are loaded after the bundle
      const bundleProductId = product.productId || product.ProductId;
      const includedProducts = products.filter(p => {
        const pId = p.productId || p.ProductId;
        return pId !== bundleProductId; // All products except the bundle itself
      });
      
      // Aggregate config options from all included products
      let allConfigOptions: string[] = [];
      
      includedProducts.forEach(includedProduct => {
        let requiredDataFields: any[] = [];
        if (includedProduct.requiredDataFields || includedProduct.RequiredDataFields) {
          const rawFields = includedProduct.requiredDataFields || includedProduct.RequiredDataFields;
          if (typeof rawFields === 'string') {
            try {
              requiredDataFields = JSON.parse(rawFields);
            } catch (e) {
              console.warn('Failed to parse RequiredDataFields for included product:', e);
            }
          } else if (Array.isArray(rawFields)) {
            requiredDataFields = rawFields;
          }
        }
        
        // Extract all fieldOptions from all required data fields
        requiredDataFields.forEach((field: any) => {
          if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
            allConfigOptions.push(...field.fieldOptions);
          }
        });
        
        // Also check availableConfigs
        if (includedProduct.availableConfigs || includedProduct.AvailableConfigs) {
          const availableConfigs = includedProduct.availableConfigs || includedProduct.AvailableConfigs;
          if (Array.isArray(availableConfigs)) {
            allConfigOptions.push(...availableConfigs);
          }
        }
      });
      
      // Remove duplicates and sort
      return [...new Set(allConfigOptions)].sort();
    }
    
    // For non-bundle products, get config options from the product itself
    let configOptions: string[] = [];
    
    // Handle both parsed and unparsed RequiredDataFields
    let requiredDataFields: any[] = [];
    if (product.requiredDataFields || product.RequiredDataFields) {
      const rawFields = product.requiredDataFields || product.RequiredDataFields;
      if (typeof rawFields === 'string') {
        try {
          requiredDataFields = JSON.parse(rawFields);
        } catch (e) {
          console.warn('Failed to parse RequiredDataFields:', e);
        }
      } else if (Array.isArray(rawFields)) {
        requiredDataFields = rawFields;
      }
    }
    
    // Extract all fieldOptions from all required data fields
    requiredDataFields.forEach((field: any) => {
      if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
        configOptions.push(...field.fieldOptions);
      }
    });
    
    // Remove duplicates and sort
    configOptions = [...new Set(configOptions)].sort();
    
    // If no config options found, try to get from availableConfigs if present
    if (configOptions.length === 0 && (product.availableConfigs || product.AvailableConfigs)) {
      const availableConfigs = product.availableConfigs || product.AvailableConfigs;
      if (Array.isArray(availableConfigs)) {
        configOptions = [...availableConfigs].sort();
      }
    }
    
    return configOptions;
  };

  /** Get config options for a specific product by productId (used by dynamicPrice calc fields). */
  const getConfigOptionsForProduct = (productId: string): string[] => {
    const pid = productId?.toLowerCase();
    const product = products.find(p => (p.productId || p.ProductId)?.toLowerCase() === pid);
    if (!product) return [];

    // Check if product already has availableConfigs (populated by backend from RequiredDataFields or ProductPricing)
    if (product.availableConfigs && Array.isArray(product.availableConfigs) && product.availableConfigs.length > 0) {
      return [...product.availableConfigs].sort();
    }
    if (product.AvailableConfigs && Array.isArray(product.AvailableConfigs) && product.AvailableConfigs.length > 0) {
      return [...product.AvailableConfigs].sort();
    }

    // Parse from RequiredDataFields
    let configOptions: string[] = [];
    let requiredDataFields: any[] = [];
    if (product.requiredDataFields || product.RequiredDataFields) {
      const rawFields = product.requiredDataFields || product.RequiredDataFields;
      if (typeof rawFields === 'string') {
        try { requiredDataFields = JSON.parse(rawFields); } catch (e) { /* ignore */ }
      } else if (Array.isArray(rawFields)) {
        requiredDataFields = rawFields;
      }
    }
    requiredDataFields.forEach((field: any) => {
      if (field.fieldOptions && Array.isArray(field.fieldOptions)) {
        configOptions.push(...field.fieldOptions);
      }
    });
    configOptions = [...new Set(configOptions)].sort();

    // For bundles: backend now populates availableConfigs from included products' pricing data
    // No frontend aggregation needed

    return configOptions;
  };

  /** Get the productId for a given product slot number. */
  const getProductIdForSlot = (slotNumber: number): string | undefined => {
    const slot = productSlots.find(s => Number(s.slotNumber) === Number(slotNumber));
    return slot?.productId || (slot as any)?.ProductId;
  };

  const renderField = (field: ProposalField, index: number) => {
    // Show field if it's on the current page, OR if it repeats on all pages
    if (field.pageNumber !== currentPage && !field.repeatOnAllPages) return null;

    const isSelected = selectedField === field || (selectedFields.length > 0 && selectedFields.some(f => isSameField(f, field)));
    const isMultiSelected = selectedFields.length > 1 && selectedFields.some(f => isSameField(f, field));
    const left = field.xPosition * 100;
    const bottom = field.yPosition * 100;
    
    // For image fields with circle or square shape, ensure 1:1 aspect ratio
    // Always use the same value for both width and height to ensure perfect square
    let displaySize = field.width;
    
    if (field.fieldType === 'image' && (field.imageShape === 'circle' || field.imageShape === 'square')) {
      // Use the larger dimension to ensure square
      displaySize = Math.max(field.width, field.height);
    }

    const width = displaySize * 100;
    const height = (field.fieldType === 'image' && (field.imageShape === 'circle' || field.imageShape === 'square')) 
      ? displaySize * 100  // Same as width for square/circle
      : field.height * 100; // Use actual height for other field types

    const placeholder = getPlaceholderText(field);
    
    // For image fields: fill background for both circle and square shapes
    // For other fields: use fillBackground option
    let shouldFillBackground = false;
    let bgColor = 'transparent';
    let containerBgColor = 'transparent'; // Background color for the container itself
    
    if (field.fieldType === 'image') {
      // Fill background for both circle and square images
      if (field.imageShape === 'circle' || field.imageShape === 'square') {
        shouldFillBackground = true;
        bgColor = field.backgroundColor || '#FFFFFF';
        // For circle: background goes on inner div, container stays transparent
        // For square: background goes on container directly
        if (field.imageShape === 'square') {
          containerBgColor = bgColor;
        }
      } else {
        shouldFillBackground = false;
        bgColor = 'transparent';
      }
    } else if (field.fieldType === 'link') {
      // Link fields are invisible - no background fill, but show dashed border in editor
      shouldFillBackground = false;
      bgColor = 'transparent';
      containerBgColor = 'transparent';
    } else {
      // For text, price, whitespace, custom, calculation: use fillBackground option
      shouldFillBackground = field.fillBackground !== false; // Default to true if not set
      bgColor = shouldFillBackground 
        ? (field.backgroundColor || (field.fieldType === 'whitespace' ? '#FFFFFF' : (field.fieldType === 'text' || field.fieldType === 'price' || field.fieldType === 'custom' || field.fieldType === 'calculation' ? '#FFFFFF' : 'transparent')))
        : 'transparent';
      containerBgColor = shouldFillBackground ? bgColor : 'transparent';
    }

    return (
      <div
        key={index}
        className={`absolute ${field.fieldType === 'link' ? 'border-2 border-dashed' : 'border-2 border-solid'} ${isDragging || isResizing ? 'cursor-grabbing' : 'cursor-move'} ${
          isMultiSelected
            ? 'border-blue-500 ring-2 ring-blue-300/50'
            : isSelected
              ? field.fieldType === 'link' ? 'border-oe-primary' : 'border-oe-primary'
              : field.fieldType === 'link' ? 'border-blue-400' : 'border-gray-400'
        }`}
        style={{
          left: `${left}%`,
          bottom: `${bottom}%`,
          ...(field.fieldType === 'image' && (field.imageShape === 'circle' || field.imageShape === 'square')
            ? {
                width: `${width}%`,
                aspectRatio: '1 / 1', // Force 1:1 - height will be calculated automatically
                height: 'auto' // Let aspectRatio control the height
              }
            : {
                width: `${width}%`,
                height: `${height}%`
              }),
          backgroundColor: containerBgColor, // Container background (square images and text/price/whitespace)
          borderRadius: '0', // Container is always square (no border-radius)
          overflow: 'hidden'
        }}
        onMouseDown={(e) => !isResizing && handleFieldMouseDown(e, field)}
        onClick={(e) => {
          e.stopPropagation();
          // Shift+click is handled by onMouseDown; normal click selects single field
          if (!e.shiftKey) {
            setSelectedField(field);
            setSelectedFields([]);
          }
        }}
      >
        {/* Inner circle for circle image fields */}
        {field.fieldType === 'image' && field.imageShape === 'circle' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              backgroundColor: bgColor,
              borderRadius: '50%',
              width: '100%',
              height: '100%',
              border: field.borderWidth && field.borderWidth > 0
                ? `${field.borderWidth}px solid ${field.borderColor || '#000000'}`
                : undefined,
              boxSizing: 'border-box'
            }}
          />
        )}
        {/* Inner border overlay for square image fields */}
        {field.fieldType === 'image' && field.imageShape === 'square' && field.borderWidth && field.borderWidth > 0 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              border: `${field.borderWidth}px solid ${field.borderColor || '#000000'}`,
              boxSizing: 'border-box',
              pointerEvents: 'none'
            }}
          />
        )}
        {field.fieldType === 'text' || field.fieldType === 'price' ? (
          <div 
            className="absolute inset-0 flex pointer-events-none"
            style={{
              color: field.textColor || '#000000',
              fontSize: `${field.fontSize || 12}pt`,
              fontWeight: field.isBold ? 'bold' : 'normal',
              fontFamily: getFieldFontFamily(field) || 'Inter, Arial, sans-serif',
              padding: 0,
              lineHeight: '1.2',
              alignItems: getFieldVerticalAlign(field) === 'middle'
                ? 'center'
                : getFieldVerticalAlign(field) === 'bottom'
                  ? 'flex-end'
                  : 'flex-start',
              textAlign: field.textAlign || 'left',
              justifyContent: field.textAlign === 'center' ? 'center' : field.textAlign === 'right' ? 'flex-end' : 'flex-start'
            }}
          >
            {placeholder}
          </div>
        ) : field.fieldType === 'link' ? (
          // Link fields are invisible but show a dashed border and icon in editor
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-xs text-oe-primary flex items-center gap-1">
              <LinkIcon className="h-3 w-3" />
              <span>{placeholder}</span>
            </div>
          </div>
        ) : field.fieldType === 'custom' ? (
          <div 
            className="absolute inset-0 flex pointer-events-none"
            style={{
              color: field.textColor || '#000000',
              fontSize: `${field.fontSize || 12}pt`,
              fontWeight: field.isBold ? 'bold' : 'normal',
              fontFamily: getFieldFontFamily(field) || 'Inter, Arial, sans-serif',
              padding: 0,
              lineHeight: '1.2',
              alignItems: getFieldVerticalAlign(field) === 'middle'
                ? 'center'
                : getFieldVerticalAlign(field) === 'bottom'
                  ? 'flex-end'
                  : 'flex-start',
              textAlign: field.textAlign || 'left',
              justifyContent: field.textAlign === 'center' ? 'center' : field.textAlign === 'right' ? 'flex-end' : 'flex-start'
            }}
          >
            {placeholder}
          </div>
        ) : field.fieldType === 'calculation' ? (
          <div 
            className="absolute inset-0 flex pointer-events-none"
            style={{
              color: field.textColor || '#000000',
              fontSize: `${field.fontSize || 12}pt`,
              fontWeight: field.isBold ? 'bold' : 'normal',
              fontFamily: getFieldFontFamily(field) || 'Inter, Arial, sans-serif',
              padding: 0,
              lineHeight: '1.2',
              alignItems: getFieldVerticalAlign(field) === 'middle'
                ? 'center'
                : getFieldVerticalAlign(field) === 'bottom'
                  ? 'flex-end'
                  : 'flex-start',
              textAlign: field.textAlign || 'left',
              justifyContent: field.textAlign === 'center' ? 'center' : field.textAlign === 'right' ? 'flex-end' : 'flex-start'
            }}
          >
            {placeholder}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 pointer-events-none px-1">
            {placeholder}
          </div>
        )}

        <div className="absolute -top-6 left-0 flex items-center gap-1 bg-white px-1 rounded text-xs z-10">
          {getFieldIcon(field.fieldType)}
          <span className="capitalize">{field.fieldType === 'custom' ? (field.customLabel || 'custom') : field.fieldType}</span>
          {field.fieldName && <span className="text-gray-500">({field.fieldName})</span>}
          {field.repeatOnAllPages && <span className="bg-blue-100 text-blue-700 px-1 rounded text-[10px]">All Pages</span>}
        </div>

        {isSelected && (
          <button
            className="absolute -top-6 right-0 p-1 bg-red-600 text-white rounded hover:bg-red-700 z-10"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteField(field);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}

        {isSelected && (
          <>
            <div
              className="absolute -top-1 -left-1 w-3 h-3 bg-oe-primary border border-white rounded cursor-nw-resize"
              onMouseDown={(e) => handleResizeStart(field, 'nw', e)}
            />
            <div
              className="absolute -top-1 -right-1 w-3 h-3 bg-oe-primary border border-white rounded cursor-ne-resize"
              onMouseDown={(e) => handleResizeStart(field, 'ne', e)}
            />
            <div
              className="absolute -bottom-1 -left-1 w-3 h-3 bg-oe-primary border border-white rounded cursor-sw-resize"
              onMouseDown={(e) => handleResizeStart(field, 'sw', e)}
            />
            <div
              className="absolute -bottom-1 -right-1 w-3 h-3 bg-oe-primary border border-white rounded cursor-se-resize"
              onMouseDown={(e) => handleResizeStart(field, 'se', e)}
            />
          </>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-full max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Edit Proposal Template</h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto p-4 bg-gray-100">
            {error && (
              <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <p className="text-red-800">{error}</p>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              </div>
            ) : !authenticatedDocumentUrl ? (
              <div className="flex flex-col items-center justify-center h-full p-8">
                <p className="text-red-600 mb-2 text-lg font-medium">No PDF file selected</p>
                <p className="text-sm text-gray-600 text-center">
                  Please ensure the document was uploaded correctly and try again.
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <div className="mb-4 flex items-center gap-4">
                  <button
                    onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage === 1}
                    className="px-4 py-2 bg-gray-200 rounded-lg disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <span className="text-gray-700">
                    Page {currentPage} of {numPages}
                  </span>
                  <button
                    onClick={() => setCurrentPage(Math.min(numPages, currentPage + 1))}
                    disabled={currentPage === numPages}
                    className="px-4 py-2 bg-gray-200 rounded-lg disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>

                <div
                  ref={pageRef}
                  className={`relative bg-white shadow-lg cursor-crosshair outline-none ${isCanvasFocused ? 'ring-2 ring-blue-300' : ''}`}
                  onMouseDownCapture={() => pageRef.current?.focus()}
                  onClick={handlePageClick}
                  onKeyDown={handleCanvasKeyDown}
                  onFocus={() => setIsCanvasFocused(true)}
                  onBlur={() => setIsCanvasFocused(false)}
                  tabIndex={0}
                  style={{ minWidth: '800px' }}
                >
                  {pdfLoading ? (
                    <div className="flex items-center justify-center h-96">
                      <div className="flex flex-col items-center">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mb-4"></div>
                        <p className="text-sm text-gray-600">Loading PDF...</p>
                      </div>
                    </div>
                  ) : (
                    <Document
                      file={authenticatedDocumentUrl}
                      onLoadSuccess={onDocumentLoadSuccess}
                      loading={
                        <div className="flex items-center justify-center h-96">
                          <div className="flex flex-col items-center">
                            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mb-4"></div>
                            <p className="text-sm text-gray-600">Loading PDF...</p>
                          </div>
                        </div>
                      }
                      error={
                        <div className="flex flex-col items-center justify-center h-96 p-4">
                          <p className="text-red-600 mb-2">Failed to load PDF</p>
                          <p className="text-sm text-gray-600 text-center">
                            {error || 'Please check that the document URL is valid and accessible.'}
                          </p>
                          <button
                            onClick={loadAuthenticatedUrl}
                            className="mt-4 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
                          >
                            Retry
                          </button>
                        </div>
                      }
                    >
                      <Page
                        pageNumber={currentPage}
                        width={pageWidth}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                      />
                    </Document>
                  )}

                  {!pdfLoading && showAlignmentGuides && (
                    <div className="absolute inset-0 pointer-events-none z-0">
                      {alignmentGuides.map(guide => (
                        <div
                          key={guide.id}
                          className="absolute bg-blue-400/55"
                          style={guide.orientation === 'vertical'
                            ? {
                                left: `${guide.position * 100}%`,
                                top: 0,
                                bottom: 0,
                                width: '1px'
                              }
                            : {
                                left: 0,
                                right: 0,
                                bottom: `${guide.position * 100}%`,
                                height: '1px'
                              }
                          }
                        />
                      ))}
                    </div>
                  )}

                  {!pdfLoading && fields.map((field, index) => renderField(field, index))}
                </div>

                <p className="mt-4 text-sm text-gray-600">
                  Click on the PDF to add a field. Drag fields to reposition them.
                </p>
              </div>
            )}
          </div>

          <div className="w-80 border-l border-gray-200 overflow-y-auto flex flex-col">
            <div className="p-4 space-y-4 flex-1">
              {/* Document Settings — collapsible accordion */}
              <div className="border-b border-gray-200">
                <button
                  type="button"
                  onClick={() => setDocSettingsOpen(prev => !prev)}
                  className="w-full flex items-center justify-between py-2 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
                >
                  <span>Document Settings</span>
                  <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${docSettingsOpen ? 'rotate-180' : ''}`} />
                </button>
                {docSettingsOpen && (
                  <div className="pb-3 space-y-3">
                    {/* Category */}
                    <div className="pt-2 border-t border-gray-100">
                      <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                      <p className="text-xs text-gray-500 mb-2">
                        Controls which agent flow can use this template. Employee-category templates appear on the group Members tab and auto-populate from group data.
                      </p>
                      <select
                        value={localCategory}
                        onChange={(e) => setLocalCategory(e.target.value as 'General' | 'Business' | 'Employee')}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md"
                      >
                        <option value="General">General</option>
                        <option value="Business">Business</option>
                        <option value="Employee">Employee</option>
                      </select>
                    </div>

                    {/* Product Slots */}
                    <div className="pt-2 border-t border-gray-100">
                      <h4 className="text-sm font-medium text-gray-700 mb-1">Product Slots</h4>
                      <p className="text-xs text-gray-500 mb-2">
                        Assign products/bundles so calculation fields know which product to use for pricing.
                      </p>
                      <div className="space-y-0">
                        {productSlots.map((slot, index) => (
                          <div
                            key={slot.slotNumber}
                            className={`flex items-center gap-2 py-2 ${index > 0 ? 'border-t border-gray-100' : ''}`}
                          >
                            <span className="text-xs font-semibold text-gray-500 shrink-0 w-4 text-right">{slot.slotNumber}</span>
                            <select
                              value={slot.productId || ''}
                              onChange={(e) => {
                                const newProductId = e.target.value;
                                const selectedProduct = products.find(p => (p.productId || p.ProductId) === newProductId);
                                setProductSlots(prev => prev.map((s, i) => 
                                  i === index 
                                    ? { ...s, productId: newProductId, productName: newProductId ? (selectedProduct?.name || selectedProduct?.Name || '') : '' }
                                    : s
                                ));
                              }}
                              className="text-sm flex-1 min-w-0 px-2 py-1.5 border border-gray-300 rounded-md truncate"
                            >
                              <option value="">-- None --</option>
                              {products.map(p => {
                                const pid = p.productId || p.ProductId || '';
                                return (
                                  <option key={pid} value={pid}>
                                    {getProductDisplayLabel(p, 'dash')}
                                  </option>
                                );
                              })}
                            </select>
                            <label className="flex items-center gap-1 shrink-0" title="Primary products appear in the agent's product dropdown">
                              <input
                                type="checkbox"
                                checked={!!slot.isPrimary}
                                onChange={(e) => {
                                  setProductSlots(prev => prev.map((s, i) =>
                                    i === index ? { ...s, isPrimary: e.target.checked } : s
                                  ));
                                }}
                                className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600"
                              />
                              <span className="text-xs text-gray-500">Primary</span>
                            </label>
                            <button
                              onClick={() => {
                                setProductSlots(prev => {
                                  const updated = prev.filter((_, i) => i !== index);
                                  return updated.map((s, i) => ({ ...s, slotNumber: i + 1 }));
                                });
                              }}
                              className="text-red-400 hover:text-red-600 p-0.5 shrink-0"
                              title="Remove slot"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        onClick={() => {
                          const nextSlot = productSlots.length + 1;
                          setProductSlots(prev => [...prev, { slotNumber: nextSlot, productId: '', isPrimary: nextSlot === 1 }]);
                        }}
                        className="btn-secondary text-xs w-full mt-2"
                      >
                        + Add Product Slot
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">Add New Field</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => addNewField('text')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <Type className="h-4 w-4" />
                    Text
                  </button>
                  <button
                    onClick={() => addNewField('image')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <Image className="h-4 w-4" />
                    Image
                  </button>
                  <button
                    onClick={() => addNewField('price')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <DollarSign className="h-4 w-4" />
                    Price
                  </button>
                  <button
                    onClick={() => addNewField('whitespace')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <Square className="h-4 w-4" />
                    Whitespace
                  </button>
                  <button
                    onClick={() => addNewField('link')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <LinkIcon className="h-4 w-4" />
                    Link
                  </button>
                  <button
                    onClick={() => addNewField('custom')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <Type className="h-4 w-4" />
                    Custom
                  </button>
                  <button
                    onClick={() => addNewField('calculation')}
                    className="btn-primary text-sm flex items-center justify-center gap-1"
                  >
                    <Calculator className="h-4 w-4" />
                    Calculation
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Or click on the PDF to add a field at that location
                </p>
              </div>

              <div className="border-t border-gray-200 pt-4">
                <button
                  type="button"
                  onClick={() => setFieldPlacementOpen(prev => !prev)}
                  className="w-full flex items-center justify-between py-1 text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors"
                >
                  <span>Field Placement</span>
                  <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${fieldPlacementOpen ? 'rotate-180' : ''}`} />
                </button>
                {fieldPlacementOpen && (
                  <div className="pt-3 space-y-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showAlignmentGuides}
                        onChange={(e) => setShowAlignmentGuides(e.target.checked)}
                        className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                      />
                      <span className="text-sm text-gray-700">Show alignment guides</span>
                    </label>

                    <div>
                      <p className="text-xs text-gray-500 mb-2">
                        Nudge selected field by 1px
                      </p>
                      <div className="grid grid-cols-3 gap-1 max-w-[108px]">
                        <div />
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(0, 1)}
                          disabled={!selectedField && selectedFields.length === 0}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Move up (1px)"
                        >
                          <ArrowUp className="h-4 w-4 mx-auto" />
                        </button>
                        <div />
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(-1, 0)}
                          disabled={!selectedField && selectedFields.length === 0}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Move left (1px)"
                        >
                          <ArrowLeft className="h-4 w-4 mx-auto" />
                        </button>
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(0, -1)}
                          disabled={!selectedField && selectedFields.length === 0}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Move down (1px)"
                        >
                          <ArrowDown className="h-4 w-4 mx-auto" />
                        </button>
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(1, 0)}
                          disabled={!selectedField && selectedFields.length === 0}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="Move right (1px)"
                        >
                          <ArrowRight className="h-4 w-4 mx-auto" />
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-gray-500">
                      Use keyboard arrow keys for 1px nudging when the PDF canvas is focused.
                    </p>
                  </div>
                )}
              </div>

              <div className="border-t border-gray-200 pt-4">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Field Properties</h3>

                {selectedFields.length > 1 ? (
                  <div className="space-y-4">
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                      <p className="text-sm font-medium text-blue-800">{selectedFields.length} fields selected</p>
                      <p className="text-xs text-blue-600 mt-1">Use arrow keys to move all selected fields together.</p>
                    </div>

                    <div>
                      <p className="text-xs text-gray-500 mb-2">Nudge all selected fields by 1px</p>
                      <div className="grid grid-cols-3 gap-1 max-w-[108px]">
                        <div />
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(0, 1)}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100"
                          title="Move up (1px)"
                        >
                          <ArrowUp className="h-4 w-4 mx-auto" />
                        </button>
                        <div />
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(-1, 0)}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100"
                          title="Move left (1px)"
                        >
                          <ArrowLeft className="h-4 w-4 mx-auto" />
                        </button>
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(0, -1)}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100"
                          title="Move down (1px)"
                        >
                          <ArrowDown className="h-4 w-4 mx-auto" />
                        </button>
                        <button
                          type="button"
                          onClick={() => nudgeSelectedField(1, 0)}
                          className="p-1.5 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-100"
                          title="Move right (1px)"
                        >
                          <ArrowRight className="h-4 w-4 mx-auto" />
                        </button>
                      </div>
                    </div>

                    <p className="text-xs text-gray-500">
                      Ctrl+C / Ctrl+V to copy/paste. Delete key to remove.
                    </p>

                    <div className="pt-4 border-t border-gray-200 space-y-2">
                      <button
                        onClick={() => { setSelectedField(null); setSelectedFields([]); }}
                        className="btn-secondary w-full"
                      >
                        Deselect All
                      </button>
                      <button
                        onClick={() => handleDuplicateField(selectedFields[0])}
                        className="w-full px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2"
                      >
                        <Copy className="h-4 w-4" />
                        Duplicate {selectedFields.length} Fields
                      </button>
                      <button
                        onClick={() => handleDeleteField(selectedFields[0])}
                        className="btn-danger w-full flex items-center justify-center gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete {selectedFields.length} Fields
                      </button>
                    </div>
                  </div>
                ) : selectedField ? (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Field Type
                      </label>
                      <select
                        value={selectedField.fieldType}
                        onChange={(e) => {
                          const newFieldType = e.target.value as ProposalField['fieldType'];
                          const updated = { 
                            ...selectedField, 
                            fieldType: newFieldType,
                            fontFamily: (newFieldType === 'text' || newFieldType === 'price' || newFieldType === 'custom' || newFieldType === 'calculation')
                              ? (selectedField.fontFamily || DEFAULT_PROPOSAL_FONT)
                              : undefined,
                            verticalAlign: (newFieldType === 'text' || newFieldType === 'price' || newFieldType === 'custom' || newFieldType === 'calculation')
                              ? (selectedField.verticalAlign || 'top')
                              : undefined
                          };
                          replaceField(selectedField, updated);
                          setSelectedField(updated);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="text">Text</option>
                        <option value="image">Image</option>
                        <option value="price">Price</option>
                        <option value="whitespace">Whitespace</option>
                        <option value="link">Link</option>
                        <option value="custom">Custom Field</option>
                        <option value="calculation">Calculation</option>
                      </select>
                    </div>

                    {selectedField.fieldType === 'text' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Auto-fill Type
                          </label>
                          <select
                            value={selectedField.autoFillType || ''}
                            onChange={(e) => {
                              const updated = { ...selectedField, autoFillType: e.target.value as ProposalField['autoFillType'] || undefined };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            {AUTO_FILL_OPTIONS
                              .map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                          </select>
                          {selectedField.autoFillType === 'CustomText' && (
                            <div className="mt-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Custom Text
                              </label>
                              <textarea
                                value={selectedField.fieldName || ''}
                                onChange={(e) => {
                                  const updated = { ...selectedField, fieldName: e.target.value };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                placeholder="Enter the text to display..."
                                rows={3}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                              />
                              <p className="mt-1 text-xs text-gray-500">
                                This text will appear exactly as typed in the PDF.
                              </p>
                            </div>
                          )}
                          {selectedField.autoFillType === 'TierDescription' && (
                            <p className="mt-2 text-xs text-gray-500">
                              Example: "1 Parent + 1 Spouse + 2 Children" or "Employee Only"
                            </p>
                          )}
                          {(selectedField.autoFillType === 'AgentAddress' || selectedField.autoFillType === 'ClientAddress') && (
                            <div className="mt-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Address Format
                              </label>
                              <select
                                value={selectedField.addressFormat || 'full'}
                                onChange={(e) => {
                                  const updated = { 
                                    ...selectedField, 
                                    addressFormat: e.target.value as 'full' | 'streetOnly' | 'multiline'
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              >
                                <option value="full">Full Address</option>
                                <option value="streetOnly">Street Only</option>
                                <option value="multiline">Multi-line Address</option>
                              </select>
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Size (pt)
                          </label>
                          <input
                            type="number"
                            min="6"
                            max="72"
                            value={selectedField.fontSize ?? ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              // Allow empty string during editing
                              const updated = { 
                                ...selectedField, 
                                fontSize: value === '' ? undefined : (parseInt(value) || undefined)
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            onBlur={(e) => {
                              const value = e.target.value;
                              // Only default to 12 on blur if empty or invalid
                              if (value === '' || !value || parseInt(value) < 6 || parseInt(value) > 72) {
                                const updated = { ...selectedField, fontSize: 12 };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.isBold || false}
                              onChange={(e) => {
                                const updated = { ...selectedField, isBold: e.target.checked };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Bold</span>
                          </label>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Alignment
                          </label>
                          <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'left' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                (!selectedField.textAlign || selectedField.textAlign === 'left')
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Left"
                            >
                              <AlignLeft className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'center' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'center'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Center"
                            >
                              <AlignCenter className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'right' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'right'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Right"
                            >
                              <AlignRight className="h-4 w-4 mx-auto" />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Vertical Alignment
                          </label>
                          <select
                            value={selectedField.verticalAlign || 'top'}
                            onChange={(e) => {
                              const updated = { ...selectedField, verticalAlign: e.target.value as 'top' | 'middle' | 'bottom' };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="top">Top</option>
                            <option value="middle">Middle</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Family
                          </label>
                          <select
                            value={selectedField.fontFamily || DEFAULT_PROPOSAL_FONT}
                            onChange={(e) => {
                              const updated = { ...selectedField, fontFamily: e.target.value || DEFAULT_PROPOSAL_FONT };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            {FONT_FAMILY_OPTIONS.map((font) => (
                              <option key={font} value={font}>{font}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Text Color
                          </label>
                          <input
                            type="color"
                            value={selectedField.textColor || '#000000'}
                            onChange={(e) => {
                              const updated = { ...selectedField, textColor: e.target.value };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                          />
                          <ColorPresetSwatches
                            currentColor={selectedField.textColor || '#000000'}
                            onSelect={(color) => {
                              const updated = { ...selectedField, textColor: color };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.fillBackground !== false}
                              onChange={(e) => {
                                const updated = { ...selectedField, fillBackground: e.target.checked };
                                if (!e.target.checked) {
                                  updated.backgroundColor = undefined;
                                } else if (!updated.backgroundColor) {
                                  updated.backgroundColor = '#FFFFFF';
                                }
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Fill Background</span>
                          </label>
                        </div>
                        {selectedField.fillBackground !== false && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-sm font-medium text-gray-700">
                                Background Color
                              </label>
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = { 
                                    ...selectedField, 
                                    backgroundColor: undefined,
                                    fillBackground: false
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="text-xs text-gray-500 hover:text-gray-700 underline"
                                title="Reset to transparent"
                              >
                                Reset
                              </button>
                            </div>
                            <input
                              type="color"
                              value={selectedField.backgroundColor || '#FFFFFF'}
                              onChange={(e) => {
                                const updated = { ...selectedField, backgroundColor: e.target.value };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                            />
                            <ColorPresetSwatches
                              currentColor={selectedField.backgroundColor || '#FFFFFF'}
                              onSelect={(color) => {
                                const updated = { ...selectedField, backgroundColor: color };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}

                    {selectedField.fieldType === 'image' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Auto-fill Type
                          </label>
                          <select
                            value={selectedField.autoFillType || 'AgentPhoto'}
                            onChange={(e) => {
                              const updated = { ...selectedField, autoFillType: e.target.value as ProposalField['autoFillType'] };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="AgentPhoto">Agent Photo</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Image Shape
                          </label>
                          <select
                            value={selectedField.imageShape || 'square'}
                            onChange={(e) => {
                              const newShape = e.target.value as 'circle' | 'square';
                              const updated = { ...selectedField, imageShape: newShape };
                              
                              // When changing to circle or square, ensure 1:1 aspect ratio
                              if (newShape === 'circle' || newShape === 'square') {
                                const size = Math.max(updated.width, updated.height);
                                updated.width = size;
                                updated.height = size;
                                
                                // For both circle and square, set background fill
                                updated.fillBackground = true;
                                updated.backgroundColor = updated.backgroundColor || '#FFFFFF';
                              }
                              
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="square">Square</option>
                            <option value="circle">Circle</option>
                          </select>
                        </div>
                        {(selectedField.imageShape === 'circle' || selectedField.imageShape === 'square') && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-sm font-medium text-gray-700">
                                Background Color
                              </label>
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = { 
                                    ...selectedField, 
                                    backgroundColor: undefined
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="text-xs text-gray-500 hover:text-gray-700 underline"
                                title="Reset to default white"
                              >
                                Reset
                              </button>
                            </div>
                            <input
                              type="color"
                              value={selectedField.backgroundColor || '#FFFFFF'}
                              onChange={(e) => {
                                const updated = { ...selectedField, backgroundColor: e.target.value };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                            />
                            <ColorPresetSwatches
                              currentColor={selectedField.backgroundColor || '#FFFFFF'}
                              onSelect={(color) => {
                                const updated = { ...selectedField, backgroundColor: color };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                            />
                          </div>
                        )}
                        {(selectedField.imageShape === 'circle' || selectedField.imageShape === 'square') && (
                          <>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Border Width (px)
                              </label>
                              <input
                                type="number"
                                min={0}
                                max={20}
                                step={1}
                                value={selectedField.borderWidth ?? 0}
                                onChange={(e) => {
                                  const raw = parseInt(e.target.value, 10);
                                  const next = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 20) : 0;
                                  const updated = { ...selectedField, borderWidth: next };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              />
                            </div>
                            <div>
                              <div className="flex items-center justify-between mb-1">
                                <label className="block text-sm font-medium text-gray-700">
                                  Border Color
                                </label>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const updated = { ...selectedField, borderColor: undefined };
                                    replaceField(selectedField, updated);
                                    setSelectedField(updated);
                                  }}
                                  className="text-xs text-gray-500 hover:text-gray-700 underline"
                                  title="Reset to default black"
                                >
                                  Reset
                                </button>
                              </div>
                              <input
                                type="color"
                                value={selectedField.borderColor || '#000000'}
                                onChange={(e) => {
                                  const updated = { ...selectedField, borderColor: e.target.value };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                              />
                              <ColorPresetSwatches
                                currentColor={selectedField.borderColor || '#000000'}
                                onSelect={(color) => {
                                  const updated = { ...selectedField, borderColor: color };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                              />
                            </div>
                          </>
                        )}
                      </>
                    )}

                    {selectedField.fieldType === 'price' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Product
                          </label>
                          <select
                            value={selectedField.productId || ''}
                            onChange={(e) => {
                              const updated = { 
                                ...selectedField, 
                                productId: e.target.value || undefined,
                                configValue: undefined // Reset config when product changes
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            disabled={loadingProducts}
                          >
                            <option value="">Select Product</option>
                            {products.map((p) => {
                              const productId = p.productId || p.ProductId || '';
                              return (
                                <option key={productId} value={productId}>
                                  {getProductDisplayLabel(p)}
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        {selectedField.productId && getConfigOptions().length > 0 && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Configuration Value
                            </label>
                            <select
                              value={getPriceConfigValue(selectedField)}
                              onChange={(e) => {
                                const updated = { ...selectedField, configValue: e.target.value || undefined };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            >
                              <option value="">Select Config Value</option>
                              {getConfigOptions().map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {selectedField.productId && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Tier
                            </label>
                            <select
                              value={selectedField.tier || 'document'}
                              onChange={(e) => {
                                const val = e.target.value;
                                const updated = { ...selectedField, tier: val === 'document' ? undefined : val };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            >
                              <option value="document">Use Document Tier</option>
                              <option value="EE">Employee Only (EE)</option>
                              <option value="E1">Employee + One (E1)</option>
                              <option value="EF">Employee + Family (EF)</option>
                            </select>
                          </div>
                        )}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Size (pt)
                          </label>
                          <input
                            type="number"
                            min="6"
                            max="72"
                            value={selectedField.fontSize ?? ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              // Allow empty string during editing
                              const updated = { 
                                ...selectedField, 
                                fontSize: value === '' ? undefined : (parseInt(value) || undefined)
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            onBlur={(e) => {
                              const value = e.target.value;
                              // Only default to 12 on blur if empty or invalid
                              if (value === '' || !value || parseInt(value) < 6 || parseInt(value) > 72) {
                                const updated = { ...selectedField, fontSize: 12 };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.isBold || false}
                              onChange={(e) => {
                                const updated = { ...selectedField, isBold: e.target.checked };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Bold</span>
                          </label>
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={(() => {
                                const parsed = parseConfigObject(selectedField.configValue);
                                return parsed?.wholeNumber === true;
                              })()}
                              onChange={(e) => {
                                const parsed = parseConfigObject(selectedField.configValue) || {};
                                const nextConfig = { ...parsed, wholeNumber: e.target.checked };
                                const updated = { ...selectedField, configValue: JSON.stringify(nextConfig) };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Show as whole number</span>
                          </label>
                          <p className="mt-1 ml-6 text-xs text-gray-500">No decimals (e.g. $175 instead of $175.00).</p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Alignment
                          </label>
                          <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'left' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                (!selectedField.textAlign || selectedField.textAlign === 'left')
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Left"
                            >
                              <AlignLeft className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'center' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'center'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Center"
                            >
                              <AlignCenter className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'right' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'right'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Right"
                            >
                              <AlignRight className="h-4 w-4 mx-auto" />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Vertical Alignment
                          </label>
                          <select
                            value={selectedField.verticalAlign || 'top'}
                            onChange={(e) => {
                              const updated = { ...selectedField, verticalAlign: e.target.value as 'top' | 'middle' | 'bottom' };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="top">Top</option>
                            <option value="middle">Middle</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Family
                          </label>
                          <select
                            value={selectedField.fontFamily || DEFAULT_PROPOSAL_FONT}
                            onChange={(e) => {
                              const updated = { ...selectedField, fontFamily: e.target.value || DEFAULT_PROPOSAL_FONT };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            {FONT_FAMILY_OPTIONS.map((font) => (
                              <option key={font} value={font}>{font}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Text Color
                          </label>
                          <input
                            type="color"
                            value={selectedField.textColor || '#000000'}
                            onChange={(e) => {
                              const updated = { ...selectedField, textColor: e.target.value };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                          />
                          <ColorPresetSwatches
                            currentColor={selectedField.textColor || '#000000'}
                            onSelect={(color) => {
                              const updated = { ...selectedField, textColor: color };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.fillBackground !== false}
                              onChange={(e) => {
                                const updated = { ...selectedField, fillBackground: e.target.checked };
                                if (!e.target.checked) {
                                  updated.backgroundColor = undefined;
                                } else if (!updated.backgroundColor) {
                                  updated.backgroundColor = '#FFFFFF';
                                }
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Fill Background</span>
                          </label>
                        </div>
                        {selectedField.fillBackground !== false && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-sm font-medium text-gray-700">
                                Background Color
                              </label>
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = { 
                                    ...selectedField, 
                                    backgroundColor: undefined,
                                    fillBackground: false
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="text-xs text-gray-500 hover:text-gray-700 underline"
                                title="Reset to transparent"
                              >
                                Reset
                              </button>
                            </div>
                            <input
                              type="color"
                              value={selectedField.backgroundColor || '#FFFFFF'}
                              onChange={(e) => {
                                const updated = { ...selectedField, backgroundColor: e.target.value };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                            />
                            <ColorPresetSwatches
                              currentColor={selectedField.backgroundColor || '#FFFFFF'}
                              onSelect={(color) => {
                                const updated = { ...selectedField, backgroundColor: color };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}

                    {selectedField.fieldType === 'link' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Link Type
                          </label>
                          <select
                            value={selectedField.linkType || 'static_url'}
                            onChange={(e) => {
                              const newLinkType = e.target.value as 'static_url' | 'enrollment_link' | 'dynamic_url';
                              const updated = { 
                                ...selectedField, 
                                linkType: newLinkType,
                                // Clear URL/template when changing type
                                linkUrl: newLinkType === 'static_url' ? selectedField.linkUrl : undefined,
                                enrollmentLinkTemplateId: newLinkType === 'enrollment_link' ? selectedField.enrollmentLinkTemplateId : undefined
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="static_url">Static URL</option>
                            <option value="enrollment_link">Enrollment Link</option>
                            {/* <option value="dynamic_url">Custom URL (by sender)</option> */}
                          </select>
                        </div>
                        
                        {selectedField.linkType === 'static_url' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              URL *
                            </label>
                            <input
                              type="url"
                              value={selectedField.linkUrl || ''}
                              onChange={(e) => {
                                const updated = { ...selectedField, linkUrl: e.target.value || undefined };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              placeholder="https://example.com"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            />
                            <p className="mt-1 text-xs text-gray-500">
                              Enter the full URL that will be opened when this area is clicked
                            </p>
                          </div>
                        )}
                        
                        {selectedField.linkType === 'enrollment_link' && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Enrollment Link Template
                            </label>
                            <p className="text-xs text-gray-500 mb-2">
                              The agent will select which enrollment link template to use when sending the proposal
                            </p>
                            <p className="text-xs text-gray-400 italic">
                              Template selection happens when sending the proposal
                            </p>
                          </div>
                        )}
                      </>
                    )}

                    {selectedField.fieldType === 'whitespace' && (
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="block text-sm font-medium text-gray-700">
                            Background Color
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              const updated = { 
                                ...selectedField, 
                                backgroundColor: undefined,
                                fillBackground: false
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="text-xs text-gray-500 hover:text-gray-700 underline"
                            title="Reset to transparent"
                          >
                            Reset
                          </button>
                        </div>
                        <input
                          type="color"
                          value={selectedField.backgroundColor || '#FFFFFF'}
                          onChange={(e) => {
                            const updated = { ...selectedField, backgroundColor: e.target.value };
                            replaceField(selectedField, updated);
                            setSelectedField(updated);
                          }}
                          className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                        />
                        <ColorPresetSwatches
                          currentColor={selectedField.backgroundColor || '#FFFFFF'}
                          onSelect={(color) => {
                            const updated = { ...selectedField, backgroundColor: color };
                            replaceField(selectedField, updated);
                            setSelectedField(updated);
                          }}
                        />
                      </div>
                    )}

                    {selectedField.fieldType === 'custom' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Link to Existing Custom Field
                          </label>
                          <select
                            value={selectedField.customFieldId || ''}
                            onChange={(e) => {
                              const customFieldId = e.target.value || undefined;
                              // Find the existing custom field to get its label
                              const existingField = fields.find(f => f.customFieldId === customFieldId && f.fieldType === 'custom');
                              const updated = { 
                                ...selectedField, 
                                customFieldId,
                                customLabel: existingField?.customLabel || selectedField.customLabel
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="">Create New Custom Field</option>
                            {fields
                              .filter(f => f.fieldType === 'custom' && f.customFieldId && f.fieldId !== selectedField.fieldId)
                              .reduce((unique: ProposalField[], field) => {
                                // Only show unique customFieldIds
                                if (!unique.find(f => f.customFieldId === field.customFieldId)) {
                                  unique.push(field);
                                }
                                return unique;
                              }, [])
                              .map(field => (
                                <option key={field.customFieldId} value={field.customFieldId}>
                                  {field.customLabel || 'Unnamed Custom Field'}
                                </option>
                              ))}
                          </select>
                          <p className="mt-1 text-xs text-gray-500">
                            Select an existing custom field to link multiple positions to the same value, or create a new one
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Custom Label *
                          </label>
                          <input
                            type="text"
                            value={selectedField.customLabel || ''}
                            onChange={(e) => {
                              const updated = { ...selectedField, customLabel: e.target.value || undefined };
                              // If linking to existing, update all fields with the same customFieldId
                              if (selectedField.customFieldId) {
                                fields.forEach(f => {
                                  if (f.customFieldId === selectedField.customFieldId && f.fieldType === 'custom') {
                                    replaceField(f, { ...f, customLabel: e.target.value || undefined });
                                  }
                                });
                              }
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            placeholder="e.g., Company Name"
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            disabled={!!selectedField.customFieldId && fields.some(f => f.customFieldId === selectedField.customFieldId && f.fieldId !== selectedField.fieldId)}
                          />
                          <p className="mt-1 text-xs text-gray-500">
                            {selectedField.customFieldId && fields.some(f => f.customFieldId === selectedField.customFieldId && f.fieldId !== selectedField.fieldId)
                              ? 'Label is shared with other linked fields'
                              : 'This label will appear in the send form for users to fill out'}
                          </p>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Size (pt)
                          </label>
                          <input
                            type="number"
                            min="6"
                            max="72"
                            value={selectedField.fontSize ?? ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              const updated = { 
                                ...selectedField, 
                                fontSize: value === '' ? undefined : (parseInt(value) || undefined)
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            onBlur={(e) => {
                              const value = e.target.value;
                              if (value === '' || !value || parseInt(value) < 6 || parseInt(value) > 72) {
                                const updated = { ...selectedField, fontSize: 12 };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.isBold || false}
                              onChange={(e) => {
                                const updated = { ...selectedField, isBold: e.target.checked };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                            />
                            <span className="text-sm text-gray-700">Bold</span>
                          </label>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Family
                          </label>
                          <select
                            value={selectedField.fontFamily || DEFAULT_PROPOSAL_FONT}
                            onChange={(e) => {
                              const updated = { ...selectedField, fontFamily: e.target.value || DEFAULT_PROPOSAL_FONT };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            {FONT_FAMILY_OPTIONS.map((font) => (
                              <option key={font} value={font}>{font}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Text Color
                          </label>
                          <input
                            type="color"
                            value={selectedField.textColor || '#000000'}
                            onChange={(e) => {
                              const updated = { ...selectedField, textColor: e.target.value };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                          />
                          <ColorPresetSwatches
                            currentColor={selectedField.textColor || '#000000'}
                            onSelect={(color) => {
                              const updated = { ...selectedField, textColor: color };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Background Color
                          </label>
                          <input
                            type="color"
                            value={selectedField.backgroundColor || '#FFFFFF'}
                            onChange={(e) => {
                              const updated = { ...selectedField, backgroundColor: e.target.value };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                          />
                          <ColorPresetSwatches
                            currentColor={selectedField.backgroundColor || '#FFFFFF'}
                            onSelect={(color) => {
                              const updated = { ...selectedField, backgroundColor: color };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                          />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Alignment
                          </label>
                          <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'left' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                (!selectedField.textAlign || selectedField.textAlign === 'left')
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Left"
                            >
                              <AlignLeft className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'center' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'center'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Center"
                            >
                              <AlignCenter className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'right' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'right'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Right"
                            >
                              <AlignRight className="h-4 w-4 mx-auto" />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Vertical Alignment
                          </label>
                          <select
                            value={selectedField.verticalAlign || 'top'}
                            onChange={(e) => {
                              const updated = { ...selectedField, verticalAlign: e.target.value as 'top' | 'middle' | 'bottom' };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="top">Top</option>
                            <option value="middle">Middle</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </div>
                      </>
                    )}

                    {selectedField.fieldType === 'calculation' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Calculation Type *
                          </label>
                          <CalcTypeDropdown
                            value={selectedField.calculationType || ''}
                            onChange={(val: string) => {
                              const calculationType = (val || undefined) as ProposalField['calculationType'];
                              const needsTierConfig = calculationType?.startsWith('tier_') || calculationType === 'percentage';
                              const PRODUCT_SLOT_TYPES = new Set([
                                'calcMwTierPrice_EE', 'calcMwTierPrice_E1', 'calcMwTierPrice_EC', 'calcMwTierPrice_EF',
                                'calcMwTierCost_EE', 'calcMwTierCost_E1', 'calcMwTierCost_EC', 'calcMwTierCost_EF',
                                'calcMwTotalMonthly', 'calcMwTotalYearly',
                                'calcUnsharedAmountDisplay',
                                'calcEmployerContrib_EE', 'calcEmployerContrib_E1', 'calcEmployerContrib_EC', 'calcEmployerContrib_EF',
                                'calcEmployeeCost_EE', 'calcEmployeeCost_E1', 'calcEmployeeCost_EC', 'calcEmployeeCost_EF',
                                'calcTotalEmployerMwMonthly', 'calcTotalEmployerMwYearly',
                                'calcTotalEmployeeCostMonthly',
                                'calcTotalEmployeeCostYearly',
                                'calcAvgEmployeeCostMonthly', 'calcAvgEmployeeCostYearly',
                                'calcAvgEmployeeCostChangeMonthly', 'calcAvgEmployeeCostChangeYearly',
                                'calcNetCostChangeMonthly', 'calcNetCostChangeYearly',
                                'calcSavingsMonthly', 'calcSavingsYearly',
                                'calcOverallSavingsYearly_partial_beforeContrib',
                                'calcHeadlineGenericQuote',
                                'calcStepTierCost_EE', 'calcStepTierCost_E1', 'calcStepTierCost_EC', 'calcStepTierCost_EF',
                                'calcStepTotalCost',
                                'calcEmployerContribDisplay_EE', 'calcEmployerContribDisplay_E1', 'calcEmployerContribDisplay_EC', 'calcEmployerContribDisplay_EF',
                                'calcEmployerSharePct_EE', 'calcEmployerSharePct_E1', 'calcEmployerSharePct_EC', 'calcEmployerSharePct_EF',
                                'calcEmployeeSharePct_EE', 'calcEmployeeSharePct_E1', 'calcEmployeeSharePct_EC', 'calcEmployeeSharePct_EF',
                                'calcEmployeeMonthlyCost_EE', 'calcEmployeeMonthlyCost_E1', 'calcEmployeeMonthlyCost_EC', 'calcEmployeeMonthlyCost_EF',
                                'calcEmployeeAnnualCost_EE', 'calcEmployeeAnnualCost_E1', 'calcEmployeeAnnualCost_EC', 'calcEmployeeAnnualCost_EF',
                                'calcEmployerAnnualContrib_EE', 'calcEmployerAnnualContrib_E1', 'calcEmployerAnnualContrib_EC', 'calcEmployerAnnualContrib_EF',
                                'calcEmployeeSavingsMonthly_EE', 'calcEmployeeSavingsMonthly_E1', 'calcEmployeeSavingsMonthly_EC', 'calcEmployeeSavingsMonthly_EF',
                                'calcEmployeeSavingsYearly_EE', 'calcEmployeeSavingsYearly_E1', 'calcEmployeeSavingsYearly_EC', 'calcEmployeeSavingsYearly_EF',
                              ]);
                              const needsProductSlot = calculationType && PRODUCT_SLOT_TYPES.has(calculationType);
                              // Handle dynamicPrice: initialize with default product slot + tier
                              if (calculationType === 'dynamicPrice') {
                                const dpConfig: Record<string, any> = { dynamicPrice: true, productSlot: productSlots.length > 0 ? 1 : undefined, tier: 'EE' };
                                const updated = {
                                  ...selectedField,
                                  calculationType,
                                  calculationConfig: dpConfig,
                                  fieldName: calculationType,
                                  configValue: JSON.stringify(dpConfig)
                                };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                                return;
                              }
                              // Handle combinedPrice: initialize with two addends (product slots) + form tier
                              if (calculationType === 'combinedPrice') {
                                const cpConfig: Record<string, any> = {
                                  combinedPrice: true,
                                  addends: [
                                    { productSlot: productSlots[0]?.slotNumber ?? 1, configValue: undefined },
                                    { productSlot: productSlots[1]?.slotNumber ?? productSlots[0]?.slotNumber ?? 2, configValue: undefined },
                                  ],
                                  tier: 'document',
                                  roundPrice: true,
                                };
                                const updated = {
                                  ...selectedField,
                                  calculationType,
                                  calculationConfig: cpConfig,
                                  fieldName: calculationType,
                                  configValue: JSON.stringify(cpConfig)
                                };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                                return;
                              }
                              const calcConfig: Record<string, any> = {};
                              if (needsTierConfig) calcConfig.tier = 'EE';
                              if (needsProductSlot && productSlots.length > 0) calcConfig.productSlot = 1;
                              const configToSave = Object.keys(calcConfig).length > 0 ? calcConfig : undefined;
                              const updated = {
                                ...selectedField,
                                calculationType,
                                calculationConfig: configToSave,
                                fieldName: calculationType || undefined,
                                configValue: configToSave ? JSON.stringify(configToSave) : undefined
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                          />
                        </div>
                        {/* Dynamic Price dropdowns: Product Slot, Tier, Config Value */}
                        {selectedField.calculationType === 'dynamicPrice' && (
                          <>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Product Slot
                              </label>
                              {productSlots.length > 0 ? (
                                <select
                                  value={selectedField.calculationConfig?.productSlot ?? 1}
                                  onChange={(e) => {
                                    const slotVal = parseInt(e.target.value);
                                    const calcConfig = {
                                      ...selectedField.calculationConfig,
                                      dynamicPrice: true,
                                      productSlot: slotVal > 0 ? slotVal : 1,
                                      // Reset configValue when product slot changes (product may have different configs)
                                      configValue: undefined
                                    };
                                    const updated = {
                                      ...selectedField,
                                      calculationConfig: calcConfig,
                                      configValue: JSON.stringify(calcConfig)
                                    };
                                    replaceField(selectedField, updated);
                                    setSelectedField(updated);
                                  }}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                                >
                                  {productSlots.map(slot => (
                                    <option key={slot.slotNumber} value={slot.slotNumber}>
                                      Product {slot.slotNumber}{slot.productName ? `: ${slot.productName}` : ''}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <p className="text-xs text-gray-500 italic py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                                  No product slots configured. Add product slots above first.
                                </p>
                              )}
                            </div>
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Tier
                              </label>
                              <select
                                value={selectedField.calculationConfig?.tier || 'EE'}
                                onChange={(e) => {
                                  const calcConfig = {
                                    ...selectedField.calculationConfig,
                                    dynamicPrice: true,
                                    tier: e.target.value
                                  };
                                  const updated = {
                                    ...selectedField,
                                    calculationConfig: calcConfig,
                                    configValue: JSON.stringify(calcConfig)
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              >
                                <option value="EE">Employee Only (EE)</option>
                                <option value="E1">Employee + One (E1)</option>
                                <option value="EC">Employee + Children (EC)</option>
                                <option value="EF">Employee + Family (EF)</option>
                              </select>
                            </div>
                            {/* Config Value dropdown: only show if the selected product has config options */}
                            {(() => {
                              const dpSlot = selectedField.calculationConfig?.productSlot ?? 1;
                              const dpProductId = getProductIdForSlot(dpSlot);
                              console.log('🔍 DynamicPrice config lookup:', { dpSlot, dpProductId, productSlotsCount: productSlots.length, productsCount: products.length, productSlots: productSlots.map(s => ({ slot: s.slotNumber, pid: s.productId })) });
                              const dpConfigOptions = dpProductId ? getConfigOptionsForProduct(dpProductId) : [];
                              console.log('🔍 DynamicPrice config options:', dpConfigOptions);
                              if (dpConfigOptions.length === 0) return null;
                              return (
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-1">
                                    Configuration Value (Unshared Amount)
                                  </label>
                                  <select
                                    value={selectedField.calculationConfig?.configValue || ''}
                                    onChange={(e) => {
                                      const calcConfig = {
                                        ...selectedField.calculationConfig,
                                        dynamicPrice: true,
                                        configValue: e.target.value || undefined
                                      };
                                      const updated = {
                                        ...selectedField,
                                        calculationConfig: calcConfig,
                                        configValue: JSON.stringify(calcConfig)
                                      };
                                      replaceField(selectedField, updated);
                                      setSelectedField(updated);
                                    }}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                                  >
                                    <option value="">Select Config Value</option>
                                    {dpConfigOptions.map((option: string) => (
                                      <option key={option} value={option}>
                                        {option}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              );
                            })()}
                            {/* Round Price checkbox */}
                            <div className="flex items-center gap-2 mt-2">
                              <input
                                type="checkbox"
                                id="roundPrice"
                                checked={selectedField.calculationConfig?.roundPrice !== false}
                                onChange={(e) => {
                                  const calcConfig = {
                                    ...selectedField.calculationConfig,
                                    roundPrice: e.target.checked
                                  };
                                  const updated = {
                                    ...selectedField,
                                    calculationConfig: calcConfig,
                                    configValue: JSON.stringify(calcConfig)
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                              />
                              <label htmlFor="roundPrice" className="text-sm text-gray-700">Round to whole dollars</label>
                            </div>
                            {/* Display Mode: Full Price or Employee Cost */}
                            <div className="mt-2">
                              <label className="block text-sm font-medium text-gray-700 mb-1">Display</label>
                              <select
                                value={selectedField.calculationConfig?.displayMode || 'fullPrice'}
                                onChange={(e) => {
                                  const calcConfig = {
                                    ...selectedField.calculationConfig,
                                    displayMode: e.target.value
                                  };
                                  const updated = {
                                    ...selectedField,
                                    calculationConfig: calcConfig,
                                    configValue: JSON.stringify(calcConfig)
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                              >
                                <option value="fullPrice">Full Price</option>
                                <option value="employeeCost">Employee Cost (After Employer Contribution)</option>
                              </select>
                            </div>
                          </>
                        )}
                        {/* Combined Price: add prices from multiple product slots together */}
                        {selectedField.calculationType === 'combinedPrice' && (
                          <>
                            {productSlots.length === 0 ? (
                              <p className="text-xs text-gray-500 italic py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                                No product slots configured. Add product slots above first.
                              </p>
                            ) : (
                              <div className="space-y-3">
                                <p className="text-xs text-gray-500">
                                  Add two or more products together. The tier comes from the proposal form unless overridden below.
                                </p>
                                {(selectedField.calculationConfig?.addends || []).map((addend: any, addendIdx: number) => {
                                  const slotProductId = getProductIdForSlot(addend.productSlot ?? 1);
                                  const addendConfigOptions = slotProductId ? getConfigOptionsForProduct(slotProductId) : [];
                                  const updateAddend = (changes: Record<string, any>) => {
                                    const addends = [...(selectedField.calculationConfig?.addends || [])];
                                    addends[addendIdx] = { ...addends[addendIdx], ...changes };
                                    const calcConfig = { ...selectedField.calculationConfig, combinedPrice: true, addends };
                                    const updated = { ...selectedField, calculationConfig: calcConfig, configValue: JSON.stringify(calcConfig) };
                                    replaceField(selectedField, updated);
                                    setSelectedField(updated);
                                  };
                                  const removeAddend = () => {
                                    const addends = (selectedField.calculationConfig?.addends || []).filter((_: any, i: number) => i !== addendIdx);
                                    const calcConfig = { ...selectedField.calculationConfig, combinedPrice: true, addends };
                                    const updated = { ...selectedField, calculationConfig: calcConfig, configValue: JSON.stringify(calcConfig) };
                                    replaceField(selectedField, updated);
                                    setSelectedField(updated);
                                  };
                                  return (
                                    <div key={addendIdx} className="border border-gray-200 rounded-lg p-3 space-y-2">
                                      <div className="flex items-center justify-between">
                                        <span className="text-xs font-semibold text-gray-600">Product {addendIdx + 1}</span>
                                        {(selectedField.calculationConfig?.addends || []).length > 1 && (
                                          <button
                                            type="button"
                                            onClick={removeAddend}
                                            className="text-red-400 hover:text-red-600 p-0.5"
                                            title="Remove product"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        )}
                                      </div>
                                      <select
                                        value={addend.productSlot ?? 1}
                                        onChange={(e) => updateAddend({ productSlot: parseInt(e.target.value), configValue: undefined })}
                                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                                      >
                                        {productSlots.map(slot => (
                                          <option key={slot.slotNumber} value={slot.slotNumber}>
                                            Product {slot.slotNumber}{slot.productName ? `: ${slot.productName}` : ''}
                                          </option>
                                        ))}
                                      </select>
                                      {addendConfigOptions.length > 0 && (
                                        <select
                                          value={addend.configValue || ''}
                                          onChange={(e) => updateAddend({ configValue: e.target.value || undefined })}
                                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                                        >
                                          <option value="">Select Unshared Amount</option>
                                          {addendConfigOptions.map((option: string) => (
                                            <option key={option} value={option}>{option}</option>
                                          ))}
                                        </select>
                                      )}
                                    </div>
                                  );
                                })}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const addends = [
                                      ...(selectedField.calculationConfig?.addends || []),
                                      { productSlot: productSlots[0]?.slotNumber ?? 1, configValue: undefined },
                                    ];
                                    const calcConfig = { ...selectedField.calculationConfig, combinedPrice: true, addends };
                                    const updated = { ...selectedField, calculationConfig: calcConfig, configValue: JSON.stringify(calcConfig) };
                                    replaceField(selectedField, updated);
                                    setSelectedField(updated);
                                  }}
                                  className="btn-secondary text-xs w-full"
                                >
                                  + Add Product
                                </button>
                                <div>
                                  <label className="block text-sm font-medium text-gray-700 mb-1">Tier</label>
                                  <select
                                    value={selectedField.calculationConfig?.tier || 'document'}
                                    onChange={(e) => {
                                      const calcConfig = { ...selectedField.calculationConfig, combinedPrice: true, tier: e.target.value };
                                      const updated = { ...selectedField, calculationConfig: calcConfig, configValue: JSON.stringify(calcConfig) };
                                      replaceField(selectedField, updated);
                                      setSelectedField(updated);
                                    }}
                                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                                  >
                                    <option value="document">Use Form Tier</option>
                                    <option value="EE">Employee Only (EE)</option>
                                    <option value="E1">Employee + One (E1)</option>
                                    <option value="EC">Employee + Children (EC)</option>
                                    <option value="EF">Employee + Family (EF)</option>
                                  </select>
                                </div>
                                <div className="flex items-center gap-2">
                                  <input
                                    type="checkbox"
                                    id="cpRoundPrice"
                                    checked={selectedField.calculationConfig?.roundPrice !== false}
                                    onChange={(e) => {
                                      const calcConfig = { ...selectedField.calculationConfig, combinedPrice: true, roundPrice: e.target.checked };
                                      const updated = { ...selectedField, calculationConfig: calcConfig, configValue: JSON.stringify(calcConfig) };
                                      replaceField(selectedField, updated);
                                      setSelectedField(updated);
                                    }}
                                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                                  />
                                  <label htmlFor="cpRoundPrice" className="text-sm text-gray-700">Round to whole dollars</label>
                                </div>
                              </div>
                            )}
                          </>
                        )}
                        {(selectedField.calculationType === 'tier_monthly' ||
                          selectedField.calculationType === 'tier_yearly' ||
                          selectedField.calculationType === 'percentage') && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Family Size
                            </label>
                            <select
                              value={selectedField.calculationConfig?.tier || 'EE'}
                              onChange={(e) => {
                                const calcConfig = { ...selectedField.calculationConfig, tier: e.target.value };
                                const updated = { 
                                  ...selectedField, 
                                  calculationConfig: calcConfig,
                                  configValue: JSON.stringify(calcConfig)
                                };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                            >
                              <option value="EE">EE (Employee Only)</option>
                              <option value="EC">EC (Employee + Children)</option>
                              <option value="ES">ES (Employee + Spouse)</option>
                              <option value="EF">EF (Employee + Family)</option>
                            </select>
                          </div>
                        )}
                        {/* Product Slot dropdown for pricing-related business calculation types */}
                        {selectedField.calculationType && (() => {
                          const SLOT_TYPES = new Set([
                            'calcMwTierPrice_EE', 'calcMwTierPrice_E1', 'calcMwTierPrice_EC', 'calcMwTierPrice_EF',
                            'calcMwTierCost_EE', 'calcMwTierCost_E1', 'calcMwTierCost_EC', 'calcMwTierCost_EF',
                            'calcMwTotalMonthly', 'calcMwTotalYearly',
                            'calcUnsharedAmountDisplay',
                            'calcEmployerContrib_EE', 'calcEmployerContrib_E1', 'calcEmployerContrib_EC', 'calcEmployerContrib_EF',
                            'calcEmployeeCost_EE', 'calcEmployeeCost_E1', 'calcEmployeeCost_EC', 'calcEmployeeCost_EF',
                            'calcTotalEmployerMwMonthly', 'calcTotalEmployerMwYearly',
                            'calcTotalEmployeeCostMonthly',
                            'calcNetCostChangeMonthly', 'calcNetCostChangeYearly',
                            'calcSavingsMonthly', 'calcSavingsYearly',
                            'calcOverallSavingsYearly_partial_beforeContrib',
                            'calcHeadlineGenericQuote',
                            'calcStepTierCost_EE', 'calcStepTierCost_E1', 'calcStepTierCost_EC', 'calcStepTierCost_EF',
                            'calcStepTotalCost',
                            'calcEmployerContribDisplay_EE', 'calcEmployerContribDisplay_E1', 'calcEmployerContribDisplay_EC', 'calcEmployerContribDisplay_EF',
                            'calcEmployerSharePct_EE', 'calcEmployerSharePct_E1', 'calcEmployerSharePct_EC', 'calcEmployerSharePct_EF',
                            'calcEmployeeSharePct_EE', 'calcEmployeeSharePct_E1', 'calcEmployeeSharePct_EC', 'calcEmployeeSharePct_EF',
                            'calcEmployeeMonthlyCost_EE', 'calcEmployeeMonthlyCost_E1', 'calcEmployeeMonthlyCost_EC', 'calcEmployeeMonthlyCost_EF',
                            'calcEmployeeAnnualCost_EE', 'calcEmployeeAnnualCost_E1', 'calcEmployeeAnnualCost_EC', 'calcEmployeeAnnualCost_EF',
                            'calcEmployerAnnualContrib_EE', 'calcEmployerAnnualContrib_E1', 'calcEmployerAnnualContrib_EC', 'calcEmployerAnnualContrib_EF',
                          ]);
                          return SLOT_TYPES.has(selectedField.calculationType);
                        })() && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Product Slot
                            </label>
                            {productSlots.length > 0 ? (
                              <select
                                value={selectedField.calculationConfig?.productSlot ?? 0}
                                onChange={(e) => {
                                  const slotVal = parseInt(e.target.value);
                                  // Always save the productSlot (even slot 1) so it's explicit in ConfigValue
                                  const calcConfig = { 
                                    ...selectedField.calculationConfig, 
                                    productSlot: slotVal > 0 ? slotVal : undefined 
                                  };
                                  // Remove productSlot key if 0 (unassigned)
                                  if (slotVal <= 0) delete calcConfig.productSlot;
                                  const hasConfig = Object.keys(calcConfig).length > 0;
                                  const updated = { 
                                    ...selectedField, 
                                    calculationConfig: hasConfig ? calcConfig : undefined,
                                    configValue: hasConfig ? JSON.stringify(calcConfig) : undefined
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className={`w-full px-3 py-2 border rounded-lg ${
                                  !selectedField.calculationConfig?.productSlot 
                                    ? 'border-amber-400 bg-amber-50' 
                                    : 'border-gray-300'
                                }`}
                              >
                                <option value={0}>-- Not assigned (uses Product 1 by default) --</option>
                                {productSlots.map(slot => (
                                  <option key={slot.slotNumber} value={slot.slotNumber}>
                                    Product {slot.slotNumber}{slot.productName ? `: ${slot.productName}` : ''}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <p className="text-xs text-gray-500 italic py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                                No product slots configured. Add product slots above to link this field to a specific product.
                              </p>
                            )}
                            <p className="text-xs text-gray-500 mt-1">
                              Which product&apos;s pricing to use for this calculation
                            </p>
                          </div>
                        )}
                        {/* Unshared Amount (configValue) for employee-facing pricing calcs.
                            Lets one template show the same product at multiple UA levels. */}
                        {selectedField.calculationType && (() => {
                          const UA_ELIGIBLE = new Set([
                            'calcMwTierPrice_EE', 'calcMwTierPrice_E1', 'calcMwTierPrice_EF',
                            'calcEmployerContrib_EE', 'calcEmployerContrib_E1', 'calcEmployerContrib_EF',
                            'calcEmployeeCost_EE', 'calcEmployeeCost_E1', 'calcEmployeeCost_EF',
                            'calcEmployeeMonthlyCost_EE', 'calcEmployeeMonthlyCost_E1', 'calcEmployeeMonthlyCost_EF',
                            'calcEmployeeMonthlyCost_ES', 'calcEmployeeMonthlyCost_EC',
                          ]);
                          return UA_ELIGIBLE.has(selectedField.calculationType);
                        })() && (() => {
                          const slot = selectedField.calculationConfig?.productSlot ?? 1;
                          const pid = getProductIdForSlot(slot);
                          const options = pid ? getConfigOptionsForProduct(pid) : [];
                          return (
                            <div>
                              <label className="block text-sm font-medium text-gray-700 mb-1">
                                Unshared Amount
                              </label>
                              {options.length > 0 ? (
                                <select
                                  value={selectedField.calculationConfig?.configValue || ''}
                                  onChange={(e) => {
                                    const calcConfig = {
                                      ...selectedField.calculationConfig,
                                      configValue: e.target.value || undefined,
                                    };
                                    if (!calcConfig.configValue) delete calcConfig.configValue;
                                    const hasConfig = Object.keys(calcConfig).length > 0;
                                    const updated = {
                                      ...selectedField,
                                      calculationConfig: hasConfig ? calcConfig : undefined,
                                      configValue: hasConfig ? JSON.stringify(calcConfig) : undefined,
                                    };
                                    replaceField(selectedField, updated);
                                    setSelectedField(updated);
                                  }}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                                >
                                  <option value="">-- Use group/template default --</option>
                                  {options.map((opt) => (
                                    <option key={opt} value={opt}>{opt}</option>
                                  ))}
                                </select>
                              ) : (
                                <p className="text-xs text-gray-500 italic py-2 px-3 bg-gray-50 rounded-lg border border-gray-200">
                                  No unshared-amount options found for this slot&apos;s product.
                                </p>
                              )}
                              <p className="text-xs text-gray-500 mt-1">
                                Locks this field to a specific UA level. Leave blank to use the default.
                              </p>
                            </div>
                          );
                        })()}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Size (pt)
                          </label>
                          <input
                            type="number"
                            min="6"
                            max="72"
                            value={selectedField.fontSize ?? ''}
                            onChange={(e) => {
                              const value = e.target.value;
                              const updated = { 
                                ...selectedField, 
                                fontSize: value === '' ? undefined : (parseInt(value) || undefined)
                              };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            onBlur={(e) => {
                              const value = e.target.value;
                              if (value === '' || !value || parseInt(value) < 6 || parseInt(value) > 72) {
                                const updated = { ...selectedField, fontSize: 12 };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.isBold || false}
                              onChange={(e) => {
                                const updated = { ...selectedField, isBold: e.target.checked };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                            />
                            <span className="text-sm text-gray-700">Bold</span>
                          </label>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Family
                          </label>
                          <select
                            value={selectedField.fontFamily || DEFAULT_PROPOSAL_FONT}
                            onChange={(e) => {
                              const updated = { ...selectedField, fontFamily: e.target.value || DEFAULT_PROPOSAL_FONT };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            {FONT_FAMILY_OPTIONS.map((font) => (
                              <option key={font} value={font}>{font}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Text Color
                          </label>
                          <input
                            type="color"
                            value={selectedField.textColor || '#000000'}
                            onChange={(e) => {
                              const updated = { ...selectedField, textColor: e.target.value };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                          />
                          <ColorPresetSwatches
                            currentColor={selectedField.textColor || '#000000'}
                            onSelect={(color) => {
                              const updated = { ...selectedField, textColor: color };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.fillBackground !== false}
                              onChange={(e) => {
                                const updated = { ...selectedField, fillBackground: e.target.checked };
                                if (!e.target.checked) {
                                  updated.backgroundColor = undefined;
                                } else if (!updated.backgroundColor) {
                                  updated.backgroundColor = '#FFFFFF';
                                }
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Fill Background</span>
                          </label>
                        </div>
                        {selectedField.fillBackground !== false && (
                          <div>
                            <div className="flex items-center justify-between mb-1">
                              <label className="block text-sm font-medium text-gray-700">
                                Background Color
                              </label>
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = {
                                    ...selectedField,
                                    backgroundColor: undefined,
                                    fillBackground: false
                                  };
                                  replaceField(selectedField, updated);
                                  setSelectedField(updated);
                                }}
                                className="text-xs text-gray-500 hover:text-gray-700 underline"
                                title="Reset to transparent"
                              >
                                Reset
                              </button>
                            </div>
                            <input
                              type="color"
                              value={selectedField.backgroundColor || '#FFFFFF'}
                              onChange={(e) => {
                                const updated = { ...selectedField, backgroundColor: e.target.value };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                            />
                            <ColorPresetSwatches
                              currentColor={selectedField.backgroundColor || '#FFFFFF'}
                              onSelect={(color) => {
                                const updated = { ...selectedField, backgroundColor: color };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                            />
                          </div>
                        )}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Alignment
                          </label>
                          <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'left' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                (!selectedField.textAlign || selectedField.textAlign === 'left')
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Left"
                            >
                              <AlignLeft className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'center' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'center'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Center"
                            >
                              <AlignCenter className="h-4 w-4 mx-auto" />
                            </button>
                            <button
                              onClick={() => {
                                const updated = { ...selectedField, textAlign: 'right' as const };
                                replaceField(selectedField, updated);
                                setSelectedField(updated);
                              }}
                              className={`flex-1 p-1 rounded ${
                                selectedField.textAlign === 'right'
                                  ? 'bg-white shadow text-gray-900'
                                  : 'text-gray-500 hover:text-gray-700'
                              }`}
                              title="Align Right"
                            >
                              <AlignRight className="h-4 w-4 mx-auto" />
                            </button>
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Vertical Alignment
                          </label>
                          <select
                            value={selectedField.verticalAlign || 'top'}
                            onChange={(e) => {
                              const updated = { ...selectedField, verticalAlign: e.target.value as 'top' | 'middle' | 'bottom' };
                              replaceField(selectedField, updated);
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="top">Top</option>
                            <option value="middle">Middle</option>
                            <option value="bottom">Bottom</option>
                          </select>
                        </div>
                      </>
                    )}

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Page
                      </label>
                      <select
                        value={selectedField.pageNumber || 1}
                        onChange={(e) => {
                          const newPageNumber = parseInt(e.target.value);
                          const updated = { 
                            ...selectedField, 
                            pageNumber: newPageNumber
                          };
                          replaceField(selectedField, updated);
                          setSelectedField(updated);
                          // Optionally switch to the new page to see the field
                          if (newPageNumber !== currentPage) {
                            setCurrentPage(newPageNumber);
                          }
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        disabled={selectedField.repeatOnAllPages === true}
                      >
                        {Array.from({ length: numPages }, (_, i) => i + 1).map(pageNum => (
                          <option key={pageNum} value={pageNum}>
                            Page {pageNum}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-2 py-1">
                      <input
                        type="checkbox"
                        id="repeatOnAllPages"
                        checked={selectedField.repeatOnAllPages === true}
                        onChange={(e) => {
                          const repeat = e.target.checked;
                          // Build updated configValue based on field type
                          let newConfigValue = selectedField.configValue;
                          if (selectedField.fieldType === 'calculation') {
                            // For calculation fields, store in calculationConfig JSON
                            const calcConfig = { ...selectedField.calculationConfig };
                            if (repeat) {
                              calcConfig.repeatOnAllPages = true;
                            } else {
                              delete calcConfig.repeatOnAllPages;
                            }
                            newConfigValue = Object.keys(calcConfig).length > 0 ? JSON.stringify(calcConfig) : undefined;
                            const updated = {
                              ...selectedField,
                              repeatOnAllPages: repeat || undefined,
                              calculationConfig: Object.keys(calcConfig).length > 0 ? calcConfig : undefined,
                              configValue: newConfigValue
                            };
                            replaceField(selectedField, updated);
                            setSelectedField(updated);
                          } else if (selectedField.fieldType === 'price') {
                            // For price fields, configValue is used for pricing config — store repeat flag separately
                            // Wrap existing configValue + repeatOnAllPages into JSON
                            const existingCv = selectedField.configValue;
                            let configObj: Record<string, any> = {};
                            if (existingCv) {
                              try { configObj = JSON.parse(existingCv); } catch { configObj = { _priceConfig: existingCv }; }
                            }
                            if (repeat) {
                              configObj.repeatOnAllPages = true;
                            } else {
                              delete configObj.repeatOnAllPages;
                              // If only _priceConfig remains, unwrap it
                              if (configObj._priceConfig && Object.keys(configObj).length === 1) {
                                newConfigValue = configObj._priceConfig;
                              } else {
                                newConfigValue = Object.keys(configObj).length > 0 ? JSON.stringify(configObj) : undefined;
                              }
                            }
                            if (repeat) {
                              newConfigValue = JSON.stringify(configObj);
                            }
                            const updated = {
                              ...selectedField,
                              repeatOnAllPages: repeat || undefined,
                              configValue: newConfigValue
                            };
                            replaceField(selectedField, updated);
                            setSelectedField(updated);
                          } else {
                            // For text, custom, image, whitespace, link fields
                            newConfigValue = repeat ? JSON.stringify({ repeatOnAllPages: true }) : undefined;
                            const updated = {
                              ...selectedField,
                              repeatOnAllPages: repeat || undefined,
                              configValue: newConfigValue
                            };
                            replaceField(selectedField, updated);
                            setSelectedField(updated);
                          }
                        }}
                        className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                      />
                      <label htmlFor="repeatOnAllPages" className="text-sm text-gray-700">
                        Repeat on all pages
                      </label>
                    </div>
                    {selectedField.repeatOnAllPages && (
                      <p className="text-xs text-gray-500 -mt-1">
                        This field will appear at the same position on every page (e.g., headers/footers).
                      </p>
                    )}

                    <div className="pt-4 border-t border-gray-200 space-y-2">
                      <button
                        onClick={() => { setSelectedField(null); setSelectedFields([]); }}
                        className="btn-secondary w-full"
                      >
                        Done Editing
                      </button>
                      <button
                        onClick={() => handleDuplicateField(selectedField)}
                        className="w-full px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center justify-center gap-2"
                      >
                        <Copy className="h-4 w-4" />
                        Duplicate Field
                      </button>
                      <button
                        onClick={() => handleDeleteField(selectedField)}
                        className="btn-danger w-full flex items-center justify-center gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete Field
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">
                    <p>Select a field to edit its properties, or add a new field above.</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-4 p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="btn-secondary"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !proposalDocumentId}
            className="btn-primary flex items-center gap-2"
          >
            {saving ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Saving...
              </>
            ) : (
              <>
                <Save className="h-4 w-4" />
                Save Template
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProposalEditor;

