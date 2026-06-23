import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { GroupsService } from '../../services/groups.service';
import { GroupBadge } from '../../components/groups/GroupBadge';
import type { GroupType } from '../../components/groups/GroupBadge';
import { RequestTypeChangeModal } from '../../components/groups/RequestTypeChangeModal';
import { InstantApproveTypeChangeModal } from '../../components/groups/InstantApproveTypeChangeModal';
import { useAuth } from '../../contexts/AuthContext';

interface GroupSettingsTabProps {
  groupId: string;
  groupName: string;
  groupType?: GroupType;
  currentSettings?: {
    MinimumHirePeriod?: number;
    AllowPlanModifications?: boolean;
    AllowMidMonthEffective?: boolean;
  };
  onSettingsUpdated?: () => void;
}

const GroupSettingsTab: React.FC<GroupSettingsTabProps> = ({
  groupId,
  groupName,
  groupType = 'Standard',
  currentSettings,
  onSettingsUpdated
}) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const currentRole = user?.currentRole;
  const isGroupAdmin = currentRole === 'GroupAdmin';
  const isTenantAdminOrSysAdmin = currentRole === 'TenantAdmin' || currentRole === 'SysAdmin';
  const [showTypeChangeModal, setShowTypeChangeModal] = useState(false);
  const [showInstantApproveModal, setShowInstantApproveModal] = useState(false);
  console.log('🔍 GroupSettingsTab - currentSettings:', currentSettings);
  console.log('🔍 GroupSettingsTab - MinimumHirePeriod:', currentSettings?.MinimumHirePeriod);
  console.log('🔍 GroupSettingsTab - MinimumHirePeriod type:', typeof currentSettings?.MinimumHirePeriod);
  console.log('🔍 GroupSettingsTab - MinimumHirePeriod is number?:', typeof currentSettings?.MinimumHirePeriod === 'number');
  
  // Initialize state - explicitly check for number type (including 0)
  const isValueSet = typeof currentSettings?.MinimumHirePeriod === 'number';
  const [minimumHirePeriod, setMinimumHirePeriod] = useState<number | null>(isValueSet ? currentSettings.MinimumHirePeriod : null);
  const [allowPlanModifications, setAllowPlanModifications] = useState<boolean>(currentSettings?.AllowPlanModifications ?? false);
  const [allowMidMonthEffective, setAllowMidMonthEffective] = useState<boolean>(currentSettings?.AllowMidMonthEffective ?? false);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when currentSettings changes (e.g., after refetch)
  React.useEffect(() => {
    const originalValue = currentSettings?.MinimumHirePeriod;
    const isSet = typeof originalValue === 'number';
    setMinimumHirePeriod(isSet ? originalValue : null);
    setAllowPlanModifications(currentSettings?.AllowPlanModifications ?? false);
    setAllowMidMonthEffective(currentSettings?.AllowMidMonthEffective ?? false);
  }, [currentSettings?.MinimumHirePeriod, currentSettings?.AllowPlanModifications, currentSettings?.AllowMidMonthEffective]);

  const hirePeriodOptions = [
    { value: null, label: 'No waiting period' },
    { value: 0, label: '0 Days' },
    { value: 30, label: '30 Days' },
    { value: 60, label: '60 Days' },
    { value: 90, label: '90 Days' }
  ];

  const handleSave = async () => {
    if (!groupId) {
      setError('Group ID is missing. Please refresh the page.');
      console.error('❌ GroupSettingsTab - groupId is missing:', groupId);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      
      console.log('💾 GroupSettingsTab - Saving with groupId:', groupId, {
        MinimumHirePeriod: minimumHirePeriod,
        AllowPlanModifications: allowPlanModifications
      });
      
      const result = await GroupsService.updateGroup(groupId, {
        MinimumHirePeriod: minimumHirePeriod,
        AllowPlanModifications: allowPlanModifications,
        AllowMidMonthEffective: allowMidMonthEffective
      });

      if (result.success) {
        setSaved(true);

        // Invalidate all related queries to ensure setup status updates immediately
        queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
        queryClient.invalidateQueries({ queryKey: ['groupSetupStatus', groupId] });
        
        // Call the parent's refetch callback
        onSettingsUpdated?.();
        setTimeout(() => setSaved(false), 3000);
      } else {
        setError(result.message || 'Failed to update settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  // Compare values properly - handle 0 as a valid value
  const currentValue = typeof currentSettings?.MinimumHirePeriod === 'number' ? currentSettings.MinimumHirePeriod : null;
  const hasMinimumHirePeriodChanges = minimumHirePeriod !== currentValue;
  const hasPlanModificationsChanges = allowPlanModifications !== (currentSettings?.AllowPlanModifications ?? false);
  const hasMidMonthEffectiveChanges = allowMidMonthEffective !== (currentSettings?.AllowMidMonthEffective ?? false);
  const hasChanges = hasMinimumHirePeriodChanges || hasPlanModificationsChanges || hasMidMonthEffectiveChanges;
  const canSave = hasChanges;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-gray-900">
          Settings
        </h2>
        <p className="text-gray-600 text-sm">
          Configure settings and policies for {groupName}
        </p>
      </div>

      {/* Settings Cards */}
      <div className="space-y-4">
        {/* Group Type Section */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-700">Group Type</h3>
              <div className="mt-1 flex items-center gap-2">
                {groupType === 'ListBill' ? (
                  <GroupBadge type="ListBill" />
                ) : (
                  <span className="text-sm text-gray-600">Standard</span>
                )}
              </div>
              <p className="mt-1 text-xs text-gray-500">
                {groupType === 'ListBill'
                  ? 'Each member enrolls in individual products, but everyone is consolidated onto one shared bill with a single payment method. Exempt from vendor employee minimums.'
                  : 'Group-level enrollment. Subject to vendor minimum employees per group.'}
              </p>
            </div>
            {isTenantAdminOrSysAdmin ? (
              <button
                type="button"
                onClick={() => setShowInstantApproveModal(true)}
                className="ml-4 flex-shrink-0 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark transition-colors"
              >
                Make change now
              </button>
            ) : isGroupAdmin ? null : (
              <button
                type="button"
                onClick={() => setShowTypeChangeModal(true)}
                className="ml-4 flex-shrink-0 px-3 py-1.5 text-sm font-medium text-oe-primary border border-oe-primary rounded-lg hover:bg-oe-light transition-colors"
              >
                Request type change
              </button>
            )}
          </div>
        </div>

        {/* Minimum Hire Period Setting */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Waiting Period
            </label>
            <select
              value={minimumHirePeriod === null ? '' : minimumHirePeriod}
              onChange={(e) => {
                const value = e.target.value === '' ? null : parseInt(e.target.value);
                setMinimumHirePeriod(value);
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
            >
              {hirePeriodOptions.map((option) => (
                <option key={option.value === null ? 'null' : option.value} value={option.value === null ? '' : option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Optional. Number of days a new hire must be employed before they can enroll. Leave unset or pick "0 Days" if there's no waiting period.
            </p>
          </div>
        </div>

        {/* Allow Plan Modifications Setting */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-center space-x-3">
            <input
              type="checkbox"
              id="allowPlanModifications"
              checked={allowPlanModifications}
              onChange={(e) => setAllowPlanModifications(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            <label htmlFor="allowPlanModifications" className="text-sm font-medium text-gray-700">
              Allow members to modify their plans
            </label>
          </div>
        </div>

        {/* Allow Mid-Month (15th) Effective Date Setting */}
        <div className="bg-white border border-gray-200 rounded-lg p-4">
          <div className="flex items-start space-x-3">
            <input
              type="checkbox"
              id="allowMidMonthEffective"
              checked={allowMidMonthEffective}
              onChange={(e) => setAllowMidMonthEffective(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
            />
            <div>
              <label htmlFor="allowMidMonthEffective" className="text-sm font-medium text-gray-700">
                Allow mid-month (15th) effective date enrollments
              </label>
              <p className="mt-1 text-xs text-gray-600">
                When enabled, new enrollees can pick either the 1st or 15th of the month
                as their effective date. 1st-cohort members are billed on the 5th;
                15th-cohort members are billed on the 20th.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Save Button at Bottom */}
      <div className="flex justify-end mt-6 pt-6 border-t border-gray-200">
        <button
          onClick={handleSave}
          disabled={!canSave || loading}
          className="px-6 py-2 bg-oe-primary text-white rounded-lg font-medium hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Success/Error Messages */}
      {saved && (
        <div className="mt-4 p-3 bg-green-50 border border-green-200 text-green-800 rounded-lg">
          Group settings updated successfully!
        </div>
      )}

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg">
          {error}
        </div>
      )}

      {showTypeChangeModal && !isGroupAdmin && !isTenantAdminOrSysAdmin && (
        <RequestTypeChangeModal
          groupId={groupId}
          currentType={groupType}
          onClose={() => setShowTypeChangeModal(false)}
          onSuccess={() => {
            setShowTypeChangeModal(false);
            queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
            onSettingsUpdated?.();
          }}
        />
      )}

      {showInstantApproveModal && isTenantAdminOrSysAdmin && (
        <InstantApproveTypeChangeModal
          groupId={groupId}
          currentType={groupType}
          onClose={() => setShowInstantApproveModal(false)}
          onSuccess={(wizardUrl) => {
            setShowInstantApproveModal(false);
            queryClient.invalidateQueries({ queryKey: ['groupDetails', groupId] });
            onSettingsUpdated?.();
            // Mirror the existing GroupDetails banner pattern: TenantAdmin uses
            // the /tenant-admin path, agents use /agent. The API returns the
            // tenant-admin URL by default, but rewrite for agent/sysadmin if
            // we're not actually on the tenant-admin role.
            const rolePath =
              currentRole === 'TenantAdmin' || currentRole === 'SysAdmin'
                ? 'tenant-admin'
                : 'agent';
            const target = wizardUrl.replace('/tenant-admin/', `/${rolePath}/`);
            navigate(target);
          }}
        />
      )}
    </div>
  );
};

export default GroupSettingsTab;

