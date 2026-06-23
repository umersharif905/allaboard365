import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  ProductQuestionnaire,
  ProductQuestionnaireQuestion,
  StepProps
} from '../../../types/sysadmin/addproductswizard.types';

const QUESTION_TYPES: { value: ProductQuestionnaireQuestion['type']; label: string }[] = [
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'text', label: 'Single Line Text' },
  { value: 'textarea', label: 'Multi-line Text' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'number', label: 'Number' }
];

const defaultQuestionnaire: ProductQuestionnaire = {
  version: 1,
  enabled: true,
  title: '',
  description: '',
  questions: [],
  acknowledgement: {
    required: false,
    text: ''
  },
  requiresHeightWeight: false
};

export default function ProductQuestionnaireBuilder({ formData, updateFormData }: StepProps) {
  const [isExpanded, setIsExpanded] = useState(!!formData.productQuestionnaires?.enabled);

  const questionnaire = formData.productQuestionnaires || defaultQuestionnaire;
  const isEnabled = questionnaire.enabled;

  const updateQuestionnaire = (updates: Partial<ProductQuestionnaire>) => {
    updateFormData({
      productQuestionnaires: { ...questionnaire, ...updates }
    });
  };

  const toggleEnabled = () => {
    if (isEnabled) {
      // Turning off — keep data but mark disabled
      updateFormData({
        productQuestionnaires: { ...questionnaire, enabled: false }
      });
    } else {
      // Turning on
      updateFormData({
        productQuestionnaires: { ...questionnaire, enabled: true }
      });
      setIsExpanded(true);
    }
  };

  // --- Question CRUD ---

  const addQuestion = () => {
    const newQuestion: ProductQuestionnaireQuestion = {
      id: crypto.randomUUID?.() || Date.now().toString(),
      text: '',
      type: 'yes_no',
      required: true
    };
    updateQuestionnaire({
      questions: [...questionnaire.questions, newQuestion]
    });
  };

  const updateQuestion = (questionId: string, updates: Partial<ProductQuestionnaireQuestion>) => {
    updateQuestionnaire({
      questions: questionnaire.questions.map(q =>
        q.id === questionId ? { ...q, ...updates } : q
      )
    });
  };

  const removeQuestion = (questionId: string) => {
    updateQuestionnaire({
      questions: questionnaire.questions.filter(q => q.id !== questionId)
    });
  };

  const moveQuestion = (index: number, direction: 'up' | 'down') => {
    const questions = [...questionnaire.questions];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= questions.length) return;
    [questions[index], questions[targetIndex]] = [questions[targetIndex], questions[index]];
    updateQuestionnaire({ questions });
  };

  return (
    <div className="mt-8 border-t border-gray-200 pt-6">
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center w-full text-left"
      >
        {isExpanded ? (
          <ChevronDown className="w-5 h-5 mr-2 text-oe-primary" />
        ) : (
          <ChevronRight className="w-5 h-5 mr-2 text-oe-primary" />
        )}
        <h3 className="text-xl font-bold text-oe-text">Product Questionnaire</h3>
        <span className="ml-2 text-sm text-gray-500">(Optional)</span>
      </button>

      {isExpanded && (
        <div className="mt-4 space-y-6">
          {/* Info card */}
          <div className="card bg-oe-light bg-opacity-20 border-oe-primary">
            <h4 className="font-semibold text-oe-primary mb-2">About Product Questionnaires</h4>
            <p className="text-sm text-oe-text">
              Attach a questionnaire to this product that members must complete during enrollment.
              The title you set becomes the step name in the enrollment wizard.
              This is useful for pre-existing condition disclosures, health surveys, or any product-specific questions.
            </p>
          </div>

          {/* Enable toggle */}
          <div className="flex items-center">
            <input
              type="checkbox"
              id="questionnaire-enabled"
              checked={isEnabled}
              onChange={toggleEnabled}
              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
            />
            <label htmlFor="questionnaire-enabled" className="ml-2 font-semibold text-oe-text">
              Enable Product Questionnaire
            </label>
          </div>

          {isEnabled && (
            <div className="space-y-6 pl-2 border-l-2 border-oe-primary ml-2">
              {/* Title & Description */}
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="form-label">Questionnaire Title</label>
                  <input
                    type="text"
                    value={questionnaire.title}
                    onChange={(e) => updateQuestionnaire({ title: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="e.g. Major Pre-Existing Conditions Notice"
                  />
                  <p className="text-xs text-gray-500 mt-1">This becomes the tab/step name in the enrollment wizard.</p>
                </div>
                <div>
                  <label className="form-label">Description</label>
                  <textarea
                    value={questionnaire.description}
                    onChange={(e) => updateQuestionnaire({ description: e.target.value })}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    placeholder="Description text shown to the member during enrollment..."
                  />
                </div>
              </div>

              {/* Questions section */}
              <div>
                <div className="flex justify-between items-center mb-3">
                  <h4 className="font-semibold text-oe-text">Questions</h4>
                  <button
                    type="button"
                    onClick={addQuestion}
                    className="btn-primary flex items-center text-sm"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    Add Question
                  </button>
                </div>

                {questionnaire.questions.length === 0 ? (
                  <div className="text-center py-6 text-gray-500 border border-dashed border-gray-300 rounded-md">
                    <p className="text-oe-text">No questions added yet</p>
                    <p className="text-sm text-gray-500 mt-1">Click "Add Question" to get started</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {questionnaire.questions.map((question, index) => (
                      <div key={question.id} className="card hover-lift">
                        <div className="flex justify-between items-start mb-4">
                          <h4 className="font-semibold text-oe-text">Question {index + 1}</h4>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => moveQuestion(index, 'up')}
                              disabled={index === 0}
                              className="p-1.5 text-gray-400 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Move up"
                            >
                              <ArrowUp className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveQuestion(index, 'down')}
                              disabled={index === questionnaire.questions.length - 1}
                              className="p-1.5 text-gray-400 hover:text-oe-primary disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Move down"
                            >
                              <ArrowDown className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeQuestion(question.id)}
                              className="btn-danger p-2"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                          <div className="md:col-span-2">
                            <label className="form-label">Question Text</label>
                            <textarea
                              value={question.text}
                              onChange={(e) => updateQuestion(question.id, { text: e.target.value })}
                              rows={2}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="Enter your question..."
                            />
                          </div>

                          <div>
                            <label className="form-label">Answer Type</label>
                            <select
                              value={question.type}
                              onChange={(e) => updateQuestion(question.id, { type: e.target.value as ProductQuestionnaireQuestion['type'] })}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                            >
                              {QUESTION_TYPES.map(type => (
                                <option key={type.value} value={type.value}>{type.label}</option>
                              ))}
                            </select>
                          </div>

                          <div className="flex flex-col gap-2 pt-6">
                            <div className="flex items-center">
                              <input
                                type="checkbox"
                                checked={question.required}
                                onChange={(e) => updateQuestion(question.id, { required: e.target.checked })}
                                className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                              />
                              <label className="ml-2 form-label mb-0">Required</label>
                            </div>
                            {question.type === 'yes_no' && (
                              <div className="flex items-center">
                                <input
                                  type="checkbox"
                                  checked={question.triggersConditionalAcknowledgement || false}
                                  onChange={(e) => updateQuestion(question.id, { triggersConditionalAcknowledgement: e.target.checked })}
                                  className="h-4 w-4 text-amber-500 focus:ring-amber-500 border-gray-300 rounded"
                                />
                                <label className="ml-2 text-sm text-amber-700 font-medium">Triggers conditional acknowledgement</label>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Dropdown options */}
                        {question.type === 'dropdown' && (
                          <div className="mb-4">
                            <label className="form-label">Dropdown Options</label>
                            <textarea
                              value={question.options?.join('\n') || ''}
                              onChange={(e) => {
                                const options = e.target.value.split('\n');
                                updateQuestion(question.id, { options });
                              }}
                              onBlur={(e) => {
                                const options = e.target.value.split('\n').filter((opt: string) => opt.trim());
                                updateQuestion(question.id, { options });
                              }}
                              rows={4}
                              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                              placeholder="Enter each option on a new line"
                              style={{ resize: 'vertical', minHeight: '80px' }}
                            />
                            <p className="text-xs text-gray-500 mt-1">Enter each dropdown option on a separate line.</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Acknowledgement section */}
              <div className="border-t border-gray-200 pt-4">
                <h4 className="font-semibold text-oe-text mb-3">Acknowledgement</h4>
                <div className="flex items-center mb-3">
                  <input
                    type="checkbox"
                    id="questionnaire-ack-required"
                    checked={questionnaire.acknowledgement.required}
                    onChange={(e) =>
                      updateQuestionnaire({
                        acknowledgement: {
                          ...questionnaire.acknowledgement,
                          required: e.target.checked
                        }
                      })
                    }
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <label htmlFor="questionnaire-ack-required" className="ml-2 form-label mb-0">
                    Require acknowledgement checkbox
                  </label>
                </div>
                {questionnaire.acknowledgement.required && (
                  <div>
                    <label className="form-label">Acknowledgement Text</label>
                    <textarea
                      value={questionnaire.acknowledgement.text}
                      onChange={(e) =>
                        updateQuestionnaire({
                          acknowledgement: {
                            ...questionnaire.acknowledgement,
                            text: e.target.value
                          }
                        })
                      }
                      rows={2}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="e.g. I acknowledge that I have read and understand the above information."
                    />
                  </div>
                )}
              </div>

              {/* Conditional Acknowledgement section */}
              <div className="border-t border-gray-200 pt-4">
                <h4 className="font-semibold text-oe-text mb-2">Conditional Acknowledgement</h4>
                <p className="text-xs text-gray-500 mb-3">
                  This acknowledgement only appears when a member answers "Yes" to a question marked as a trigger above.
                </p>
                <div className="flex items-center mb-3">
                  <input
                    type="checkbox"
                    id="questionnaire-conditional-ack-required"
                    checked={questionnaire.conditionalAcknowledgement?.required || false}
                    onChange={(e) =>
                      updateQuestionnaire({
                        conditionalAcknowledgement: {
                          ...questionnaire.conditionalAcknowledgement,
                          required: e.target.checked,
                          text: questionnaire.conditionalAcknowledgement?.text || ''
                        }
                      })
                    }
                    className="h-4 w-4 text-amber-500 focus:ring-amber-500 border-gray-300 rounded"
                  />
                  <label htmlFor="questionnaire-conditional-ack-required" className="ml-2 form-label mb-0">
                    Require conditional acknowledgement
                  </label>
                </div>
                {questionnaire.conditionalAcknowledgement?.required && (
                  <div>
                    <label className="form-label">Conditional Acknowledgement Text</label>
                    <textarea
                      value={questionnaire.conditionalAcknowledgement?.text || ''}
                      onChange={(e) =>
                        updateQuestionnaire({
                          conditionalAcknowledgement: {
                            ...questionnaire.conditionalAcknowledgement,
                            required: true,
                            text: e.target.value
                          }
                        })
                      }
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                      placeholder='e.g. I understand that coverage eligibility and limitations are governed by the Member Guidelines...'
                    />
                    {questionnaire.questions.filter(q => q.triggersConditionalAcknowledgement).length === 0 && (
                      <p className="text-xs text-amber-600 mt-1">
                        No questions are marked as triggers yet. Mark at least one Yes/No question with "Triggers conditional acknowledgement" above.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Health Metrics section */}
              <div className="border-t border-gray-200 pt-4">
                <h4 className="font-semibold text-oe-text mb-3">Health Metrics</h4>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="questionnaire-height-weight"
                    checked={questionnaire.requiresHeightWeight}
                    onChange={(e) => updateQuestionnaire({ requiresHeightWeight: e.target.checked })}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
                  />
                  <label htmlFor="questionnaire-height-weight" className="ml-2 form-label mb-0">
                    Require Height/Weight
                  </label>
                </div>
                <p className="text-xs text-gray-500 mt-1 ml-6">
                  When enabled, height and weight fields will appear in the member info step during enrollment.
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
