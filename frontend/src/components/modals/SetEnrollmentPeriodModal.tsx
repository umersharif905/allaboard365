import { AlertCircle, Calendar, CheckCircle, Info } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { GroupsService } from '../../services/groups.service';
import { apiService } from '../../services/api.service';

interface SetEnrollmentPeriodModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  groupName: string;
  onPeriodSet: () => void;
  existingPeriod?: {
    startDate: string;
    endDate: string;
    benefitStartDate: string;
    earliestEffectiveDate?: string;
  } | null;
}

const SetEnrollmentPeriodModal: React.FC<SetEnrollmentPeriodModalProps> = ({
  isOpen,
  onClose,
  groupId,
  groupName,
  onPeriodSet,
  existingPeriod
}) => {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [earliestEffectiveDate, setEarliestEffectiveDate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [benefitStartDate, setBenefitStartDate] = useState<string | null>(null);
  const [availableEarliestDates, setAvailableEarliestDates] = useState<string[]>([]);
  const [originalBenefitStartDate, setOriginalBenefitStartDate] = useState<string | null>(null);
  const [showBenefitDateWarning, setShowBenefitDateWarning] = useState(false);
  const [hasExistingEnrollments, setHasExistingEnrollments] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);

  // Generate available earliest effective dates (always exactly 3 options: 1st of month for 3 months after period ends)
  const generateEarliestEffectiveDateOptions = (periodEndDate: string): string[] => {
    if (!periodEndDate) return [];
    
    const end = new Date(periodEndDate + 'T00:00:00');
    const dates: string[] = [];
    
    // Always generate exactly 3 options: the 1st of the month for the 3 months following the period end date
    for (let i = 1; i <= 3; i++) {
      const date = new Date(end.getFullYear(), end.getMonth() + i, 1);
      dates.push(date.toISOString().split('T')[0]);
    }
    
    return dates;
  };

  // Calculate benefit start date and available earliest effective dates when end date changes
  useEffect(() => {
    if (endDate) {
      const end = new Date(endDate);
      const benefitStart = new Date(end.getFullYear(), end.getMonth() + 1, 1);
      setBenefitStartDate(benefitStart.toISOString().split('T')[0]);
      
      // Generate available earliest effective dates
      const availableDates = generateEarliestEffectiveDateOptions(endDate);
      setAvailableEarliestDates(availableDates);
      
      // Set default earliest effective date if not already set
      if (!earliestEffectiveDate || !availableDates.includes(earliestEffectiveDate)) {
        setEarliestEffectiveDate(benefitStart.toISOString().split('T')[0]);
      }
    } else {
      setBenefitStartDate(null);
      setAvailableEarliestDates([]);
    }
  }, [endDate]);

  // Set default or existing dates when modal opens
  useEffect(() => {
    console.log('🔍 Modal useEffect triggered:', { isOpen, existingPeriod });
    if (isOpen) {
      if (existingPeriod) {
        // Pre-populate with existing dates for editing
        console.log('📅 Loading existing dates:', existingPeriod);
        setStartDate(existingPeriod.startDate);
        setEndDate(existingPeriod.endDate);
        
        // Set earliest effective date if it exists, otherwise calculate default
        const end = new Date(existingPeriod.endDate + 'T00:00:00');
        const defaultEarliest = new Date(end.getFullYear(), end.getMonth() + 1, 1);
        if (existingPeriod.earliestEffectiveDate) {
          setEarliestEffectiveDate(existingPeriod.earliestEffectiveDate);
        } else {
          // Calculate default from end date
          setEarliestEffectiveDate(defaultEarliest.toISOString().split('T')[0]);
        }
        
        // Store original benefit start date for comparison
        const originalBenefitStart = new Date(end.getFullYear(), end.getMonth() + 1, 1);
        setOriginalBenefitStartDate(originalBenefitStart.toISOString().split('T')[0]);
        
        // Generate available dates
        const availableDates = generateEarliestEffectiveDateOptions(existingPeriod.endDate);
        setAvailableEarliestDates(availableDates);
        
        // Check for existing enrollments
        const checkEnrollments = async () => {
          try {
            const response = await apiService.get<{ success: boolean; data?: any }>(`/api/groups/${groupId}/enrollments?page=1&pageSize=1`);
            if (response.success && response.data) {
              const enrollments = Array.isArray(response.data) ? response.data : (response.data as any).enrollments || [];
              const totalCount = (response.data as any).pagination?.totalCount || enrollments.length;
              setHasExistingEnrollments(totalCount > 0);
            }
          } catch (error) {
            console.error('Error checking enrollments:', error);
            // Don't block if we can't check, just assume there might be enrollments
            setHasExistingEnrollments(false);
          }
        };
        checkEnrollments();
        
        console.log('📅 Set dates to:', { 
          startDate: existingPeriod.startDate, 
          endDate: existingPeriod.endDate,
          earliestEffectiveDate: existingPeriod.earliestEffectiveDate || defaultEarliest.toISOString().split('T')[0]
        });
      } else {
        // Set default start date to today, end date 3 months later
        console.log('📅 Setting default dates (no existing period)');
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const threeMonthsLater = new Date(today.getFullYear(), today.getMonth() + 3, today.getDate());
        const endDateStr = `${threeMonthsLater.getFullYear()}-${String(threeMonthsLater.getMonth() + 1).padStart(2, '0')}-${String(threeMonthsLater.getDate()).padStart(2, '0')}`;
        
        setStartDate(todayStr);
        setEndDate(endDateStr);
        setOriginalBenefitStartDate(null);
        setHasExistingEnrollments(false);
        // earliestEffectiveDate will be set by the endDate useEffect
      }
    } else {
      // Reset dates when modal closes
      setStartDate('');
      setEndDate('');
      setEarliestEffectiveDate('');
      setError(null);
      setAvailableEarliestDates([]);
      setOriginalBenefitStartDate(null);
      setShowBenefitDateWarning(false);
      setHasExistingEnrollments(false);
      setPendingSubmit(false);
    }
  }, [isOpen, existingPeriod, groupId]);

  const handleSubmit = async () => {
    setError(null);
    
    // Validation
    if (!startDate || !endDate) {
      setError('Please select both start and end dates');
      return;
    }

    if (endDate <= startDate) {
      setError('End date must be after start date');
      return;
    }

    // Validate earliest effective date
    if (!earliestEffectiveDate) {
      setError('Please select an earliest effective date');
      return;
    }

    // Check if benefit start date will change (only when editing)
    if (existingPeriod && originalBenefitStartDate && endDate) {
      const newEnd = new Date(endDate + 'T00:00:00');
      const newBenefitStart = new Date(newEnd.getFullYear(), newEnd.getMonth() + 1, 1);
      const newBenefitStartStr = newBenefitStart.toISOString().split('T')[0];
      
      if (newBenefitStartStr !== originalBenefitStartDate) {
        // Benefit start date will change - show confirmation
        setPendingSubmit(true);
        setShowBenefitDateWarning(true);
        return;
      }
    }

    // Proceed with submission
    await performSubmit();
  };

  const performSubmit = async () => {
    try {
      setLoading(true);

      // Use PUT if editing existing period, POST if creating new
      // Always send force: true when updating to allow changes even if links have been sent
      if (existingPeriod) {
        const response = await GroupsService.updateEnrollmentPeriod(groupId, {
          startDate,
          endDate,
          earliestEffectiveDate,
          force: true
        });
        
        if (response.success) {
          setPendingSubmit(false);
          onPeriodSet();
          onClose();
        } else {
          setError(response.message || 'Failed to update enrollment period');
          setPendingSubmit(false);
        }
      } else {
        const response = await GroupsService.createEnrollmentPeriod(groupId, {
          startDate,
          endDate,
          earliestEffectiveDate
        });
        
        if (response.success) {
          setPendingSubmit(false);
          onPeriodSet();
          onClose();
        } else {
          setError(response.message || 'Failed to set enrollment period');
          setPendingSubmit(false);
        }
      }
    } catch (err: any) {
      // Extract error message from API response
      const errorMessage = err?.message || err?.response?.data?.message || 'Failed to set enrollment period';
      setError(errorMessage);
      setPendingSubmit(false);
      
      console.error('Error setting enrollment period:', {
        error: err,
        message: err?.message,
        response: err?.response,
        responseData: err?.response?.data,
        status: err?.response?.status || err?.status
      });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmBenefitDateChange = async () => {
    setShowBenefitDateWarning(false);
    await performSubmit();
  };

  const handleCancelBenefitDateChange = () => {
    setShowBenefitDateWarning(false);
    setPendingSubmit(false);
    setLoading(false);
  };

  const handleClose = () => {
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-gray-900">
              {existingPeriod ? 'Edit' : 'Set'} Enrollment Period
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              {groupName}
            </p>
          </div>
          </div>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Information Alert */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex items-start">
              <Info className="h-5 w-5 text-oe-primary mr-3 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-900">
                <p>Set the enrollment period your employees will have to setup their benefits.</p>
              </div>
            </div>
          </div>

          {/* Date Inputs */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Start Date <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                End Date <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  min={startDate}
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  required
                />
              </div>
            </div>
          </div>

          {/* Earliest Effective Date Dropdown */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Earliest Effective Date <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
              <select
                value={earliestEffectiveDate}
                onChange={(e) => setEarliestEffectiveDate(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary appearance-none bg-white"
                required
                disabled={!endDate || availableEarliestDates.length === 0}
              >
                <option value="">Select earliest effective date...</option>
                {availableEarliestDates.map((date) => (
                  <option key={date} value={date}>
                    {new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric'
                    })}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              The earliest date members can select for their benefits to start. Must be the 1st of a month.
            </p>
          </div>

          {/* Benefit Start Date Preview - Removed per user request */}

          {/* Error Message */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center">
                <AlertCircle className="h-5 w-5 text-red-600 mr-2" />
                <p className="text-sm text-red-800">{error}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-gray-200 bg-gray-50 flex justify-between items-center">
          <button
            onClick={handleClose}
            disabled={loading}
            className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading || pendingSubmit || !startDate || !endDate || !earliestEffectiveDate}
            className="px-6 py-2 bg-[var(--oe-primary)] text-white rounded-lg hover:bg-[var(--oe-primary-dark)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                Setting Period...
              </>
            ) : (
              <>
                <CheckCircle className="h-4 w-4 mr-2" />
                {existingPeriod ? 'Update Period' : 'Set Period'}
              </>
            )}
          </button>
        </div>
      </div>

      {/* Benefit Start Date Change Warning Dialog */}
      {showBenefitDateWarning && originalBenefitStartDate && endDate && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="p-6 border-b border-gray-200">
              <h3 className="text-xl font-semibold text-gray-900">Benefit Start Date Will Change</h3>
            </div>
            <div className="p-6">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
                <div className="flex items-start">
                  <AlertCircle className="h-5 w-5 text-yellow-600 mr-3 mt-0.5 flex-shrink-0" />
                  <div className="text-sm text-yellow-900">
                    <p className="font-medium mb-2">
                      Changing the enrollment period end date will change the benefit start date.
                    </p>
                    <div className="space-y-1">
                      <p>
                        <strong>Current benefit start date:</strong>{' '}
                        {new Date(originalBenefitStartDate + 'T00:00:00').toLocaleDateString('en-US', {
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric'
                        })}
                      </p>
                      <p>
                        <strong>New benefit start date:</strong>{' '}
                        {(() => {
                          const newEnd = new Date(endDate + 'T00:00:00');
                          const newBenefitStart = new Date(newEnd.getFullYear(), newEnd.getMonth() + 1, 1);
                          return newBenefitStart.toLocaleDateString('en-US', {
                            month: 'long',
                            day: 'numeric',
                            year: 'numeric'
                          });
                        })()}
                      </p>
                    </div>
                    {hasExistingEnrollments && (
                      <p className="mt-3 pt-3 border-t border-yellow-300">
                        <strong>Note:</strong> Existing enrollment start dates will not be changed as they are already set.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 bg-gray-50 flex justify-end space-x-3">
              <button
                onClick={handleCancelBenefitDateChange}
                disabled={loading}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmBenefitDateChange}
                disabled={loading}
                className="px-6 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Updating...' : 'Yes, Update Period'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SetEnrollmentPeriodModal;

