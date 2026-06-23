// frontend/src/components/pdf-signer/PDFSignerEditor.tsx
// Component for editing PDF signature field templates with drag-and-drop

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { X, Trash2, Save, Type, Calendar, PenTool, ChevronUp, ChevronDown } from 'lucide-react';
import { apiService } from '../../services/api.service';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';

// Set up PDF.js worker - use local worker file from public directory
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

interface SignatureField {
  templateId?: string;
  /** Stable id for fields not yet saved (no templateId); avoids broken updates when fields array is replaced */
  localId?: string;
  fieldType: 'signature' | 'initial' | 'date' | 'text';
  fieldName?: string;
  xPosition: number; // 0-1 normalized
  yPosition: number; // 0-1 normalized
  width: number; // 0-1 normalized
  height: number; // 0-1 normalized
  pageNumber: number;
  isRequired: boolean;
  autoFillType?: 'TenantName' | 'AgentName' | 'AgentEmail' | 'MemberName' | 'GroupName' | 'CurrentDate' | 'UserEnteredDate' | 'FirstOfMonth' | 'CustomText';
  // Formatting options
  fontSize?: number;
  isBold?: boolean;
  textColor?: string;
  backgroundColor?: string;
  fillBackground?: boolean;
  textAlign?: 'left' | 'center' | 'right'; // Text alignment
  // Date format options (for date fields)
  dateFormat?: 'short' | 'medium' | 'long'; // 'short' = 1/1/26, 'medium' = Jan 1, 2026, 'long' = January 1, 2026
}

interface PDFSignerEditorProps {
  documentId: string;
  documentUrl: string;
  onClose: () => void;
  onSave: () => void;
}

const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 72;
const FONT_SIZE_DEFAULT = 12;

function clampFontSize(n: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, n));
}

function fieldsMatch(a: SignatureField, b: SignatureField): boolean {
  if (a.templateId != null && b.templateId != null) {
    return a.templateId === b.templateId;
  }
  if (a.localId != null && b.localId != null) {
    return a.localId === b.localId;
  }
  return a === b;
}

