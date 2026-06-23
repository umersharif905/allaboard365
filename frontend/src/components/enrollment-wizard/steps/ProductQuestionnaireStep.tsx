// frontend/src/components/enrollment-wizard/steps/ProductQuestionnaireStep.tsx
import React from 'react';

const isLocalhost = () => {
  if (typeof window === 'undefined') return false;
  const host = (window.location.hostname || '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
};

export interface QuestionnaireQuestion {
  id: string;
  text: string;
  type: 'yes_no' | 'text' | 'textarea' | 'checkbox' | 'dropdown' | 'number';
  required: boolean;
  options?: string[];
  triggersConditionalAcknowledgement?: boolean;
}

export interface QuestionnaireData {
  productId: string;
  productName: string;
  version: number;
  enabled: boolean;
  title: string;
  description: string;
  questions: QuestionnaireQuestion[];
  acknowledgement: {
    required: boolean;
    text: string;
  };
  conditionalAcknowledgement?: {
    required: boolean;
    text: string;
  };
  requiresHeightWeight: boolean;
}

export interface QuestionnaireResponses {
  [questionId: string]: string | boolean | number;
}

interface ProductQuestionnaireStepProps {
  questionnaires: QuestionnaireData[];
  responses: QuestionnaireResponses;
  acknowledged: boolean;
  conditionalAcknowledged: boolean;
  onResponseChange: (questionId: string, answer: string | boolean | number) => void;
  onAcknowledgementChange: (acknowledged: boolean) => void;
  onConditionalAcknowledgementChange: (acknowledged: boolean) => void;
  onNext: () => void;
  onBack: () => void;
  // Height/Weight — collected here when product requires it, stored on Members table
  requiresHeightWeight?: boolean;
  height?: number;        // total inches
  weight?: number;        // pounds
  onHeightChange?: (height: number | undefined) => void;
  onWeightChange?: (weight: number | undefined) => void;
}

/**
 * Validate that all required questions are answered and acknowledgements are accepted.
 */
/**
 * Check if any trigger question has been answered "yes" across all questionnaires.
 */
export const hasTriggeredConditionalAcknowledgement = (
  questionnaires: QuestionnaireData[],
  responses: QuestionnaireResponses
): boolean => {
  for (const q of questionnaires) {
    if (!q.enabled || !q.conditionalAcknowledgement?.required) continue;
    for (const question of q.questions) {
      if (!question.triggersConditionalAcknowledgement) continue;
      const answer = responses[question.id];
      if (answer === true || answer === 'yes') return true;
    }
  }
  return false;
};

export const validateQuestionnaire = (
  questionnaires: QuestionnaireData[],
  responses: QuestionnaireResponses,
  acknowledged: boolean,
  requiresHeightWeight?: boolean,
  height?: number,
  weight?: number,
  conditionalAcknowledged?: boolean
): boolean => {
  for (const q of questionnaires) {
    if (!q.enabled) continue;

    // Check all required questions have answers
    for (const question of q.questions) {
      if (!question.required) continue;
      const answer = responses[question.id];
      if (answer === undefined || answer === null || answer === '') {
        return false;
      }
    }

    // Check acknowledgement
    if (q.acknowledgement?.required && !acknowledged) {
      return false;
    }

    // Check conditional acknowledgement if triggered
    if (q.conditionalAcknowledgement?.required) {
      const isTriggered = hasTriggeredConditionalAcknowledgement([q], responses);
      if (isTriggered && !conditionalAcknowledged) {
        return false;
      }
    }
  }

  // Check height/weight if required
  if (requiresHeightWeight) {
    if (!height || !weight) return false;
  }

  return true;
};

const ProductQuestionnaireStep: React.FC<ProductQuestionnaireStepProps> = ({
  questionnaires,
  responses,
  acknowledged,
  conditionalAcknowledged,
  onResponseChange,
  onAcknowledgementChange,
  onConditionalAcknowledgementChange,
  onNext,
  onBack,
  requiresHeightWeight,
  height,
  weight,
  onHeightChange,
  onWeightChange
}) => {
  const isValid = validateQuestionnaire(questionnaires, responses, acknowledged, requiresHeightWeight, height, weight, conditionalAcknowledged);
  const showConditionalAck = hasTriggeredConditionalAcknowledgement(questionnaires, responses);

  // Dev-only: fill every required question with a safe default so localhost testing of
  // later wizard steps isn't gated by manual answers on every reload.
  const handleAutofill = () => {
    for (const questionnaire of questionnaires.filter(q => q.enabled)) {
      for (const question of questionnaire.questions) {
        switch (question.type) {
          case 'yes_no':
            // "No" avoids triggering the conditional acknowledgement — pick the simplest path through the form.
            onResponseChange(question.id, false);
            break;
          case 'text':
          case 'textarea':
            onResponseChange(question.id, 'Test response');
            break;
          case 'checkbox':
            onResponseChange(question.id, true);
            break;
          case 'dropdown':
            onResponseChange(question.id, (question.options && question.options[0]) || '');
            break;
          case 'number':
            onResponseChange(question.id, 0);
            break;
        }
      }
      if (questionnaire.acknowledgement?.required) {
        onAcknowledgementChange(true);
      }
    }
    if (requiresHeightWeight && onHeightChange && onWeightChange) {
      onHeightChange(70);  // 5'10"
      onWeightChange(170);
    }
  };

  const renderQuestion = (question: QuestionnaireQuestion) => {
    const value = responses[question.id];

    switch (question.type) {
      case 'yes_no': {
        const isYes = value === true || value === 'yes';
        const isNo = value === false || value === 'no';
        return (
          <div className="flex gap-3 mt-1">
            <button
              type="button"
              onClick={() => onResponseChange(question.id, true)}
              className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                isYes
                  ? 'bg-oe-primary border-oe-primary text-white'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => onResponseChange(question.id, false)}
              className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
                isNo
                  ? 'bg-oe-primary border-oe-primary text-white'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              No
            </button>
          </div>
        );
      }

      case 'text':
        return (
          <input
            type="text"
            value={(value as string) || ''}
            onChange={(e) => onResponseChange(question.id, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            placeholder="Enter your answer"
          />
        );

      case 'textarea':
        return (
          <textarea
            value={(value as string) || ''}
            onChange={(e) => onResponseChange(question.id, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            rows={3}
            placeholder="Enter your answer"
          />
        );

      case 'checkbox':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!value}
              onChange={(e) => onResponseChange(question.id, e.target.checked)}
              className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded"
            />
            <span className="text-sm text-gray-700">Yes</span>
          </label>
        );

      case 'dropdown':
        return (
          <select
            value={(value as string) || ''}
            onChange={(e) => onResponseChange(question.id, e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">Select an option</option>
            {(question.options || []).map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        );

      case 'number':
        return (
          <input
            type="number"
            value={value !== undefined && value !== null ? String(value) : ''}
            onChange={(e) => onResponseChange(question.id, e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            placeholder="Enter a number"
          />
        );

      default:
        return null;
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      {questionnaires.filter(q => q.enabled).map((questionnaire) => (
        <div key={questionnaire.productId}>
          {/* Header */}
          <div className="text-center mb-8">
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">{questionnaire.title}</h2>
            {questionnaire.description && (
              <p className="text-gray-600 leading-relaxed">{questionnaire.description}</p>
            )}
          </div>

          {/* Questions Card */}
          <div className="card">
            <div className="space-y-6">
              {questionnaire.questions.map((question) => (
                <div key={question.id}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {question.text}
                    {question.required && <span className="text-red-500 ml-1">*</span>}
                  </label>
                  {renderQuestion(question)}
                </div>
              ))}
            </div>

            {/* Height & Weight — below questions, above acknowledgement */}
            {requiresHeightWeight && onHeightChange && onWeightChange && (
              <div className="mt-6 pt-6 border-t border-gray-200">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Height & Weight</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Height <span className="text-red-500">*</span></label>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <input
                          type="number"
                          value={height !== undefined ? Math.floor(height / 12) || '' : ''}
                          onChange={(e) => {
                            const feet = e.target.value === '' ? 0 : Number(e.target.value);
                            const currentInches = height !== undefined ? (height % 12) : 0;
                            onHeightChange(feet * 12 + currentInches);
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="Feet"
                          min={3}
                          max={7}
                        />
                      </div>
                      <span className="flex items-center text-sm text-gray-500">ft</span>
                      <div className="flex-1">
                        <input
                          type="number"
                          value={height !== undefined ? (height % 12) : ''}
                          onChange={(e) => {
                            const inches = e.target.value === '' ? 0 : Number(e.target.value);
                            const currentFeet = height !== undefined ? Math.floor(height / 12) : 5;
                            onHeightChange(currentFeet * 12 + inches);
                          }}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                          placeholder="Inches"
                          min={0}
                          max={11}
                        />
                      </div>
                      <span className="flex items-center text-sm text-gray-500">in</span>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Weight (lbs) <span className="text-red-500">*</span></label>
                    <input
                      type="number"
                      value={weight || ''}
                      onChange={(e) => onWeightChange(e.target.value === '' ? undefined : Number(e.target.value))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Enter weight in pounds"
                      min={1}
                      max={999}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* Acknowledgement — at the bottom */}
            {questionnaire.acknowledgement?.required && questionnaire.acknowledgement.text && (
              <div className="mt-6 pt-6 border-t border-gray-200">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => onAcknowledgementChange(e.target.checked)}
                    className="h-4 w-4 text-oe-primary focus:ring-oe-primary border-gray-300 rounded mt-0.5 flex-shrink-0"
                  />
                  <span className="text-sm text-gray-700 leading-relaxed">
                    {questionnaire.acknowledgement.text}
                    <span className="text-red-500 ml-1">*</span>
                  </span>
                </label>
              </div>
            )}

            {/* Conditional Acknowledgement — only appears when a trigger question is answered "yes" */}
            {showConditionalAck && questionnaire.conditionalAcknowledgement?.required && questionnaire.conditionalAcknowledgement.text && (
              <div className="mt-4 p-4 bg-amber-50 border border-amber-300 rounded-lg transition-all duration-300">
                <div className="flex items-center mb-3">
                  <span className="text-amber-600 text-lg mr-2">&#9888;</span>
                  <h4 className="text-sm font-semibold text-amber-800">Additional Acknowledgement Required</h4>
                </div>
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={conditionalAcknowledged}
                    onChange={(e) => onConditionalAcknowledgementChange(e.target.checked)}
                    className="h-4 w-4 text-amber-600 focus:ring-amber-500 border-amber-400 rounded mt-0.5 flex-shrink-0"
                  />
                  <span className="text-sm text-amber-900 leading-relaxed">
                    {questionnaire.conditionalAcknowledgement.text}
                    <span className="text-red-500 ml-1">*</span>
                  </span>
                </label>
              </div>
            )}
          </div>
        </div>
      ))}

      {/* Navigation Buttons */}
      <div className="flex justify-between mt-6">
        <button
          onClick={onBack}
          className="btn-secondary"
        >
          Back
        </button>
        <div className="flex flex-col items-end gap-2">
          {isLocalhost() && (
            <button
              type="button"
              onClick={handleAutofill}
              className="px-3 py-2 rounded-lg border border-oe-primary text-oe-primary hover:bg-oe-light transition-colors text-sm font-medium"
            >
              Autofill
            </button>
          )}
          <button
            onClick={onNext}
            disabled={!isValid}
            className="btn-primary"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProductQuestionnaireStep;
