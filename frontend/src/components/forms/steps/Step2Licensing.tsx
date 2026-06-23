import { Info } from 'lucide-react';
import { StepProps } from '../../../types/sysadmin/addproductswizard.types';
import { LICENSE_DESCRIPTIONS, REQUIRED_LICENSES } from '../AddProductWizard';

export default function Step2Licensing({ formData, updateFormData }: StepProps) {
  const handleLicenseChange = (license: string, checked: boolean) => {
    let newLicenses = [...formData.requiredLicenses];

    if (license === 'None') {
      newLicenses = checked ? ['None'] : newLicenses.filter(l => l !== 'None');
    } else {
      if (checked) {
        newLicenses = newLicenses.filter(l => l !== 'None');
        if (!newLicenses.includes(license)) {
          newLicenses.push(license);
        }
      } else {
        newLicenses = newLicenses.filter(l => l !== license);
      }
    }

    updateFormData({ requiredLicenses: newLicenses });
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-xl font-bold text-oe-text">Product Licensing</h3>
        <p className="text-sm text-gray-600">
          Select the licenses that are required to market and enroll members into this product.
        </p>
      </div>

      <div>
        <label className="form-label">Required Licenses *</label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {REQUIRED_LICENSES.map(license => {
            const licenseInfo = LICENSE_DESCRIPTIONS[license as keyof typeof LICENSE_DESCRIPTIONS];
            return (
              <label key={license} className="flex items-start cursor-pointer group">
                <input
                  type="checkbox"
                  checked={formData.requiredLicenses.includes(license)}
                  onChange={(e) => handleLicenseChange(license, e.target.checked)}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5"
                />
                <div className="ml-2 flex-1">
                  <div className="flex items-center group-hover:text-oe-primary transition-colors">
                    <span className="text-sm font-medium">{license}</span>
                    <div className="relative ml-2 group/tooltip">
                      <Info className="h-4 w-4 text-oe-primary hover:text-oe-dark cursor-help" size={16} />
                      <div className="absolute left-0 top-6 z-50 w-80 p-3 bg-oe-dark text-white text-xs rounded-lg shadow-lg opacity-0 invisible group-hover/tooltip:opacity-100 group-hover/tooltip:visible transition-all duration-200">
                        <div className="font-semibold mb-2 text-oe-light">{license}</div>
                        <div className="mb-2 text-gray-200">{licenseInfo?.description}</div>
                        <div className="text-gray-300">
                          <span className="font-medium">Products:</span> {licenseInfo?.products}
                        </div>
                        <div className="absolute -top-1 left-2 w-2 h-2 bg-oe-dark rotate-45"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </label>
            );
          })}
        </div>
        {formData.requiredLicenses.length === 0 && (
          <p className="text-oe-error text-sm mt-1">Please select at least one license requirement</p>
        )}
      </div>
    </div>
  );
}


