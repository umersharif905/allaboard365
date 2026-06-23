import { useState, useEffect, useMemo, useRef } from 'react';
import { Plus, Trash2, ChevronDown, ChevronRight, Eye, Code, Copy, ExternalLink, Palette, FileText, Upload, Sparkles } from 'lucide-react';
import { StepProps } from '../../../types/sysadmin/addproductswizard.types';

// Strict type definitions matching mobile app structure
interface PlanHeader {
  Image: string;
  Text1: string;
  Text2: string;
  Background_color: string;
  Text_color: string;
}

interface PlanFooter {
  Header: string;
  Text1: string;
  Text2: string;
  Background_color: string;
  Text_color: string;
}

interface PlanBodySection {
  Number: string;
  Image: string;
  Header: string;
  Text1: string;
  Link_Name1: string;
  URL1: string;
  Link_Name2: string;
  URL2: string;
}

interface MobilePlanDetails {
  Plan_Data: {
    Header: PlanHeader;
    Footer: PlanFooter;
  };
  Plan_Body: {
    Body_Count: string;
    [key: string]: any;
  };
}

// Sample templates for common section types
const SECTION_TEMPLATES = {
  introduction: {
    Header: "INTRODUCTION",
    Text1: "Organization: [Your Organization]\nPurpose: This is a quick reference guide to help members understand key components of the health plan.\nFor full details: Members should consult the complete Member Guidelines.",
    Link_Name1: "Healthcare Shopping Tools",
    URL1: "https://",
    Link_Name2: "Member Portal",
    URL2: "https://"
  },
  unsharedAmount: {
    Header: "THE UNSHARED AMOUNT (UA)",
    Text1: "Definition:\n- The Unshared Amount is the member's initial financial responsibility before any Sharing Request becomes eligible for community sharing.\n\nUA Options:\n- $1,500\n- $3,000\n- $6,000",
    Link_Name1: "",
    URL1: "",
    Link_Name2: "",
    URL2: ""
  },
  maternity: {
    Header: "MATERNITY SHARING",
    Text1: "Expectant mothers pay a single Unshared Amount for all eligible expenses related to their Maternity.\n\nEligibility:\n- Pregnancy must occur at least 30 days after start date\n- Existing pregnancies prior to membership are not eligible",
    Link_Name1: "",
    URL1: "",
    Link_Name2: "",
    URL2: ""
  },
  contact: {
    Header: "CONTACT & RESOURCES",
    Text1: "For questions about your coverage, claims, or to find providers, please use the resources below.",
    Link_Name1: "Customer Service Portal",
    URL1: "https://",
    Link_Name2: "Provider Directory",
    URL2: "https://"
  }
};

