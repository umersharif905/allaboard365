import { Check } from 'lucide-react';

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
  stepOrder: number[];
}

export default function StepIndicator({ currentStep, totalSteps, stepOrder }: StepIndicatorProps) {
  const isStepCompleted = (step: number) => {
    if (step === 10) {
      // Step 10 (Required ASA) is completed when we're on step 10 or beyond
      return currentStep >= 10;
    } else if (step === 11) {
      // Step 11 (Review) is completed when we're on step 11
      return currentStep >= 11;
    } else {
      // Regular steps are completed when current step is greater
      return currentStep > step;
    }
  };

  return (
    <div className="flex items-center justify-center mb-8">
      {stepOrder.map((step, index) => (
        <div key={step} className="flex items-center">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-all duration-200 ${
            step === currentStep 
              ? 'bg-oe-primary text-white shadow-lg transform scale-105' 
              : isStepCompleted(step)
                ? 'bg-oe-success text-white' 
                : 'bg-gray-200 text-gray-600'
          }`}>
            {isStepCompleted(step) ? <Check className="w-5 h-5" /> : step}
          </div>
          {index < stepOrder.length - 1 && (
            <div className={`w-12 h-1 mx-2 transition-all duration-200 ${
              isStepCompleted(step) ? 'bg-oe-success' : 'bg-gray-200'
            }`} />
          )}
        </div>
      ))}
    </div>
  );
}
