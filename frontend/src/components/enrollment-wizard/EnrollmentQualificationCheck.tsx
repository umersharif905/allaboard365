import { AlertCircle, Calendar, Clock, RefreshCw, User } from 'lucide-react';
import React from 'react';
import { EnrollmentService } from '../../services/enrollment.service';

interface QualificationCheckProps {
  linkToken: string;
  onQualified: () => void;
  onNotQualified: () => void;
}

interface EffectiveDatesResponse {
  enrollmentType: 'Group' | 'Individual';
  memberQualified: boolean;
  qualificationMessage: string;
  effectiveDateOptions: {
    type: 'fixed' | 'dropdown' | 'calendar';
    fixedDate?: string;
    availableDates?: string[];
    dateRange?: {
      earliest: string;
      latest: string;
    };
    restrictions: {
      mustBeFirstOfMonth: boolean;
      maxDaysInFuture: number;
    };
  } | null;
}

const EnrollmentQualificationCheck: React.FC<QualificationCheckProps> = ({
  linkToken,
  onQualified,
  onNotQualified
}) => {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [qualificationData, setQualificationData] = React.useState<EffectiveDatesResponse | null>(null);

  const checkQualification = async () => {
    try {
      setLoading(true);
      setError(null);

      const result = await EnrollmentService.getEffectiveDates(linkToken);

      if (!result.success) {
        throw new Error(result.message || 'Failed to check enrollment qualification');
      }

      const data = result.data as EffectiveDatesResponse;
      setQualificationData(data);

      // Determine if member is qualified
      if (!data.memberQualified) {
        onNotQualified();
      } else {
        onQualified();
      }
    } catch (err) {
      console.error('❌ Error checking qualification:', err);
      setError(err instanceof Error ? err.message : 'Failed to check enrollment qualification');
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    checkQualification();
  }, [linkToken]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Checking Enrollment Eligibility</h2>
          <p className="text-gray-600">Please wait while we verify your enrollment qualification...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-6">
            <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Unable to Verify Eligibility</h2>
            <p className="text-gray-600">We encountered an error while checking your enrollment qualification.</p>
          </div>
          
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-800 text-sm">{error}</p>
          </div>
          
          <button
            onClick={checkQualification}
            className="w-full flex items-center justify-center px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (!qualificationData?.memberQualified) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="max-w-2xl w-full bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-8">
            <AlertCircle className="h-16 w-16 text-red-600 mx-auto mb-4" />
            <h2 className="text-2xl font-semibold text-gray-900 mb-2">Enrollment Not Available</h2>
            <p className="text-gray-600">You do not qualify for enrollment at this time</p>
          </div>
          
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6">
            <div className="flex items-start">
              <AlertCircle className="h-5 w-5 text-red-600 mr-3 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="text-lg font-medium text-red-900 mb-2">Qualification Issue</h3>
                <p className="text-red-800 text-sm leading-relaxed">
                  {qualificationData?.qualificationMessage || 'You do not meet the requirements for enrollment at this time.'}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-6">
            <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center">
              <User className="h-4 w-4 mr-2" />
              What This Means
            </h4>
            <div className="text-sm text-gray-600 space-y-2">
              <p>• Your enrollment link is valid, but you don't currently qualify for benefits</p>
              <p>• This is typically due to hire date requirements or timing restrictions</p>
              <p>• Please contact your Group Administrator or HR department for assistance</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={checkQualification}
              className="flex-1 flex items-center justify-center px-4 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Check Again
            </button>
            <button
              onClick={() => window.close()}
              className="flex-1 px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If qualified, show a brief success message before proceeding
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
        <div className="mb-6">
          <Calendar className="h-16 w-16 text-green-600 mx-auto mb-4" />
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Enrollment Available</h2>
          <p className="text-gray-600">You qualify for enrollment! Let's get started.</p>
        </div>
        
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-center text-green-800 text-sm">
            <Clock className="h-4 w-4 mr-2" />
            {qualificationData?.effectiveDateOptions?.type === 'fixed' && qualificationData?.effectiveDateOptions?.fixedDate
              ? `Benefits start: ${new Date(qualificationData.effectiveDateOptions.fixedDate).toLocaleDateString()}`
              : 'You can choose your effective date during enrollment'
            }
          </div>
        </div>

        <button
          onClick={onQualified}
          className="w-full px-4 py-3 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
        >
          Continue to Enrollment
        </button>
      </div>
    </div>
  );
};

export default EnrollmentQualificationCheck;
