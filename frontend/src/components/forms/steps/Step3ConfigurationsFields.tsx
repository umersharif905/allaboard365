import { Plus, Trash2, DollarSign } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfigurationField, StepProps } from '../../../types/sysadmin/addproductswizard.types';
import { MAX_CONFIGURATION_FIELDS } from '../AddProductWizard';

export default function Step3ConfigurationFields({ formData, updateFormData }: StepProps) {
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);

  // Check if any field is already marked as deductible
  const hasDeductibleField = formData.configurationFields.some(f => f.isDeductible);
  
  // Helper to check if all options are numeric
  const areAllOptionsNumeric = (options: string[]) => {
    return options.every(opt => {
      if (!opt.trim()) return true; // Empty options are ok (will be filtered)
      const num = parseFloat(opt.trim());
      return !isNaN(num) && isFinite(num);
    });
  };

  // Auto-select first field when fields are added or when selected field is deleted
  useEffect(() => {
    if (formData.configurationFields.length > 0) {
      if (!selectedFieldId || !formData.configurationFields.find(f => f.id === selectedFieldId)) {
        setSelectedFieldId(formData.configurationFields[0].id);
      }
    } else {
      setSelectedFieldId(null);
    }
  }, [formData.configurationFields, selectedFieldId]);

  const addConfigurationField = () => {
    if (formData.configurationFields.length >= MAX_CONFIGURATION_FIELDS) {
      alert(`Maximum of ${MAX_CONFIGURATION_FIELDS} configuration fields allowed`);
      return;
    }

    const newField: ConfigurationField = {
      id: Date.now().toString(),
      fieldName: '',
      fieldOptions: [''],
      isDeductible: false
    };
    updateFormData({
      configurationFields: [...formData.configurationFields, newField]
    });
  };

  const updateConfigurationField = (fieldId: string, updates: Partial<ConfigurationField>) => {
    // If setting isDeductible to true, ensure no other field has it
    if (updates.isDeductible === true) {
      updateFormData({
        configurationFields: formData.configurationFields.map(field =>
          field.id === fieldId 
            ? { ...field, ...updates } 
            : { ...field, isDeductible: false }
        )
      });
    } else {
    updateFormData({
      configurationFields: formData.configurationFields.map(field =>
        field.id === fieldId ? { ...field, ...updates } : field
      )
    });
    }
  };

  const removeConfigurationField = (fieldId: string) => {
    updateFormData({
      configurationFields: formData.configurationFields.filter(field => field.id !== fieldId)
    });
  };

  const addConfigOption = (fieldId: string) => {
    const field = formData.configurationFields.find(f => f.id === fieldId);
    if (field) {
      updateConfigurationField(fieldId, {
        fieldOptions: [...field.fieldOptions, '']
      });
    }
  };

  const updateConfigOption = (fieldId: string, optionIndex: number, value: string) => {
    const field = formData.configurationFields.find(f => f.id === fieldId);
    if (field) {
      const newOptions = [...field.fieldOptions];
      newOptions[optionIndex] = value;
      updateConfigurationField(fieldId, {
        fieldOptions: newOptions
      });
    }
  };

  const removeConfigOption = (fieldId: string, optionIndex: number) => {
    const field = formData.configurationFields.find(f => f.id === fieldId);
    if (field && field.fieldOptions.length > 1) {
      const newOptions = field.fieldOptions.filter((_, index) => index !== optionIndex);
      updateConfigurationField(fieldId, {
        fieldOptions: newOptions
      });
    }
  };

  const selectedField = formData.configurationFields.find(f => f.id === selectedFieldId);

  return (
    <div className="space-y-6" data-testid="step3-configuration-fields">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-oe-text">Configuration Fields (Optional - Max {MAX_CONFIGURATION_FIELDS})</h3>
        <button
          onClick={addConfigurationField}
          disabled={formData.configurationFields.length >= MAX_CONFIGURATION_FIELDS}
          className={`btn-primary flex items-center ${
            formData.configurationFields.length >= MAX_CONFIGURATION_FIELDS
              ? 'opacity-50 cursor-not-allowed'
              : ''
          }`}
          data-testid="add-field-button"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Configuration Field
        </button>
      </div>

      <div className="card bg-oe-light bg-opacity-20 border-oe-primary">
        <h4 className="font-semibold text-oe-primary mb-2">About Configuration Fields</h4>
        <p className="text-sm text-oe-text">
          Configuration fields allow you to add custom data fields to your pricing tiers. 
          Define field names and their possible values here, then assign specific values 
          to each age band in the pricing step. <strong>Maximum {MAX_CONFIGURATION_FIELDS} fields allowed.</strong>
        </p>
      </div>

      {formData.configurationFields.length >= MAX_CONFIGURATION_FIELDS && (
        <div className="card bg-oe-warning bg-opacity-10 border-oe-warning">
          <h4 className="font-semibold text-oe-warning mb-2">Maximum Limit Reached</h4>
          <p className="text-sm text-oe-warning">
            You have reached the maximum limit of {MAX_CONFIGURATION_FIELDS} configuration fields. 
            Remove a field to add a new one.
          </p>
        </div>
      )}

      {formData.configurationFields.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-oe-text text-lg mb-2">No configuration fields added yet</p>
          <p className="text-sm text-gray-500 mb-4">Click "Add Configuration Field" to get started</p>
          <button
            onClick={addConfigurationField}
            className="btn-primary flex items-center mx-auto"
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Configuration Field
          </button>
        </div>
      ) : (
        <div className="flex gap-6" style={{ height: 'calc(100vh - 400px)', minHeight: '400px' }} data-testid="configuration-fields-container">
          {/* Left Panel - Field List */}
          <div className="w-80 flex-shrink-0 flex flex-col" data-testid="configuration-fields-sidebar">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-semibold text-sm text-gray-700">Configuration Fields</h4>
              <button
                onClick={addConfigurationField}
                disabled={formData.configurationFields.length >= MAX_CONFIGURATION_FIELDS}
                className={`btn-primary flex items-center text-sm ${
                  formData.configurationFields.length >= MAX_CONFIGURATION_FIELDS
                    ? 'opacity-50 cursor-not-allowed'
                    : ''
                }`}
              >
                <Plus className="w-3 h-3 mr-1" />
                Add Field
              </button>
            </div>
            <div className="flex-1 overflow-y-auto pr-2">
              <div className="space-y-2">
                {formData.configurationFields.map((field, index) => {
                  const isSelected = selectedFieldId === field.id;
                  
                  return (
                    <div
                      key={field.id}
                      onClick={() => setSelectedFieldId(field.id)}
                      className={`group p-3 rounded-lg border-2 cursor-pointer transition-all ${
                        isSelected 
                          ? 'border-oe-primary bg-blue-50' 
                          : field.isDeductible 
                            ? 'border-green-300 hover:border-green-400 bg-green-50'
                          : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1">
                          <div className="font-medium text-sm text-oe-text flex items-center gap-2">
                            {field.fieldName || `Field ${index + 1}`}
                            {field.isDeductible && (
                              <span className="inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded bg-green-100 text-green-700">
                                <DollarSign className="w-3 h-3 mr-0.5" />
                                Deductible
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-600 mt-1">
                            {field.fieldOptions.length} option{field.fieldOptions.length !== 1 ? 's' : ''}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {field.fieldOptions.filter(opt => opt.trim()).length} defined
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeConfigurationField(field.id);
                          }}
                          className="btn-danger p-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right Panel - Selected Field Details */}
          <div className="flex-1 flex flex-col min-w-0" data-testid="configuration-fields-main">
            <div className="flex justify-between items-center mb-3">
              <h4 className="font-semibold text-sm text-gray-700">Field Configuration</h4>
              {selectedField && (
                <button
                  onClick={() => addConfigOption(selectedField.id)}
                  className="btn-secondary text-sm"
                  data-testid="add-option-button"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add Option
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto pr-2">
              {selectedField ? (
                <div className="space-y-6">
                  <div className="card">
                    <div className="space-y-4">
                      <div>
                        <label className="form-label">Field Name *</label>
                        <input
                          type="text"
                          value={selectedField.fieldName}
                          onChange={(e) => updateConfigurationField(selectedField.id, { fieldName: e.target.value })}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="e.g., Coverage Level, Network Type, Plan Design"
                          data-testid="field-name-input"
                        />
                      </div>

                      {/* Deductible Toggle */}
                      <div className={`p-4 rounded-lg border-2 ${selectedField.isDeductible ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <DollarSign className={`w-5 h-5 ${selectedField.isDeductible ? 'text-green-600' : 'text-gray-400'}`} />
                            <div>
                              <label className="font-medium text-sm text-gray-900">
                                Mark as Deductible or Unshared Amount
                              </label>
                              <p className="text-xs text-gray-500 mt-0.5">
                                {selectedField.isDeductible 
                                  ? 'This field represents the member\'s deductible/unshared amount'
                                  : hasDeductibleField && !selectedField.isDeductible
                                    ? 'Another field is already marked as deductible'
                                    : 'Enable if this field represents a deductible amount'
                                }
                              </p>
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedField.isDeductible || false}
                              onChange={(e) => {
                                const newValue = e.target.checked;
                                // Validate options are numeric if enabling deductible
                                if (newValue && !areAllOptionsNumeric(selectedField.fieldOptions)) {
                                  alert('All field options must be numeric values (e.g., 1500, 3000, 6000) for a deductible field.');
                                  return;
                                }
                                updateConfigurationField(selectedField.id, { isDeductible: newValue });
                              }}
                              disabled={hasDeductibleField && !selectedField.isDeductible}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-green-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600 ${hasDeductibleField && !selectedField.isDeductible ? 'opacity-50 cursor-not-allowed' : ''}`}></div>
                          </label>
                        </div>
                        {selectedField.isDeductible && !areAllOptionsNumeric(selectedField.fieldOptions) && (
                          <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded-md">
                            <p className="text-xs text-red-600 font-medium">
                              ⚠️ Warning: Deductible fields require all options to be numeric values
                            </p>
                          </div>
                        )}
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <label className="form-label mb-0">
                            Field Options *
                            {selectedField.isDeductible && (
                              <span className="ml-2 text-xs text-green-600 font-normal">(numeric values only)</span>
                            )}
                          </label>
                          <button
                            onClick={() => addConfigOption(selectedField.id)}
                            className="btn-secondary text-sm"
                          >
                            <Plus className="w-3 h-3 mr-1" />
                            Add Option
                          </button>
                        </div>
                        
                        <div className="space-y-2">
                          {selectedField.fieldOptions.map((option, optionIndex) => {
                            const isNumeric = !option.trim() || !isNaN(parseFloat(option.trim()));
                            const showError = selectedField.isDeductible && option.trim() && !isNumeric;
                            
                            return (
                            <div key={optionIndex} className="flex gap-2 items-center">
                              <input
                                  type={selectedField.isDeductible ? 'number' : 'text'}
                                value={option}
                                onChange={(e) => updateConfigOption(selectedField.id, optionIndex, e.target.value)}
                                  className={`w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary flex-1 ${
                                    showError ? 'border-red-300 bg-red-50' : 'border-gray-300'
                                  }`}
                                  placeholder={selectedField.isDeductible ? `e.g., ${1500 + optionIndex * 1500}` : `Option ${optionIndex + 1}`}
                              />
                              {selectedField.fieldOptions.length > 1 && (
                                <button
                                  onClick={() => removeConfigOption(selectedField.id, optionIndex)}
                                  className="btn-danger p-2"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                            );
                          })}
                        </div>
                        <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-md">
                          <div className="text-xs text-gray-600">
                            <div className="font-semibold mb-1">💡 Instructions:</div>
                            <ul className="space-y-1">
                              <li>• Each option will be available as a choice in pricing tiers</li>
                              {selectedField.isDeductible ? (
                                <>
                                  <li>• <strong>Deductible fields must use numeric values</strong> (e.g., 1500, 3000, 6000)</li>
                                  <li>• These represent the member's unshared/deductible amounts</li>
                                </>
                              ) : (
                              <li>• Use descriptive names like "High Coverage", "Standard Plan", etc.</li>
                              )}
                              <li>• Click "Add Option" to create additional choices</li>
                              <li>• These values will be selectable when configuring age bands</li>
                            </ul>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <p className="text-oe-text">Select a configuration field to edit</p>
                  <p className="text-sm text-gray-500 mt-1">Choose a field from the list to configure its options</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}