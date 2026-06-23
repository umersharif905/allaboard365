// frontend/src/components/enrollment-wizard/steps/CategoryStep.tsx
import { Activity, Cross, Eye, FileText, Heart, Phone } from 'lucide-react';
import React, { useEffect } from 'react';
import { type LicenseValidationProduct } from '../components/PerProductLicenseValidationSummary';
import ProductSectionCard from '../components/ProductSectionCard';
import { AvailableProductType, WizardProductSection, WizardStepProps } from '../types/wizard.types';

interface CategoryStepProps extends WizardStepProps {
  categoryId: string;
  categoryLabel: string;
  categoryEmoji: string;
  categoryDescription: string;
  productType: string;
  defaultPage: string;
  availableProductTypes: AvailableProductType[];
  tenantId?: string;
  groupId?: string;
  mustBeSoldWithByProductId?: Record<string, { mustBeSoldWithProductIds: string[]; mustBeSoldWithProductNames: string[] }>;
  licenseValidationProducts?: LicenseValidationProduct[];
  isLicenseValidationLoading?: boolean;
  onFixLicenses?: () => void;
}

const getCategoryIcon = (productType: string) => {
  switch (productType) {
    case 'Healthcare':
      return <Cross className="h-8 w-8 text-oe-primary" />;
    case 'Dental':
      return <Activity className="h-8 w-8 text-oe-primary" />;
    case 'Vision':
      return <Eye className="h-8 w-8 text-oe-primary" />;
    case 'Life Insurance':
      return <Heart className="h-8 w-8 text-oe-primary" />;
    case 'Telemedicine':
      return <Phone className="h-8 w-8 text-oe-primary" />;
    case 'Other':
      return <FileText className="h-8 w-8 text-oe-primary" />;
    default:
      return <FileText className="h-8 w-8 text-oe-primary" />;
  }
};

const CategoryStep: React.FC<CategoryStepProps> = ({
  data,
  onDataChange,
  categoryId,
  categoryLabel,
  categoryEmoji,
  categoryDescription,
  productType,
  defaultPage,
  availableProductTypes,
  tenantId,
  groupId,
  mustBeSoldWithByProductId,
  licenseValidationProducts,
  isLicenseValidationLoading,
  onFixLicenses
}) => {
  // Get or create section for this category
  let section = data.products.find(p => p.productType === productType);
  const sectionIndex = data.products.findIndex(p => p.productType === productType);

  // Ensure section exists on mount (only for non-Healthcare sections)
  useEffect(() => {
    const existingSection = data.products.find(p => p.productType === productType);
    if (!existingSection) {
      const newSection: WizardProductSection = {
        id: `${categoryId}-${Date.now()}`,
        page: defaultPage,
        productType: productType,
        description: categoryDescription,
        specificProducts: [],
        includeAllProducts: false,
        sectionType: 'products'
      };
      
      onDataChange({
        products: [...data.products, newSection]
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // If section doesn't exist yet (on first render), show loading
  if (!section) {
    section = {
      id: `${categoryId}-temp`,
      page: defaultPage,
      productType: productType,
      description: categoryDescription,
      specificProducts: [],
      includeAllProducts: false,
      sectionType: 'products'
    };
  }

  const updateProductSection = (updates: Partial<WizardProductSection>) => {
    // Recalculate sectionIndex dynamically in case the section was just created
    const currentSectionIndex = data.products.findIndex(p => p.productType === productType);
    
    // If section doesn't exist, create it first
    if (currentSectionIndex === -1) {
      const newSection: WizardProductSection = {
        id: `${categoryId}-${Date.now()}`,
        page: defaultPage,
        productType: productType,
        description: categoryDescription,
        specificProducts: [],
        includeAllProducts: false,
        sectionType: 'products',
        ...updates
      };
      
      onDataChange({
        products: [...data.products, newSection]
      });
      return;
    }
    
    // Update existing section
    const updatedProducts = data.products.map((product, i) => 
      i === currentSectionIndex ? { ...product, ...updates } : product
    );
    onDataChange({ products: updatedProducts });
  };

  return (
    <div>
      {/* Category Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-blue-50 rounded-lg">
          {getCategoryIcon(productType)}
        </div>
        <div>
          <h3 className="text-xl font-semibold text-gray-900">{categoryLabel}</h3>
          <p className="text-sm text-gray-600">{categoryDescription}</p>
        </div>
      </div>

      {/* Product Selection Card */}
      <ProductSectionCard
        section={section}
        availableProductTypes={availableProductTypes}
        onUpdate={(updates) => updateProductSection(updates)}
        onRemove={() => {}}
        canRemove={false}
        tenantId={tenantId}
        templateType={data.templateType}
        groupId={groupId}
        index={sectionIndex}
        totalSections={data.products.length}
        onMoveUp={() => {}}
        onMoveDown={() => {}}
        mustBeSoldWithByProductId={mustBeSoldWithByProductId}
        licenseValidationProducts={licenseValidationProducts}
        isLicenseValidationLoading={isLicenseValidationLoading}
        onFixLicenses={onFixLicenses}
      />
    </div>
  );
};

export default CategoryStep;

