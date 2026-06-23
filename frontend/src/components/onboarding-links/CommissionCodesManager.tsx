import { AlertTriangle, Edit, Eye, Plus, Save, Trash2, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { COMMISSION_TIER_LEVELS } from '../../constants/form-options';
import { tierLevelsMatch } from '../../utils/commissionTierLevelMatch';
import SearchableDropdown from '../common/SearchableDropdown';
import CommissionCodePreviewModal from './CommissionCodePreviewModal';

interface CommissionGroup {
  CommissionGroupId: string;
  Name: string;
  Status: string;
}

interface CommissionCode {
  CodeId?: string;
  CommissionCode: string;
  CommissionGroupId?: string | null;
  CommissionGroupName?: string | null;
  IsActive: boolean;
  GrantTierLevel?: number | null;
}

const NONE_GROUP_ID = '';

type TierLevelOption = { level: number; name: string; legacyTierLevel?: number | null };

interface CommissionCodesManagerProps {
  linkId: string;
  commissionCodes: CommissionCode[];
  commissionGroups: CommissionGroup[];
  onAddCode: (code: string, commissionGroupId: string, grantTierLevel?: number | null) => Promise<void>;
  onRemoveCode: (codeId: string) => Promise<void>;
  onUpdateCode: (
    codeId: string,
    updates: { commissionCode?: string; commissionGroupId?: string; isActive?: boolean; grantTierLevel?: number | null }
  ) => Promise<void>;
  loading?: boolean;
  /** Link owner's tier level (agent or agency). Only levels *below* this are offered for "Grant agent tier". */
  ownerTierLevel?: number | null;
  /** Agent downline onboarding: hide group picker; codes always use the link owner's commission group. */
  lockCommissionGroup?: boolean;
  lockedCommissionGroupId?: string | null;
  lockedCommissionGroupName?: string | null;
  /** Tenant default / agency group used to pre-select the commission group when opening "Add code". */
  defaultCommissionGroupId?: string | null;
  /**
   * Tenant-scoped commission levels from oe.CommissionLevels (preferred source of truth).
   * Falls back to hardcoded COMMISSION_TIER_LEVELS when not provided.
   */
  tierLevels?: TierLevelOption[];
  /**
   * Pre-resolved commission group for the link owner. Used by the per-code
   * commission preview eye icon when a code has no explicit CommissionGroupId
   * of its own.
   */
  ownerCommissionGroupId?: string | null;
  /**
   * When true, render the per-code preview eye icon for non-tenant viewers
   * (e.g. agency admins who can legitimately preview their downline's codes).
   * Defaults false; TenantAdmin/SysAdmin always see the icon.
   */
  enableAgencyAdminPreview?: boolean;
  /** Agent viewing their own onboarding link — show commission preview eye icon. */
  enableLinkOwnerPreview?: boolean;
  /** Rendered centered below the empty-state message (e.g. bulk auto-generate). */
  emptyStateExtra?: React.ReactNode;
}

const CommissionCodesManager: React.FC<CommissionCodesManagerProps> = ({
  commissionCodes,
  commissionGroups,
  onAddCode,
  onRemoveCode,
  onUpdateCode,
  loading = false,
  ownerTierLevel = null,
  lockCommissionGroup = false,
  lockedCommissionGroupId = null,
  lockedCommissionGroupName = null,
  defaultCommissionGroupId = null,
  tierLevels,
  ownerCommissionGroupId = null,
  enableAgencyAdminPreview = false,
  enableLinkOwnerPreview = false,
  emptyStateExtra
}) => {
  const currentRole = localStorage.getItem('currentRole') || '';
  const canEditGroup = !lockCommissionGroup && (currentRole === 'TenantAdmin' || currentRole === 'SysAdmin');
  const canPreviewCommission =
    currentRole === 'TenantAdmin' ||
    currentRole === 'SysAdmin' ||
    (currentRole === 'Agent' && (enableAgencyAdminPreview || enableLinkOwnerPreview));

  const effectiveTierLevels = useMemo((): TierLevelOption[] => {
    if (tierLevels && tierLevels.length > 0) {
      return [...tierLevels].sort((a, b) => a.level - b.level);
    }
    return COMMISSION_TIER_LEVELS.map((t) => ({ level: t.level, name: t.name }));
  }, [tierLevels]);

  const tierOptions = useMemo(() => {
    const levels =
      ownerTierLevel === null
        ? effectiveTierLevels
        : effectiveTierLevels.filter((t) => t.level < Number(ownerTierLevel));
    return levels;
  }, [effectiveTierLevels, ownerTierLevel]);

  const findTierMeta = (level: number) => {
    const exact = effectiveTierLevels.find((t) => tierLevelsMatch(t.level, level));
    if (exact) return exact;
    const legacy = effectiveTierLevels.find(
      (t) =>
        t.legacyTierLevel !== undefined &&
        t.legacyTierLevel !== null &&
        tierLevelsMatch(t.legacyTierLevel, level)
    );
    return legacy ?? null;
  };

  const sortedCommissionCodes = useMemo(
    () =>
      [...commissionCodes].sort(
        (a, b) => Number(a.GrantTierLevel ?? 999) - Number(b.GrantTierLevel ?? 999)
      ),
    [commissionCodes]
  );

  const labelForTier = (level: number): string => {
    const match = findTierMeta(level);
    if (match) return match.name;
    return 'Unconfigured tier';
  };

  /** Default tier when adding: highest level still below the owner (top of the list). */
  const defaultGrantTierLevel = useMemo(() => {
    if (tierOptions.length === 0) return 0;
    return tierOptions[tierOptions.length - 1].level;
  }, [tierOptions]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newGroupId, setNewGroupId] = useState<string>(NONE_GROUP_ID);
  const [newGrantTierLevel, setNewGrantTierLevel] = useState<number>(defaultGrantTierLevel);

  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editCode, setEditCode] = useState('');
  const [editGroupId, setEditGroupId] = useState<string>(NONE_GROUP_ID);
  const [editGrantTierLevel, setEditGrantTierLevel] = useState<number>(defaultGrantTierLevel);

  const [previewCode, setPreviewCode] = useState<CommissionCode | null>(null);

  const groupOptions = useMemo(() => {
    const groups = Array.isArray(commissionGroups) ? commissionGroups : [];
    const active = groups.filter((g) => (g.Status || '').toLowerCase() === 'active');
    return [
      { id: NONE_GROUP_ID, value: NONE_GROUP_ID, label: 'None' },
      ...active.map((g) => ({ id: g.CommissionGroupId, value: g.CommissionGroupId, label: g.Name }))
    ];
  }, [commissionGroups]);

  const handleAdd = async () => {
    if (!newCode.trim()) return;
    const groupForApi = lockCommissionGroup ? lockedCommissionGroupId || '' : newGroupId;
    await onAddCode(newCode.trim().toUpperCase(), groupForApi, newGrantTierLevel);
    setNewCode('');
    setNewGroupId(NONE_GROUP_ID);
    setNewGrantTierLevel(defaultGrantTierLevel);
    setShowAddForm(false);
  };

  const startEdit = (code: CommissionCode) => {
    setEditingCode(code.CodeId || null);
    setEditCode(code.CommissionCode);
    setEditGroupId(code.CommissionGroupId || NONE_GROUP_ID);
    // Prefer the code's stored tier; fall back to a level that's actually in the picker so
    // the dropdown renders something (empty select is what users see today when
    // GrantTierLevel is null or is outside the hardcoded tier list).
    const initial =
      code.GrantTierLevel !== undefined && code.GrantTierLevel !== null
        ? code.GrantTierLevel
        : defaultGrantTierLevel;
    setEditGrantTierLevel(initial);
  };

  const cancelEdit = () => {
    setEditingCode(null);
    setEditCode('');
    setEditGroupId(NONE_GROUP_ID);
    setEditGrantTierLevel(defaultGrantTierLevel);
  };

  const saveEdit = async (codeId: string) => {
    const updates: any = {};
    updates.commissionCode = editCode.trim().toUpperCase();
    updates.grantTierLevel = editGrantTierLevel;
    if (lockCommissionGroup) {
      updates.commissionGroupId = lockedCommissionGroupId ?? null;
    } else if (canEditGroup) {
      updates.commissionGroupId = editGroupId || null;
    }
    await onUpdateCode(codeId, updates);
    cancelEdit();
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-medium text-gray-900">Commission Codes</h3>
        <button
          onClick={() => {
            if (!showAddForm) {
              const active = (commissionGroups || []).filter((g) => (g.Status || '').toLowerCase() === 'active');
              const defId =
                defaultCommissionGroupId &&
                active.some((g) => g.CommissionGroupId === defaultCommissionGroupId)
                  ? defaultCommissionGroupId
                  : NONE_GROUP_ID;
              setNewGroupId(defId);
              setNewCode('');
              setNewGrantTierLevel(defaultGrantTierLevel);
            }
            setShowAddForm(!showAddForm);
          }}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
          disabled={loading}
        >
          <Plus className="w-4 h-4" />
          Add Code
        </button>
      </div>

      {showAddForm && (
        <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200">
          <div className={`grid grid-cols-1 gap-4 ${lockCommissionGroup ? '' : 'md:grid-cols-3'}`}>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Code</label>
              <input
                type="text"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                placeholder="Enter code (e.g. LEVEL0)"
              />
            </div>

            {!lockCommissionGroup && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Commission Group</label>
                <SearchableDropdown
                  options={groupOptions}
                  value={newGroupId}
                  onChange={setNewGroupId}
                  placeholder={canEditGroup ? 'Select a group…' : 'None'}
                  className="w-full"
                  disabled={!canEditGroup}
                />
                {!canEditGroup && (
                  <p className="text-xs text-gray-500 mt-1">Only TenantAdmin/SysAdmin can set a code’s commission group.</p>
                )}
              </div>
            )}

            {lockCommissionGroup && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Commission group</label>
                <div className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-100 text-gray-800">
                  {lockedCommissionGroupName || (lockedCommissionGroupId ? 'Your commission group' : '—')}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {lockedCommissionGroupId
                    ? 'Codes use your commission group automatically for new downline agents.'
                    : 'No commission group on your agent profile. Contact your administrator to assign commission groups.'}
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Grant agent tier</label>
              <select
                value={newGrantTierLevel}
                onChange={(e) => setNewGrantTierLevel(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                {tierOptions.map((tier) => (
                  <option key={String(tier.level)} value={tier.level}>
                    {tier.name}
                  </option>
                ))}
              </select>
              {ownerTierLevel !== null && (
                <p className="text-xs text-gray-500 mt-1">
                  Must be below link owner level ({labelForTier(ownerTierLevel)}).
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={() => setShowAddForm(false)}
              className="px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-4 h-4 inline mr-1" />
              Cancel
            </button>
            <button
              onClick={handleAdd}
              className="px-3 py-2 text-sm bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark transition-colors"
              disabled={!newCode.trim()}
            >
              <Save className="w-4 h-4 inline mr-1" />
              Add
            </button>
          </div>
        </div>
      )}

      {sortedCommissionCodes.length === 0 ? (
        <div className="text-center py-8 text-gray-500">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-gray-400" />
          <p>No commission codes created yet</p>
          <p className="text-sm">Add a code to get started</p>
          {emptyStateExtra ? (
            <div className="mt-6 flex justify-center">{emptyStateExtra}</div>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {sortedCommissionCodes.map((code) => {
            const isEditing = editingCode === code.CodeId;
            return (
              <div
                key={code.CodeId || code.CommissionCode}
                className={`p-3 border rounded-lg ${
                  code.IsActive ? 'border-gray-200' : 'border-gray-200 bg-gray-50 opacity-75'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className={`grid grid-cols-1 gap-3 ${lockCommissionGroup ? 'md:grid-cols-2' : 'md:grid-cols-3'}`}>
                        <input
                          value={editCode}
                          onChange={(e) => setEditCode(e.target.value.toUpperCase())}
                          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                        {!lockCommissionGroup && (
                          <SearchableDropdown
                            options={groupOptions}
                            value={editGroupId}
                            onChange={setEditGroupId}
                            placeholder="Select a group…"
                            className="w-full"
                            disabled={!canEditGroup}
                          />
                        )}
                        {lockCommissionGroup && (
                          <div className="px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-100 text-gray-700">
                            {lockedCommissionGroupName || 'Your commission group'}
                          </div>
                        )}
                        <select
                          value={editGrantTierLevel}
                          onChange={(e) => setEditGrantTierLevel(Number(e.target.value))}
                          className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        >
                          {tierOptions.map((tier) => (
                            <option key={String(tier.level)} value={tier.level}>
                              {tier.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-center gap-3 flex-wrap">
                          <span className="font-mono text-sm font-semibold text-gray-900">{code.CommissionCode}</span>
                          {!code.IsActive && (
                            <span className="px-2 py-1 text-xs bg-gray-200 text-gray-700 rounded-full">Inactive</span>
                          )}
                          {code.GrantTierLevel !== undefined && code.GrantTierLevel !== null && (
                            <span className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">
                              {labelForTier(code.GrantTierLevel)}
                            </span>
                          )}
                        </div>
                        {(lockCommissionGroup
                          ? (lockedCommissionGroupName || code.CommissionGroupName)
                          : code.CommissionGroupName
                        ) && (
                          <div className="mt-1 text-sm text-gray-600 truncate">
                            Commission Group: {lockCommissionGroup
                              ? (lockedCommissionGroupName || code.CommissionGroupName)
                              : code.CommissionGroupName}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => saveEdit(code.CodeId!)}
                          className="p-2 text-green-600 hover:bg-green-50 rounded-lg transition-colors"
                          title="Save"
                        >
                          <Save className="w-4 h-4" />
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
                          title="Cancel"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        {canPreviewCommission && code.GrantTierLevel != null && (
                          <button
                            onClick={() => setPreviewCode(code)}
                            className="p-2 text-oe-primary hover:bg-oe-light hover:text-oe-dark rounded-lg transition-colors"
                            title="Preview commissions for this tier"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => startEdit(code)}
                          className="p-2 text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => onRemoveCode(code.CodeId!)}
                          className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <CommissionCodePreviewModal
        isOpen={!!previewCode}
        onClose={() => setPreviewCode(null)}
        code={previewCode}
        ownerCommissionGroupId={ownerCommissionGroupId}
        tierLabel={
          previewCode && previewCode.GrantTierLevel != null
            ? labelForTier(previewCode.GrantTierLevel)
            : null
        }
      />
    </div>
  );
};

export default CommissionCodesManager;