export default function Step8PlanDetails({
  formData,
  updateFormData,
  existingMediaUrls,
  onOpenPlanDetailsGenerate,
}: StepProps & {
  existingMediaUrls?: { productImageUrl: string; productLogoUrl: string; productDocumentUrl: string };
  onOpenPlanDetailsGenerate?: () => void;
}) {
  const [activeTab, setActiveTab] = useState<'visual' | 'json'>('visual');
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0]));
  const [showPreview, setShowPreview] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const headerLogoBlobUrlRef = useRef<string | null>(null);

  // Initialize with proper structure
  useEffect(() => {
    if (!formData.planDetailsData || 
        !formData.planDetailsData.Plan_Data || 
        !formData.planDetailsData.Plan_Body) {
      
      const initialData: MobilePlanDetails = {
        Plan_Data: {
          Header: {
            Image: "",
            Text1: formData.name || "Member Guide Summary",
            Text2: "",
            Background_color: "#1f8dbf",
            Text_color: "#FFFFFF"
          },
          Footer: {
            Header: "Contact Information",
            Text1: "For Eligibility, Benefits & Customer Service",
            Text2: "(800) 555-0100",
            Background_color: "#FFFFFF",
            Text_color: "#000000"
          }
        },
        Plan_Body: {
          Body_Count: "1",
          Body1: {
            Number: "1",
            Image: "",
            Header: "INTRODUCTION",
            Text1: `Organization: ${formData.name || '[Product Name]'}\nPurpose: This is a quick reference guide to help members understand key components.\n\nFor full details:\nMembers should consult the complete Member Guidelines.`,
            Link_Name1: "",
            URL1: "",
            Link_Name2: "",
            URL2: ""
          }
        }
      };
      
      updateFormData({ planDetailsData: initialData });
    }
  }, []);

  const getBodySections = (): PlanBodySection[] => {
    if (!formData.planDetailsData?.Plan_Body) return [];
    
    const bodyCount = parseInt(formData.planDetailsData.Plan_Body.Body_Count || "0");
    const sections: PlanBodySection[] = [];
    
    for (let i = 1; i <= bodyCount; i++) {
      const section = formData.planDetailsData.Plan_Body[`Body${i}`];
      if (section && typeof section === 'object') {
        sections.push(section as PlanBodySection);
      }
    }
    
    return sections;
  };

  const addBodySection = (template?: keyof typeof SECTION_TEMPLATES) => {
    const sections = getBodySections();
    const newNumber = sections.length + 1;
    
    const newSection: PlanBodySection = template && SECTION_TEMPLATES[template]
      ? {
          Number: newNumber.toString(),
          Image: "",
          ...SECTION_TEMPLATES[template]
        }
      : {
          Number: newNumber.toString(),
          Image: "",
          Header: `Section ${newNumber}`,
          Text1: "",
          Link_Name1: "",
          URL1: "",
          Link_Name2: "",
          URL2: ""
        };
    
    const updatedData = { ...formData.planDetailsData };
    updatedData.Plan_Body.Body_Count = newNumber.toString();
    updatedData.Plan_Body[`Body${newNumber}`] = newSection;
    
    updateFormData({ planDetailsData: updatedData });
    
    // Auto-expand the new section
    setExpandedSections(prev => new Set([...prev, newNumber - 1]));
  };

  const removeBodySection = (index: number) => {
    const sections = getBodySections();
    if (sections.length <= 1) {
      alert("You must have at least one body section.");
      return;
    }
    
    const updatedData = { ...formData.planDetailsData };
    
    // Remove and reindex
    for (let i = index + 1; i < sections.length; i++) {
      const nextSection = { ...updatedData.Plan_Body[`Body${i + 1}`] };
      nextSection.Number = i.toString();
      updatedData.Plan_Body[`Body${i}`] = nextSection;
    }
    
    delete updatedData.Plan_Body[`Body${sections.length}`];
    updatedData.Plan_Body.Body_Count = (sections.length - 1).toString();
    
    updateFormData({ planDetailsData: updatedData });
  };

  const updateBodySection = (index: number, field: keyof PlanBodySection, value: string) => {
    const updatedData = { ...formData.planDetailsData };
    const sectionKey = `Body${index + 1}`;
    
    if (!updatedData.Plan_Body[sectionKey]) return;
    
    updatedData.Plan_Body[sectionKey][field] = value;
    updateFormData({ planDetailsData: updatedData });
  };

  const updateHeaderField = (field: keyof PlanHeader, value: string) => {
    if (!formData.planDetailsData?.Plan_Data?.Header) return;
    const updatedData = { ...formData.planDetailsData };
    updatedData.Plan_Data.Header[field] = value;
    updateFormData({ planDetailsData: updatedData });
  };

  const updateFooterField = (field: keyof PlanFooter, value: string) => {
    if (!formData.planDetailsData?.Plan_Data?.Footer) return;
    const updatedData = { ...formData.planDetailsData };
    updatedData.Plan_Data.Footer[field] = value;
    updateFormData({ planDetailsData: updatedData });
  };

  const toggleSection = (index: number) => {
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedSections(newExpanded);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(JSON.stringify(formData.planDetailsData, null, 2));
    alert('JSON copied to clipboard!');
  };

  const loadSampleData = () => {
    const sampleData: MobilePlanDetails = {
      Plan_Data: {
        Header: {
          Image: "sharewell.png",
          Text1: "Member Guide Summary",
          Text2: "",
          Background_color: "#b4b8b5",
          Text_color: "#000000"
        },
        Footer: {
          Header: "Contact Information",
          Text1: "For Eligibility, Benefits & Customer Service",
          Text2: "(904) 373-6872",
          Background_color: "#FFFFFF",
          Text_color: "#000000"
        }
      },
      Plan_Body: {
        Body_Count: "3",
        Body1: {
          Number: "1",
          Image: "",
          Header: "INTRODUCTION",
          Text1: "Organization: ShareWELL Purpose: \nThis is a quick reference guide to help members understand key components of the ShareWELL Health Sharing program. \nFor full details: \nMembers should consult the complete Member Guidelines.",
          Link_Name1: "Healthcare Shopping Tools",
          URL1: "https://sharewellhealth.org/advocacy-resources/",
          Link_Name2: "FullScript 35% Off Vitamins & Supplements",
          URL2: "https://us.fullscript.com/welcome/sharewell/store-start"
        },
        Body2: {
          Number: "2",
          Image: "",
          Header: "THE UNSHARED AMOUNT (UA)",
          Text1: "Definition:\n- The Unshared Amount is the member's initial financial responsibility before any Sharing Request becomes eligible for community sharing.\nUA Options:\n- $1,500\n- $3,000\n- $6,000",
          Link_Name1: "",
          URL1: "",
          Link_Name2: "",
          URL2: ""
        },
        Body3: {
          Number: "3",
          Image: "",
          Header: "MATERNITY SHARING",
          Text1: "Expectant mothers pay a single Unshared Amount for all eligible expenses related to their Maternity.\n\nEligibility:\n- Pregnancy must occur at least 30 days after start date",
          Link_Name1: "",
          URL1: "",
          Link_Name2: "",
          URL2: ""
        }
      }
    };
    
    updateFormData({ planDetailsData: sampleData });
  };

  // Handle logo file selection
  const handleLogoFileSelect = (file: File) => {
    // Store the file for upload during form submission
    updateFormData({ planDetailsHeaderLogoFile: file });
  };

  // Handle logo removal  
  const handleLogoRemove = () => {
    if (window.confirm('Are you sure you want to delete the current logo? This action cannot be undone.')) {
      // Clear the file from form data
      updateFormData({ planDetailsHeaderLogoFile: null });
      
      // Clear the image URL from the plan details data
      updateHeaderField('Image', '');
    }
  };

  // Get display info for header logo - create blob URL on-demand from file
  const headerLogoDisplay = useMemo(() => {
    const existingUrl = formData.planDetailsData?.Plan_Data?.Header?.Image || existingMediaUrls?.productLogoUrl;
    
    // Cleanup previous blob URL if file changed
    if (headerLogoBlobUrlRef.current) {
      URL.revokeObjectURL(headerLogoBlobUrlRef.current);
      headerLogoBlobUrlRef.current = null;
    }
    
    if (formData.planDetailsHeaderLogoFile) {
      // New file selected - create blob URL on-demand for preview
      const blobUrl = URL.createObjectURL(formData.planDetailsHeaderLogoFile);
      headerLogoBlobUrlRef.current = blobUrl;
      return {
        type: 'file' as const,
        name: formData.planDetailsHeaderLogoFile.name,
        url: blobUrl
      };
    } else if (existingUrl) {
      // Existing logo URL (only if no new file selected)
      return {
        type: 'existing' as const,
        url: existingUrl
      };
    }
    return null;
  }, [formData.planDetailsHeaderLogoFile, formData.planDetailsData?.Plan_Data?.Header?.Image, existingMediaUrls?.productLogoUrl]);

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      if (headerLogoBlobUrlRef.current) {
        URL.revokeObjectURL(headerLogoBlobUrlRef.current);
        headerLogoBlobUrlRef.current = null;
      }
    };
  }, []);

  const renderMobilePreview = () => (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setShowPreview(false)}>
      <div className="bg-white rounded-lg w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        {/* Mobile phone frame */}
        <div className="bg-gray-900 rounded-t-lg p-2 flex items-center justify-between">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-red-500 rounded-full"></div>
            <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
          </div>
          <span className="text-white text-xs">Mobile Preview</span>
          <button onClick={() => setShowPreview(false)} className="text-white hover:text-gray-300">
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
        
        <div className="bg-white max-h-[70vh] overflow-y-auto">
          {/* Header */}
          {formData.planDetailsData?.Plan_Data?.Header && (
            <div 
              className="p-6 text-center relative"
              style={{ 
                backgroundColor: formData.planDetailsData.Plan_Data.Header.Background_color || '#1f8dbf',
                color: formData.planDetailsData.Plan_Data.Header.Text_color || '#FFFFFF'
              }}
            >
              {headerLogoDisplay && (
                <div className="mb-3">
                  <img
                    src={headerLogoDisplay.url}
                    alt="Header logo"
                    className="mx-auto object-contain"
                    style={{ width: 'calc(100% - 30px)', height: 'auto', maxHeight: '120px' }}
                    onError={(e) => {
                      // Fallback to icon if image fails to load
                      e.currentTarget.style.display = 'none';
                      e.currentTarget.nextElementSibling?.classList.remove('hidden');
                    }}
                  />
                  <FileText className="w-32 h-32 mx-auto hidden" />
                </div>
              )}
              <h2 className="text-xl font-bold">{formData.planDetailsData.Plan_Data.Header.Text1}</h2>
              {formData.planDetailsData.Plan_Data.Header.Text2 && (
                <p className="text-sm mt-2 opacity-90">{formData.planDetailsData.Plan_Data.Header.Text2}</p>
              )}
            </div>
          )}
          
          {/* Body Sections */}
          <div className="p-4 space-y-4">
            {getBodySections().map((section, index) => (
              <div key={index} className="bg-white rounded-lg border border-gray-200 p-4 shadow-sm">
                <h3 className="font-bold text-gray-900 mb-3 text-lg">{section.Header}</h3>
                <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {section.Text1}
                </div>
                
                {/* Links */}
                <div className="mt-4 space-y-2">
                  {section.Link_Name1 && section.URL1 && (
                    <a 
                      href={section.URL1} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-oe-primary hover:text-blue-800 text-sm font-medium"
                      onClick={(e) => e.preventDefault()}
                    >
                      <ExternalLink className="w-4 h-4" />
                      {section.Link_Name1}
                    </a>
                  )}
                  
                  {section.Link_Name2 && section.URL2 && (
                    <a 
                      href={section.URL2} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-oe-primary hover:text-blue-800 text-sm font-medium"
                      onClick={(e) => e.preventDefault()}
                    >
                      <ExternalLink className="w-4 h-4" />
                      {section.Link_Name2}
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
          
          {/* Footer */}
          {formData.planDetailsData?.Plan_Data?.Footer && (
            <div 
              className="p-4 text-center border-t mt-4"
              style={{ 
                backgroundColor: formData.planDetailsData.Plan_Data.Footer.Background_color || '#FFFFFF',
                color: formData.planDetailsData.Plan_Data.Footer.Text_color || '#000000'
              }}
            >
              <h3 className="font-bold text-sm mb-2">{formData.planDetailsData.Plan_Data.Footer.Header}</h3>
              <p className="text-xs opacity-75">{formData.planDetailsData.Plan_Data.Footer.Text1}</p>
              <p className="text-lg font-bold mt-2">{formData.planDetailsData.Plan_Data.Footer.Text2}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (!formData.planDetailsData || !formData.planDetailsData.Plan_Data) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <p className="text-oe-text">Initializing plan details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Controls */}
      <div className="flex flex-col gap-4">
        <div className="flex justify-between items-center">
          <h3 className="text-xl font-bold text-oe-text">Mobile App Plan Details</h3>
          <div className="flex gap-2">
            <button
              onClick={() => setShowPreview(true)}
              className="btn-secondary flex items-center"
            >
              <Eye className="w-4 h-4 mr-2" />
              Preview Mobile
            </button>
            <button
              onClick={loadSampleData}
              className="btn-outline flex items-center"
            >
              <FileText className="w-4 h-4 mr-2" />
              Load Sample
            </button>
            {activeTab === 'json' && (
              <button
                onClick={copyToClipboard}
                className="btn-outline flex items-center"
              >
                <Copy className="w-4 h-4 mr-2" />
                Copy JSON
              </button>
            )}
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-gray-200">
          <button
            onClick={() => setActiveTab('visual')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'visual' 
                ? 'text-oe-primary border-b-2 border-oe-primary' 
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Visual Editor
          </button>
          <button
            onClick={() => setActiveTab('json')}
            className={`px-4 py-2 font-medium transition-colors ${
              activeTab === 'json' 
                ? 'text-oe-primary border-b-2 border-oe-primary' 
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <Code className="w-4 h-4 inline mr-2" />
            JSON Editor
          </button>
        </div>
      </div>

      {/* Info Card */}
      <div className="card bg-blue-50 border-blue-200">
        <div className="flex gap-3">
          <FileText className="w-5 h-5 text-oe-primary flex-shrink-0 mt-0.5" />
          <div>
            <h4 className="font-semibold text-blue-900 mb-1">Mobile Plan Details Structure</h4>
            <p className="text-sm text-blue-800">
              This content will be displayed in the mobile app as a scrollable guide with a header, 
              multiple body sections with optional links, and a footer with contact information.
              Each section supports rich text formatting and up to 2 external links.
            </p>
          </div>
        </div>
      </div>

      {activeTab === 'json' ? (
        /* JSON Editor */
        <div className="card">
          <textarea
            value={JSON.stringify(formData.planDetailsData, null, 2)}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                updateFormData({ planDetailsData: parsed });
              } catch (error) {
                // Invalid JSON - don't update
              }
            }}
            className="w-full h-[600px] px-4 py-3 font-mono text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary bg-gray-50"
            spellCheck={false}
          />
        </div>
      ) : (
        /* Visual Editor */
        <div className="space-y-6">
          {/* Header Section */}
          <div className="card">
            <h4 className="font-semibold text-oe-text mb-4 flex items-center">
              <Palette className="w-5 h-5 mr-2 text-oe-primary" />
              Header Section
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="form-label">Main Title</label>
                <input
                  type="text"
                  value={formData.planDetailsData?.Plan_Data?.Header?.Text1 || ''}
                  onChange={(e) => updateHeaderField('Text1', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  placeholder="Member Guide Summary"
                />
              </div>
              
              <div>
                <label className="form-label">Subtitle (Optional)</label>
                <input
                  type="text"
                  value={formData.planDetailsData?.Plan_Data?.Header?.Text2 || ''}
                  onChange={(e) => updateHeaderField('Text2', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  placeholder="Optional subtitle"
                />
              </div>
              
              <div>
                <label className="form-label">Logo/Image</label>
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-3">
                  {headerLogoDisplay ? (
                    <div className="space-y-3">
                      <div className="w-full h-32 flex items-center justify-center bg-gray-50 rounded-lg overflow-hidden">
                        <img
                          src={headerLogoDisplay.url}
                          alt="Header logo"
                          className="max-w-full max-h-full object-contain"
                          onError={(e) => {
                            // Fallback to icon if image fails to load
                            e.currentTarget.style.display = 'none';
                            e.currentTarget.nextElementSibling?.classList.remove('hidden');
                          }}
                        />
                        <FileText className="w-12 h-12 text-gray-400 hidden" />
                      </div>
                      <p className="text-sm text-gray-600 text-center">
                        {headerLogoDisplay.type === 'file' ? `New image: ${headerLogoDisplay.name}` : 'Current Logo'}
                      </p>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleLogoFileSelect(file);
                          // Reset input so same file can be selected again
                          e.target.value = '';
                        }}
                        className="hidden"
                        id="plan-header-logo-upload"
                      />
                      <div className="flex gap-2 justify-center">
                        <label htmlFor="plan-header-logo-upload" className="btn-primary cursor-pointer text-sm inline-block px-4 py-2">
                          Replace Logo
                        </label>
                        <button
                          onClick={handleLogoRemove}
                          className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete Logo"
                        >
                          <Trash2 className="w-5 h-5" />
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
                          if (file) handleLogoFileSelect(file);
                          // Reset input so same file can be selected again
                          e.target.value = '';
                        }}
                        className="hidden"
                        id="plan-header-logo-upload-new"
                      />
                      <label 
                        htmlFor="plan-header-logo-upload-new" 
                        className="text-sm text-oe-primary hover:text-oe-primary-dark cursor-pointer transition-colors"
                      >
                        Upload Image
                      </label>
                    </div>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  Upload will be processed when saving
                </p>
              </div>
              
              <div>
                <label className="form-label">Background Color</label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={formData.planDetailsData?.Plan_Data?.Header?.Background_color || '#1f8dbf'}
                    onChange={(e) => updateHeaderField('Background_color', e.target.value)}
                    className="w-14 h-10 border border-gray-300 rounded cursor-pointer"
                  />
                  <input
                    type="text"
                    value={formData.planDetailsData?.Plan_Data?.Header?.Background_color || '#1f8dbf'}
                    onChange={(e) => updateHeaderField('Background_color', e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    placeholder="#1f8dbf"
                  />
                </div>
              </div>
              
              <div>
                <label className="form-label">Text Color</label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={formData.planDetailsData?.Plan_Data?.Header?.Text_color || '#FFFFFF'}
                    onChange={(e) => updateHeaderField('Text_color', e.target.value)}
                    className="w-14 h-10 border border-gray-300 rounded cursor-pointer"
                  />
                  <input
                    type="text"
                    value={formData.planDetailsData?.Plan_Data?.Header?.Text_color || '#FFFFFF'}
                    onChange={(e) => updateHeaderField('Text_color', e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    placeholder="#FFFFFF"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Body Sections */}
          <div className="card">
            <div className="flex justify-between items-center mb-4">
              <h4 className="font-semibold text-oe-text flex items-center">
                <FileText className="w-5 h-5 mr-2 text-oe-primary" />
                Content Sections ({getBodySections().length})
              </h4>
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => onOpenPlanDetailsGenerate?.()}
                  className="btn-secondary text-sm inline-flex items-center gap-1.5"
                >
                  <Sparkles className="w-4 h-4" />
                  Generate from product document(s)
                </button>
                <button
                  type="button"
                  onClick={() => setShowTemplates(!showTemplates)}
                  className="btn-outline text-sm"
                >
                  Templates
                </button>
                <button
                  type="button"
                  onClick={() => addBodySection()}
                  className="btn-primary flex items-center"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Section
                </button>
              </div>
            </div>

            {/* Template Selector */}
            {showTemplates && (
              <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
                <p className="text-sm text-gray-600 mb-2">Quick Templates:</p>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(SECTION_TEMPLATES).map(template => (
                    <button
                      key={template}
                      onClick={() => {
                        addBodySection(template as keyof typeof SECTION_TEMPLATES);
                        setShowTemplates(false);
                      }}
                      className="px-3 py-1 bg-white border border-gray-300 rounded text-sm hover:bg-gray-100"
                    >
                      {template.charAt(0).toUpperCase() + template.slice(1).replace(/([A-Z])/g, ' $1')}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-4">
              {getBodySections().map((section, index) => (
                <div key={index} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div 
                    className="bg-gray-50 px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-100"
                    onClick={() => toggleSection(index)}
                  >
                    <div className="flex items-center gap-3">
                      <ChevronRight className={`w-5 h-5 text-gray-500 transition-transform ${expandedSections.has(index) ? 'rotate-90' : ''}`} />
                      <span className="font-medium text-gray-900">
                        Section {index + 1}: {section.Header || 'Untitled'}
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        removeBodySection(index);
                      }}
                      className="text-red-500 hover:text-red-700 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {expandedSections.has(index) && (
                    <div className="p-4 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2">
                          <label className="form-label">Section Title</label>
                          <input
                            type="text"
                            value={section.Header}
                            onChange={(e) => updateBodySection(index, 'Header', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            placeholder="Section Header"
                          />
                        </div>

                        <div className="col-span-2">
                          <label className="form-label">Content (Supports line breaks)</label>
                          <textarea
                            value={section.Text1}
                            onChange={(e) => updateBodySection(index, 'Text1', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            rows={6}
                            placeholder="Enter your content here. Use line breaks for formatting."
                          />
                        </div>

                        {/* External Links */}
                        <div className="col-span-2">
                          <h5 className="font-medium text-gray-700 mb-3 flex items-center">
                            <ExternalLink className="w-4 h-4 mr-2" />
                            External Links (Optional)
                          </h5>
                          
                          <div className="space-y-3">
                            {/* Link 1 */}
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="form-label text-sm">Link 1 Display Text</label>
                                <input
                                  type="text"
                                  value={section.Link_Name1}
                                  onChange={(e) => updateBodySection(index, 'Link_Name1', e.target.value)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  placeholder="e.g., Healthcare Shopping Tools"
                                />
                              </div>
                              <div>
                                <label className="form-label text-sm">Link 1 URL</label>
                                <input
                                  type="url"
                                  value={section.URL1}
                                  onChange={(e) => updateBodySection(index, 'URL1', e.target.value)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  placeholder="https://example.com/resource"
                                />
                              </div>
                            </div>

                            {/* Link 2 */}
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="form-label text-sm">Link 2 Display Text</label>
                                <input
                                  type="text"
                                  value={section.Link_Name2}
                                  onChange={(e) => updateBodySection(index, 'Link_Name2', e.target.value)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  placeholder="e.g., Member Portal"
                                />
                              </div>
                              <div>
                                <label className="form-label text-sm">Link 2 URL</label>
                                <input
                                  type="url"
                                  value={section.URL2}
                                  onChange={(e) => updateBodySection(index, 'URL2', e.target.value)}
                                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                                  placeholder="https://example.com/portal"
                                />
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="col-span-2">
                          <label className="form-label">Optional Image Filename</label>
                          <input
                            type="text"
                            value={section.Image}
                            onChange={(e) => updateBodySection(index, 'Image', e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                            placeholder="section-image.png (optional)"
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Footer Section */}
          <div className="card">
            <h4 className="font-semibold text-oe-text mb-4 flex items-center">
              <Palette className="w-5 h-5 mr-2 text-oe-primary" />
              Footer Section
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="form-label">Footer Title</label>
                <input
                  type="text"
                  value={formData.planDetailsData?.Plan_Data?.Footer?.Header || ''}
                  onChange={(e) => updateFooterField('Header', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  placeholder="Contact Information"
                />
              </div>
              
              <div>
                <label className="form-label">Description Text</label>
                <input
                  type="text"
                  value={formData.planDetailsData?.Plan_Data?.Footer?.Text1 || ''}
                  onChange={(e) => updateFooterField('Text1', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  placeholder="For questions and support"
                />
              </div>
              
              <div>
                <label className="form-label">Contact Info (Phone/Email)</label>
                <input
                  type="text"
                  value={formData.planDetailsData?.Plan_Data?.Footer?.Text2 || ''}
                  onChange={(e) => updateFooterField('Text2', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                  placeholder="(800) 555-0100"
                />
              </div>
              
              <div>
                <label className="form-label">Background Color</label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={formData.planDetailsData?.Plan_Data?.Footer?.Background_color || '#FFFFFF'}
                    onChange={(e) => updateFooterField('Background_color', e.target.value)}
                    className="w-14 h-10 border border-gray-300 rounded cursor-pointer"
                  />
                  <input
                    type="text"
                    value={formData.planDetailsData?.Plan_Data?.Footer?.Background_color || '#FFFFFF'}
                    onChange={(e) => updateFooterField('Background_color', e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    placeholder="#FFFFFF"
                  />
                </div>
              </div>
              
              <div>
                <label className="form-label">Text Color</label>
                <div className="flex gap-2">
                  <input
                    type="color"
                    value={formData.planDetailsData?.Plan_Data?.Footer?.Text_color || '#000000'}
                    onChange={(e) => updateFooterField('Text_color', e.target.value)}
                    className="w-14 h-10 border border-gray-300 rounded cursor-pointer"
                  />
                  <input
                    type="text"
                    value={formData.planDetailsData?.Plan_Data?.Footer?.Text_color || '#000000'}
                    onChange={(e) => updateFooterField('Text_color', e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    placeholder="#000000"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mobile Preview Modal */}
      {showPreview && renderMobilePreview()}
    </div>
  );
}