const PDFSignerEditor: React.FC<PDFSignerEditorProps> = ({
  documentId,
  documentUrl,
  onClose,
  onSave
}) => {
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageWidth, setPageWidth] = useState<number>(800);
  const [fields, setFields] = useState<SignatureField[]>([]);
  const [selectedField, setSelectedField] = useState<SignatureField | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [resizeDirection, setResizeDirection] = useState<'nw' | 'ne' | 'sw' | 'se' | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authenticatedDocumentUrl, setAuthenticatedDocumentUrl] = useState<string>(documentUrl);
  const pageRef = useRef<HTMLDivElement>(null);
  const fieldIdCounter = useRef<number>(0);
  const blobUrlRef = useRef<string | null>(null);

  // Load existing template and get authenticated document URL
  useEffect(() => {
    loadTemplate();
    loadAuthenticatedUrl();
    
    // Cleanup blob URL on unmount
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, [documentId]);

  const loadAuthenticatedUrl = async () => {
    try {
      // Always fetch PDF as blob through authenticated API to avoid CORS/auth issues
      const blob = await apiService.get<Blob>(
        `/api/document-signatures/documents/${documentId}/proxy`,
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
    } catch (err: any) {
      console.error('Could not load PDF:', err);
      setError(err.message || 'Failed to load PDF document');
      // Fallback to original URL if available
      if (documentUrl) {
        setAuthenticatedDocumentUrl(documentUrl);
      }
    }
  };

  const loadTemplate = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{
        success: boolean;
        data: Array<{
          TemplateId: string;
          FieldType: string;
          FieldName: string | null;
          XPosition: number;
          YPosition: number;
          Width: number;
          Height: number;
          PageNumber: number;
          IsRequired: boolean;
          AutoFillType: string | null;
        }>;
      }>(`/api/document-signatures/templates/${documentId}`);

      if (response.success && response.data) {
        const loadedFields: SignatureField[] = response.data.map((field: any) => ({
          templateId: field.TemplateId,
          fieldType: field.FieldType as SignatureField['fieldType'],
          fieldName: field.FieldName || undefined,
          xPosition: field.XPosition,
          yPosition: field.YPosition,
          width: field.Width,
          height: field.Height,
          pageNumber: field.PageNumber,
          isRequired: field.IsRequired,
          autoFillType: field.AutoFillType as SignatureField['autoFillType'] | undefined,
          // Formatting options (with defaults if not present)
          fontSize: field.FontSize !== undefined && field.FontSize !== null 
            ? field.FontSize 
            : ((field.FieldType === 'text' || field.FieldType === 'date') ? 12 : undefined),
          isBold: field.IsBold !== undefined && field.IsBold !== null ? Boolean(field.IsBold) : false,
          textColor: field.TextColor || ((field.FieldType === 'text' || field.FieldType === 'date') ? '#000000' : undefined),
          backgroundColor: field.BackgroundColor || ((field.FieldType === 'text' || field.FieldType === 'date') ? '#FFFFFF' : undefined),
          fillBackground: field.FillBackground !== undefined && field.FillBackground !== null 
            ? Boolean(field.FillBackground) 
            : ((field.FieldType === 'text' || field.FieldType === 'date') ? true : false),
          textAlign: field.TextAlign || (field.FieldType === 'text' || field.FieldType === 'date' ? 'left' : undefined),
          dateFormat: field.DateFormat || (field.FieldType === 'date' ? 'medium' : undefined)
        }));
        setFields(loadedFields);
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

  const addNewField = (fieldType: SignatureField['fieldType'] = 'signature') => {
    // Add field in center of visible area
    const newField: SignatureField = {
      localId: `local-${++fieldIdCounter.current}`,
      fieldType,
      xPosition: 0.4, // Center horizontally
      yPosition: 0.5, // Center vertically
      width: 0.2,
      height: 0.05,
      pageNumber: currentPage,
      isRequired: true,
      // Default date fields to "Today's Date"
      autoFillType: fieldType === 'date' ? 'CurrentDate' : undefined,
      // Default formatting for text/date fields
      fontSize: (fieldType === 'text' || fieldType === 'date') ? 12 : undefined,
      isBold: false,
      textColor: (fieldType === 'text' || fieldType === 'date') ? '#000000' : undefined,
      backgroundColor: (fieldType === 'text' || fieldType === 'date') ? '#FFFFFF' : undefined,
      fillBackground: (fieldType === 'text' || fieldType === 'date') ? true : false,
      textAlign: (fieldType === 'text' || fieldType === 'date') ? 'left' : undefined,
      // Default date format for date fields
      dateFormat: fieldType === 'date' ? 'medium' : undefined
    };

    setFields([...fields, newField]);
    setSelectedField(newField);
  };

  const handlePageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only allow clicking to add field if clicking on empty space (not on a field)
    if (isDragging || isResizing || selectedField) return;
    
    // Check if click is on a field (handled by field's onClick)
    const target = e.target as HTMLElement;
    if (target.closest('.absolute.border-2')) return;

    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height; // Flip Y axis

    // Create new field at click position
    const newField: SignatureField = {
      localId: `local-${++fieldIdCounter.current}`,
      fieldType: 'signature',
      xPosition: Math.max(0, Math.min(1, x - 0.1)),
      yPosition: Math.max(0, Math.min(1, y - 0.05)),
      width: 0.2,
      height: 0.05,
      pageNumber: currentPage,
      isRequired: true,
      autoFillType: undefined,
      // Default formatting
      fontSize: undefined,
      isBold: false,
      textColor: undefined,
      backgroundColor: undefined,
      fillBackground: false,
      textAlign: undefined,
      dateFormat: undefined
    };

    setFields([...fields, newField]);
    setSelectedField(newField);
  };

  const handleFieldMouseDown = (e: React.MouseEvent, field: SignatureField) => {
    e.stopPropagation();
    setSelectedField(field);
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

    setFields(fields.map(f => 
      fieldsMatch(f, selectedField) ? updatedField : f
    ));
    setSelectedField(updatedField);
  }, [isDragging, selectedField, dragOffset, fields]);

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

  const handleResizeStart = (field: SignatureField, direction: 'nw' | 'ne' | 'sw' | 'se', e: React.MouseEvent) => {
    e.stopPropagation();
    setIsResizing(true);
    setResizeDirection(direction);
    setSelectedField(field);
    
    if (pageRef.current) {
      const pageRect = pageRef.current.getBoundingClientRect();
      // Store initial field position and size (not mouse position)
      setResizeStart({
        x: field.xPosition, // Store initial X position
        y: field.yPosition, // Store initial Y position
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

    // Calculate mouse position relative to page (normalized 0-1)
    // X: 0 = left, 1 = right
    // Y: 0 = bottom, 1 = top (flipped because we use bottom as origin)
    const mouseX = (e.clientX - pageRect.left) / pageWidth;
    const mouseY = 1 - ((e.clientY - pageRect.top) / pageHeight);

    // Get initial field state (from when resize started)
    const startLeft = resizeStart.x;
    const startBottom = resizeStart.y;
    const startRight = startLeft + resizeStart.width;
    const startTop = startBottom + resizeStart.height;

    let newX = startLeft;
    let newY = startBottom;
    let newWidth = resizeStart.width;
    let newHeight = resizeStart.height;

    // Resize based on which corner is being dragged
    // The opposite corner stays fixed
    if (resizeDirection === 'se') {
      // Bottom-right corner: top-left corner stays fixed
      // Top-left is at (startLeft, startTop)
      newWidth = Math.max(0.01, Math.min(1 - startLeft, mouseX - startLeft));
      newHeight = Math.max(0.01, Math.min(startTop, startTop - mouseY));
      // Position: keep top-left fixed
      newX = startLeft; // Left edge stays fixed
      newY = startTop - newHeight; // Adjust Y so top edge stays at startTop
    } else if (resizeDirection === 'sw') {
      // Bottom-left corner: top-right corner stays fixed
      // Top-right is at (startRight, startTop)
      newWidth = Math.max(0.01, Math.min(startRight, startRight - mouseX));
      newHeight = Math.max(0.01, Math.min(startTop, startTop - mouseY));
      newX = startRight - newWidth; // Adjust X to keep right edge fixed
      newY = startTop - newHeight; // Adjust Y to keep top edge fixed
    } else if (resizeDirection === 'ne') {
      // Top-right corner: bottom-left corner stays fixed
      // Bottom-left is at (startLeft, startBottom)
      newWidth = Math.max(0.01, Math.min(1 - startLeft, mouseX - startLeft));
      newHeight = Math.max(0.01, Math.min(1 - startBottom, mouseY - startBottom));
      // Position stays the same (bottom-left fixed)
      newX = startLeft;
      newY = startBottom;
    } else if (resizeDirection === 'nw') {
      // Top-left corner: bottom-right corner stays fixed
      // Bottom-right is at (startRight, startBottom)
      newWidth = Math.max(0.01, Math.min(startRight, startRight - mouseX));
      newHeight = Math.max(0.01, Math.min(1 - startBottom, mouseY - startBottom));
      newX = startRight - newWidth; // Adjust X to keep right edge fixed
      newY = startBottom; // Keep bottom edge fixed
    }

    // Ensure field stays within bounds
    newX = Math.max(0, Math.min(1 - newWidth, newX));
    newY = Math.max(0, Math.min(1 - newHeight, newY));

    const updatedField = {
      ...selectedField,
      width: newWidth,
      height: newHeight,
      xPosition: newX,
      yPosition: newY
    };

    const updatedFields = fields.map(f => fieldsMatch(f, selectedField) ? updatedField : f);
    setFields(updatedFields);
    setSelectedField(updatedField);
  }, [isResizing, selectedField, resizeDirection, resizeStart, fields]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    setResizeDirection(null);
  }, []);

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

  const handleDeleteField = (field: SignatureField) => {
    if (field.templateId) {
      // Delete from backend
      apiService.delete(`/api/document-signatures/templates/${field.templateId}`).catch(console.error);
    }
    setFields(fields.filter(f => !fieldsMatch(f, field)));
    if (selectedField && fieldsMatch(selectedField, field)) {
      setSelectedField(null);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      const response = await apiService.post<{
        success: boolean;
        data: SignatureField[];
      }>('/api/document-signatures/templates', {
        documentId,
        fields: fields.map(f => ({
          templateId: f.templateId,
          fieldType: f.fieldType,
          fieldName: f.fieldName,
          xPosition: f.xPosition,
          yPosition: f.yPosition,
          width: f.width,
          height: f.height,
          pageNumber: f.pageNumber,
          isRequired: f.isRequired,
          autoFillType: f.autoFillType,
          fontSize: f.fontSize,
          isBold: f.isBold,
          textColor: f.textColor,
          backgroundColor: f.backgroundColor,
          fillBackground: f.fillBackground,
          textAlign: f.textAlign,
          dateFormat: f.dateFormat
        }))
      });

      if (response.success) {
        onSave();
      } else {
        setError('Failed to save template');
      }
    } catch (err: any) {
      console.error('Error saving template:', err);
      setError(err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  };

  const getFieldIcon = (fieldType: SignatureField['fieldType']) => {
    switch (fieldType) {
      case 'signature':
        return <PenTool className="h-4 w-4" />;
      case 'initial':
        return <Type className="h-4 w-4" />;
      case 'date':
        return <Calendar className="h-4 w-4" />;
      case 'text':
        return <Type className="h-4 w-4" />;
    }
  };

  const getPlaceholderText = (field: SignatureField): string => {
    if (field.autoFillType) {
      switch (field.autoFillType) {
        case 'TenantName':
          return '[Tenant Name]';
        case 'AgentName':
          return '[Agent Name]';
        case 'AgentEmail':
          return '[Agent Email]';
        case 'MemberName':
          return '[Member Name]';
        case 'GroupName':
          return '[Group Name]';
        case 'CurrentDate':
          // Show example date based on dateFormat
          if (field.fieldType === 'date' && field.dateFormat) {
            const exampleDate = new Date(2026, 0, 1); // Jan 1, 2026
            switch (field.dateFormat) {
              case 'short':
                return '1/1/26';
              case 'medium':
                return 'Jan 1, 2026';
              case 'long':
                return 'January 1, 2026';
              default:
                return '[Signature Date]';
            }
          }
          return '[Signature Date]';
        case 'UserEnteredDate':
          return '[User Entered Date]';
        case 'FirstOfMonth':
          // Calculate next 1st of month
          const now = new Date();
          const nextFirst = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          const [y, m, d] = nextFirst.toISOString().split('T')[0].split('-');
          return `[${m}/${d}/${y}]`;
        case 'CustomText':
          return '[Enter Text]';
        default:
          return '';
      }
    }
    if (field.fieldName) {
      return `[${field.fieldName}]`;
    }
    return `[${field.fieldType}]`;
  };

  const renderField = (field: SignatureField, index: number) => {
    if (field.pageNumber !== currentPage) return null;

    const isSelected = selectedField != null && fieldsMatch(selectedField, field);
    const left = field.xPosition * 100;
    const bottom = field.yPosition * 100;
    const width = field.width * 100;
    const height = field.height * 100;

    const placeholder = getPlaceholderText(field);

    // Determine background styling
    const shouldFillBackground = field.fillBackground !== false && (field.fieldType === 'text' || field.fieldType === 'date');
    const bgColor = shouldFillBackground 
      ? (field.backgroundColor || '#FFFFFF')
      : 'transparent';

    return (
      <div
        key={field.templateId || field.localId || `idx-${index}`}
        className={`absolute border-2 ${isDragging || isResizing ? 'cursor-grabbing' : 'cursor-move'} ${
          isSelected
            ? 'border-oe-primary bg-oe-primary-light bg-opacity-50'
            : 'border-gray-400 bg-oe-neutral-light bg-opacity-30'
        }`}
        style={{
          left: `${left}%`,
          bottom: `${bottom}%`,
          width: `${width}%`,
          height: `${height}%`,
          backgroundColor: bgColor
        }}
        onMouseDown={(e) => !isResizing && handleFieldMouseDown(e, field)}
        onClick={(e) => {
          e.stopPropagation();
          setSelectedField(field);
        }}
      >
        {/* Placeholder text inside field */}
        {(field.fieldType === 'text' || field.fieldType === 'date') ? (
          <div 
            className="absolute inset-0 flex pointer-events-none px-1"
            style={{
              color: field.textColor || '#000000',
              fontSize: `${field.fontSize || 12}pt`,
              fontWeight: field.isBold ? 'bold' : 'normal',
              padding: 0,
              lineHeight: '1.2',
              alignItems: 'start',
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

        {/* Field label */}
        <div className="absolute -top-6 left-0 flex items-center gap-1 bg-white px-1 rounded text-xs z-10">
          {getFieldIcon(field.fieldType)}
          <span className="capitalize">{field.fieldType}</span>
          {field.fieldName && <span className="text-gray-500">({field.fieldName})</span>}
        </div>

        {/* Delete button */}
        {isSelected && (
          <button
            className="absolute -top-6 right-0 p-1 bg-oe-error text-white rounded hover:bg-red-700 z-10"
            onClick={(e) => {
              e.stopPropagation();
              handleDeleteField(field);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}

        {/* Resize handles */}
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4" style={{ zIndex: 1500 }}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-6xl h-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">Edit Signature Fields</h2>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* PDF Viewer */}
          <div className="flex-1 overflow-auto p-4 bg-gray-100">
            {error && (
              <div className="mb-4 p-4 alert alert-error">
                <p className="text-oe-error">{error}</p>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                {/* Page Navigation */}
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

                {/* PDF Page */}
                <div
                  ref={pageRef}
                  className="relative bg-white shadow-lg cursor-crosshair"
                  onClick={handlePageClick}
                  style={{ minWidth: '800px' }}
                >
                  <Document
                    file={authenticatedDocumentUrl}
                    onLoadSuccess={onDocumentLoadSuccess}
                    loading={
                      <div className="flex items-center justify-center h-96">
                        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
                      </div>
                    }
                    error={
                      <div className="flex flex-col items-center justify-center h-96 p-4">
                        <p className="text-oe-error mb-2">Failed to load PDF</p>
                        <p className="text-sm text-gray-600 text-center">
                          {error || 'Please check that the document URL is valid and accessible.'}
                        </p>
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

                  {/* Render Fields */}
                  {fields.map((field, index) => renderField(field, index))}
                </div>

                <p className="mt-4 text-sm text-gray-600">
                  Click on the PDF to add a signature field. Drag fields to reposition them.
                </p>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="w-80 border-l border-gray-200 overflow-y-auto flex flex-col">
            <div className="p-4 space-y-4 flex-1">
              {/* Add Field Buttons */}
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">Add New Field</h3>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => addNewField('signature')}
                    className="px-3 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark text-sm flex items-center justify-center gap-1"
                  >
                    <PenTool className="h-4 w-4" />
                    Signature
                  </button>
                  <button
                    onClick={() => addNewField('initial')}
                    className="px-3 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark text-sm flex items-center justify-center gap-1"
                  >
                    <Type className="h-4 w-4" />
                    Initial
                  </button>
                  <button
                    onClick={() => addNewField('date')}
                    className="px-3 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark text-sm flex items-center justify-center gap-1"
                  >
                    <Calendar className="h-4 w-4" />
                    Date
                  </button>
                  <button
                    onClick={() => addNewField('text')}
                    className="px-3 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark text-sm flex items-center justify-center gap-1"
                  >
                    <Type className="h-4 w-4" />
                    Text
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  Or click on the PDF to add a field at that location
                </p>
              </div>

              <div className="border-t border-gray-200 pt-4">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Field Properties</h3>
                
                {selectedField ? (
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Field Type
                      </label>
                      <select
                        value={selectedField.fieldType}
                        onChange={(e) => {
                          const newFieldType = e.target.value as SignatureField['fieldType'];
                          const updated: SignatureField = { 
                            ...selectedField, 
                            fieldType: newFieldType,
                            // When changing to date, default to CurrentDate if no autoFillType is set
                            autoFillType: newFieldType === 'date' && !selectedField.autoFillType 
                              ? 'CurrentDate' 
                              : newFieldType !== 'date' && (selectedField.autoFillType === 'CurrentDate' || selectedField.autoFillType === 'UserEnteredDate' || selectedField.autoFillType === 'FirstOfMonth')
                                ? undefined
                                : selectedField.autoFillType,
                            // Set formatting defaults for text/date fields
                            fontSize: (newFieldType === 'text' || newFieldType === 'date') 
                              ? (selectedField.fontSize || 12)
                              : undefined,
                            isBold: (newFieldType === 'text' || newFieldType === 'date')
                              ? (selectedField.isBold !== undefined ? selectedField.isBold : false)
                              : false,
                            textColor: (newFieldType === 'text' || newFieldType === 'date')
                              ? (selectedField.textColor || '#000000')
                              : undefined,
                            backgroundColor: (newFieldType === 'text' || newFieldType === 'date')
                              ? (selectedField.backgroundColor || '#FFFFFF')
                              : undefined,
                            fillBackground: (newFieldType === 'text' || newFieldType === 'date')
                              ? (selectedField.fillBackground !== undefined ? selectedField.fillBackground : true)
                              : false,
                            textAlign: (newFieldType === 'text' || newFieldType === 'date')
                              ? (selectedField.textAlign || 'left')
                              : undefined,
                            dateFormat: newFieldType === 'date'
                              ? (selectedField.dateFormat || 'medium')
                              : undefined
                          };
                          setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                          setSelectedField(updated);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                      >
                        <option value="signature">Signature</option>
                        <option value="initial">Initial</option>
                        <option value="date">Date</option>
                        <option value="text">Text</option>
                      </select>
                    </div>

                    {/* Field Name - commented out as not required
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Field Name (optional)
                      </label>
                      <input
                        type="text"
                        value={selectedField.fieldName || ''}
                        onChange={(e) => {
                          const updated = { ...selectedField, fieldName: e.target.value || undefined };
                          setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                          setSelectedField(updated);
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        placeholder="e.g., TenantName, AgentName"
                      />
                    </div>
                    */}

                    {selectedField.fieldType === 'text' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          Auto-fill Type
                        </label>
                        <select
                          value={selectedField.autoFillType || ''}
                          onChange={(e) => {
                            const updated = { ...selectedField, autoFillType: e.target.value as SignatureField['autoFillType'] || undefined };
                            setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                            setSelectedField(updated);
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        >
                          <option value="">None</option>
                          <option value="TenantName">Tenant Name</option>
                          <option value="AgentName">Agent Name</option>
                          <option value="AgentEmail">Agent Email</option>
                          <option value="MemberName">Member Name</option>
                          <option value="GroupName">Group Name</option>
                          <option value="CustomText">Custom Text Entry</option>
                        </select>
                      </div>
                    )}

                    {selectedField.fieldType === 'date' && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Date Type
                          </label>
                          <select
                            value={selectedField.autoFillType || 'CurrentDate'}
                            onChange={(e) => {
                              const updated = { ...selectedField, autoFillType: e.target.value as SignatureField['autoFillType'] || 'CurrentDate' };
                              setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="CurrentDate">Signature Date</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Date Format
                          </label>
                          <select
                            value={selectedField.dateFormat || 'medium'}
                            onChange={(e) => {
                              const updated = { ...selectedField, dateFormat: e.target.value as 'short' | 'medium' | 'long' };
                              setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="short">Short (1/1/26)</option>
                            <option value="medium">Medium (Jan 1, 2026)</option>
                            <option value="long">Long (January 1, 2026)</option>
                          </select>
                          <p className="mt-1 text-xs text-gray-500">
                            How the date will be displayed when the document is signed
                          </p>
                        </div>
                      </>
                    )}

                    {/* Formatting options for text and date fields */}
                    {(selectedField.fieldType === 'text' || selectedField.fieldType === 'date') && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Font Size (pt)
                          </label>
                          <div className="flex gap-1 items-stretch">
                            <input
                              type="text"
                              inputMode="numeric"
                              autoComplete="off"
                              value={
                                selectedField.fontSize !== undefined && selectedField.fontSize !== null
                                  ? String(selectedField.fontSize)
                                  : ''
                              }
                              onChange={(e) => {
                                const value = e.target.value.replace(/[^\d]/g, '');
                                const updated = {
                                  ...selectedField,
                                  fontSize: value === '' ? undefined : parseInt(value, 10) || undefined
                                };
                                setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                setSelectedField(updated);
                              }}
                              onBlur={(e) => {
                                const value = e.target.value;
                                const n = parseInt(value, 10);
                                if (value === '' || !Number.isFinite(n) || n < FONT_SIZE_MIN || n > FONT_SIZE_MAX) {
                                  const updated = { ...selectedField, fontSize: FONT_SIZE_DEFAULT };
                                  setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                  setSelectedField(updated);
                                } else {
                                  const clamped = clampFontSize(n);
                                  if (clamped !== n) {
                                    const updated = { ...selectedField, fontSize: clamped };
                                    setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                    setSelectedField(updated);
                                  }
                                }
                              }}
                              onFocus={(e) => {
                                e.target.select();
                              }}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                              className="min-w-0 flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              tabIndex={0}
                              aria-label="Font size in points"
                            />
                            <div className="flex flex-col border border-gray-300 rounded-lg overflow-hidden shrink-0 bg-gray-50">
                              <button
                                type="button"
                                aria-label="Increase font size"
                                className="flex-1 px-2 flex items-center justify-center text-gray-700 hover:bg-gray-200 border-b border-gray-300"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const base = selectedField.fontSize ?? FONT_SIZE_DEFAULT;
                                  const updated = { ...selectedField, fontSize: clampFontSize(base + 1) };
                                  setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                  setSelectedField(updated);
                                }}
                              >
                                <ChevronUp className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                aria-label="Decrease font size"
                                className="flex-1 px-2 flex items-center justify-center text-gray-700 hover:bg-gray-200"
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  const base = selectedField.fontSize ?? FONT_SIZE_DEFAULT;
                                  const updated = { ...selectedField, fontSize: clampFontSize(base - 1) };
                                  setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                  setSelectedField(updated);
                                }}
                              >
                                <ChevronDown className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                        <div>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedField.isBold || false}
                              onChange={(e) => {
                                const updated = { ...selectedField, isBold: e.target.checked };
                                setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Bold</span>
                          </label>
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
                              setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                              setSelectedField(updated);
                            }}
                            className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
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
                                setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                setSelectedField(updated);
                              }}
                              className="w-4 h-4 text-oe-primary border-gray-300 rounded focus:ring-oe-primary"
                            />
                            <span className="text-sm font-medium text-gray-700">Fill Background</span>
                          </label>
                        </div>
                        {selectedField.fillBackground !== false && (
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                              Background Color
                            </label>
                            <input
                              type="color"
                              value={selectedField.backgroundColor || '#FFFFFF'}
                              onChange={(e) => {
                                const updated = { ...selectedField, backgroundColor: e.target.value };
                                setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                                setSelectedField(updated);
                              }}
                              className="w-full h-10 border border-gray-300 rounded-lg cursor-pointer"
                            />
                          </div>
                        )}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Text Alignment
                          </label>
                          <select
                            value={selectedField.textAlign || 'left'}
                            onChange={(e) => {
                              const updated = { ...selectedField, textAlign: e.target.value as 'left' | 'center' | 'right' };
                              setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                              setSelectedField(updated);
                            }}
                            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                          >
                            <option value="left">Left</option>
                            <option value="center">Center</option>
                            <option value="right">Right</option>
                          </select>
                        </div>
                      </>
                    )}

                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        id="isRequired"
                        checked={selectedField.isRequired}
                        onChange={(e) => {
                          const updated = { ...selectedField, isRequired: e.target.checked };
                          setFields(fields.map(f => fieldsMatch(f, selectedField) ? updated : f));
                          setSelectedField(updated);
                        }}
                        className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                      />
                      <label htmlFor="isRequired" className="ml-2 text-sm text-gray-700">
                        Required Field
                      </label>
                    </div>

                    <div className="pt-4 border-t border-gray-200 space-y-2">
                      <button
                        onClick={() => {
                          setSelectedField(null);
                        }}
                        className="w-full px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 flex items-center justify-center gap-2"
                      >
                        Done Editing
                      </button>
                      <button
                        onClick={() => handleDeleteField(selectedField)}
                        className="w-full px-4 py-2 btn-danger flex items-center justify-center gap-2"
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete Field
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-gray-500 space-y-2">
                    <p>Select a field to edit its properties, or add a new field above.</p>
                    {fields.length > 0 && (
                      <div className="mt-4">
                        <p className="text-xs font-medium text-gray-700 mb-2">Existing Fields ({fields.filter(f => f.pageNumber === currentPage).length})</p>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {fields
                            .filter(f => f.pageNumber === currentPage)
                            .map((field, idx) => (
                              <button
                                key={idx}
                                onClick={() => setSelectedField(field)}
                                className="w-full text-left px-2 py-1.5 text-xs border border-gray-200 rounded hover:bg-gray-50 flex items-center gap-2"
                              >
                                {getFieldIcon(field.fieldType)}
                                <span className="capitalize">{field.fieldType}</span>
                                {field.fieldName && <span className="text-gray-500">({field.fieldName})</span>}
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-gray-200">
                <h4 className="text-sm font-medium text-gray-700 mb-2">All Fields ({fields.length})</h4>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {fields
                    .filter(f => f.pageNumber === currentPage)
                    .map((field, index) => (
                      <div
                        key={index}
                        className={`p-2 rounded-lg cursor-pointer ${
                          selectedField != null && fieldsMatch(selectedField, field) ? 'bg-oe-primary-light border border-oe-primary' : 'bg-oe-neutral-light border border-gray-200'
                        }`}
                        onClick={() => setSelectedField(field)}
                      >
                        <div className="flex items-center gap-2">
                          {getFieldIcon(field.fieldType)}
                          <span className="text-sm capitalize">{field.fieldType}</span>
                          {field.fieldName && (
                            <span className="text-xs text-gray-500">({field.fieldName})</span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-4 p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 btn-primary flex items-center gap-2"
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

export default PDFSignerEditor;

