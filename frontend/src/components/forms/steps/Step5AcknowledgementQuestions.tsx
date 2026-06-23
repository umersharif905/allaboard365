import { Plus, Trash2 } from 'lucide-react';
import { StepProps, AcknowledgementQuestion } from '../../../types/sysadmin/addproductswizard.types';
import { FIELD_TYPES } from '../AddProductWizard';
import ProductQuestionnaireBuilder from './ProductQuestionnaireBuilder';

export default function Step5AcknowledgementQuestions({ formData, updateFormData }: StepProps) {
  const addAcknowledgementQuestion = () => {
    const newQuestion: AcknowledgementQuestion = {
      id: Date.now().toString(),
      question: '',
      fieldType: 'checkbox',
      required: false
    };
    updateFormData({
      acknowledgementQuestions: [...formData.acknowledgementQuestions, newQuestion]
    });
  };

  const updateAcknowledgementQuestion = (questionId: string, updates: Partial<AcknowledgementQuestion>) => {
    updateFormData({
      acknowledgementQuestions: formData.acknowledgementQuestions.map(q =>
        q.id === questionId ? { ...q, ...updates } : q
      )
    });
  };

  const removeAcknowledgementQuestion = (questionId: string) => {
    updateFormData({
      acknowledgementQuestions: formData.acknowledgementQuestions.filter(q => q.id !== questionId)
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h3 className="text-xl font-bold text-oe-text">Acknowledgement Questions</h3>
        <button
          onClick={addAcknowledgementQuestion}
          className="btn-primary flex items-center"
        >
          <Plus className="w-4 h-4 mr-2" />
          Add Question
        </button>
      </div>

      <div className="card bg-oe-light bg-opacity-20 border-oe-primary">
        <h4 className="font-semibold text-oe-primary mb-2">About Acknowledgement Questions</h4>
        <p className="text-sm text-oe-text">
          These questions will be presented during enrollment for members to acknowledge or answer. 
          You can trigger different actions based on their responses.
        </p>
      </div>

      {formData.acknowledgementQuestions.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <p className="text-oe-text">No acknowledgement questions added</p>
          <p className="text-sm text-gray-500 mt-1">These are optional for product enrollment</p>
        </div>
      ) : (
        <div className="space-y-4">
          {formData.acknowledgementQuestions.map((question, index) => (
            <div key={question.id} className="card hover-lift">
              <div className="flex justify-between items-start mb-4">
                <h4 className="font-semibold text-oe-text">Question {index + 1}</h4>
                <button
                  onClick={() => removeAcknowledgementQuestion(question.id)}
                  className="btn-danger p-2"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div className="md:col-span-2">
                  <label className="form-label">Question Text</label>
                  <textarea
                    value={question.question}
                    onChange={(e) => updateAcknowledgementQuestion(question.id, { question: e.target.value })}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter your question..."
                  />
                </div>

                <div>
                  <label className="form-label">Field Type</label>
                  <select
                    value={question.fieldType}
                    onChange={(e) => updateAcknowledgementQuestion(question.id, { fieldType: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    {FIELD_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="form-label">Custom Action</label>
                  <select
                    value={question.customAction || ''}
                    onChange={(e) => updateAcknowledgementQuestion(question.id, { customAction: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  >
                    <option value="">No Custom Action</option>
                    <option value="pricing">Trigger Different Pricing</option>
                    <option value="redirect">Redirect to Different Page</option>
                    <option value="show_fields">Show Additional Fields</option>
                  </select>
                </div>
              </div>

              {question.fieldType === 'dropdown' && (
                <div className="mb-4">
                  <label className="form-label">Dropdown Options</label>
                  <textarea
                    value={question.options?.join('\n') || ''}
                    onChange={(e) => {
                      const options = e.target.value.split('\n');
                      updateAcknowledgementQuestion(question.id, { options });
                    }}
                    onBlur={(e) => {
                      const options = e.target.value.split('\n').filter((opt: string) => opt.trim());
                      updateAcknowledgementQuestion(question.id, { options });
                    }}
                    rows={4}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Enter each option on a new line"
                    style={{ resize: 'vertical', minHeight: '100px' }}
                  />
                  <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <div className="text-xs text-blue-800">
                      <div className="font-semibold mb-1">💡 Instructions:</div>
                      <ul className="space-y-1 text-oe-primary-dark">
                        <li>• Enter each dropdown option on a separate line</li>
                        <li>• Press Enter to create a new option</li>
                        <li>• Empty lines will be automatically removed when you finish editing</li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center">
                <input
                  type="checkbox"
                  checked={question.required}
                  onChange={(e) => updateAcknowledgementQuestion(question.id, { required: e.target.checked })}
                  className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                />
                <label className="ml-2 form-label mb-0">Required Field</label>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Product Questionnaire Builder */}
      <ProductQuestionnaireBuilder formData={formData} updateFormData={updateFormData} />
    </div>
  );
}