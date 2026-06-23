// frontend/src/components/agents/AgentCommissionOverridesSection.tsx
// Inline "Agent Commission Overrides" editor for a single source agent.
// Lists and manages overrides where THIS agent is the source (i.e. portions
// of this agent's per-payment commission are redirected to another agent).

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Edit3, Trash2, ArrowRight, AlertCircle, Percent, DollarSign } from 'lucide-react';
import SearchableDropdown from '../common/SearchableDropdown';
import {
  AgentOverridesService,
  AgentCommissionOverride,
  AgentOverrideType,
  AgentOverrideStatus,
  CreateAgentOverridePayload
} from '../../services/tenant-admin/agent-overrides.service';
import TenantAdminAgentsService, { AgentRecord } from '../../services/tenant-admin/agents.service';

interface Props {
  sourceAgentId: string;
  sourceAgentName: string;
  canEdit: boolean;
}

interface OverrideFormState {
  recipientAgentId: string;
  recipientAgentName: string;
  overrideType: AgentOverrideType;
  overrideAmount: string;
  overridePercentage: string;
  effectiveDate: string;
  terminationDate: string;
  status: AgentOverrideStatus;
  notes: string;
}

const EMPTY_FORM: OverrideFormState = {
  recipientAgentId: '',
  recipientAgentName: '',
  overrideType: 'Fixed',
  overrideAmount: '',
  overridePercentage: '',
  effectiveDate: '',
  terminationDate: '',
  status: 'Active',
  notes: ''
};

const formatCurrency = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n));
const formatPercent = (n: number | null | undefined) =>
  n == null ? '—' : `${Number(n).toFixed(2)}%`;
const formatDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const v = new Date(d);
  return Number.isNaN(v.getTime()) ? '—' : v.toLocaleDateString();
};

const AgentCommissionOverridesSection: React.FC<Props> = ({ sourceAgentId, sourceAgentName, canEdit }) => {
  const [overrides, setOverrides] = useState<AgentCommissionOverride[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrationPending, setMigrationPending] = useState(false);

  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingOverride, setEditingOverride] = useState<AgentCommissionOverride | null>(null);
  const [form, setForm] = useState<OverrideFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const loadOverrides = async () => {
    if (!sourceAgentId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await AgentOverridesService.list({ sourceAgentId });
      if (!resp.success) {
        setError(resp.message || 'Failed to load overrides');
        setOverrides([]);
      } else {
        setOverrides(resp.data || []);
        setMigrationPending(!!resp.migrationPending);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load overrides');
    } finally {
      setLoading(false);
    }
  };

  const loadAgents = async () => {
    if (!canEdit) return;
    setAgentsLoading(true);
    try {
      const resp = await TenantAdminAgentsService.getAgentsAndAgencies({ type: 'Agent', status: 'Active', limit: 500 });
      setAgents(Array.isArray(resp?.data) ? (resp.data as AgentRecord[]) : []);
    } catch (err) {
      console.error('Error loading agents for override dropdown:', err);
    } finally {
      setAgentsLoading(false);
    }
  };

  useEffect(() => {
    loadOverrides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAgentId]);

  useEffect(() => {
    loadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit]);

  const recipientOptions = useMemo(() => {
    return (agents || [])
      .filter((a) => a.Type === 'Agent' && String(a.Id).toUpperCase() !== String(sourceAgentId).toUpperCase())
      .map((a) => ({
        id: a.Id,
        value: a.Id,
        label: a.Name || 'Unnamed agent',
        email: a.Email,
        sublabel: a.AgencyName || undefined
      }));
  }, [agents, sourceAgentId]);

  const openCreateModal = () => {
    setEditingOverride(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  };

  const openEditModal = (ov: AgentCommissionOverride) => {
    setEditingOverride(ov);
    setForm({
      recipientAgentId: ov.recipientAgentId,
      recipientAgentName: ov.recipientAgentName || '',
      overrideType: ov.overrideType,
      overrideAmount: ov.overrideAmount != null ? String(ov.overrideAmount) : '',
      overridePercentage: ov.overridePercentage != null ? String(ov.overridePercentage) : '',
      effectiveDate: ov.effectiveDate ? new Date(ov.effectiveDate).toISOString().slice(0, 10) : '',
      terminationDate: ov.terminationDate ? new Date(ov.terminationDate).toISOString().slice(0, 10) : '',
      status: (ov.status as AgentOverrideStatus) || 'Active',
      notes: ov.notes || ''
    });
    setFormError(null);
    setModalOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setModalOpen(false);
    setEditingOverride(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const validateForm = (): string | null => {
    if (!form.recipientAgentId) return 'Recipient agent is required';
    if (String(form.recipientAgentId).toUpperCase() === String(sourceAgentId).toUpperCase()) {
      return 'Recipient must be a different agent';
    }
    if (form.overrideType === 'Fixed') {
      const amt = Number(form.overrideAmount);
      if (!Number.isFinite(amt) || amt <= 0) return 'Enter a positive dollar amount';
    } else {
      const pct = Number(form.overridePercentage);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return 'Enter a percentage between 0 and 100';
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validateForm();
    if (validationError) {
      setFormError(validationError);
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const payload: CreateAgentOverridePayload = {
        sourceAgentId,
        recipientAgentId: form.recipientAgentId,
        overrideType: form.overrideType,
        overrideAmount: form.overrideType === 'Fixed' ? Number(form.overrideAmount) : null,
        overridePercentage: form.overrideType === 'Percentage' ? Number(form.overridePercentage) : null,
        effectiveDate: form.effectiveDate || null,
        terminationDate: form.terminationDate || null,
        status: form.status,
        notes: form.notes || null
      };

      const resp = editingOverride
        ? await AgentOverridesService.update(editingOverride.overrideId, {
            overrideType: payload.overrideType,
            overrideAmount: payload.overrideAmount,
            overridePercentage: payload.overridePercentage,
            effectiveDate: payload.effectiveDate,
            terminationDate: payload.terminationDate,
            status: payload.status,
            notes: payload.notes
          })
        : await AgentOverridesService.create(payload);

      if (!resp.success) {
        setFormError(resp.message || 'Failed to save');
        return;
      }
      await loadOverrides();
      closeModal();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save override');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (ov: AgentCommissionOverride) => {
    if (!window.confirm(`Delete override to ${ov.recipientAgentName || 'Unknown'}?`)) return;
    try {
      const resp = await AgentOverridesService.remove(ov.overrideId);
      if (!resp.success) {
        alert(resp.message || 'Failed to delete override');
        return;
      }
      await loadOverrides();
    } catch (err: any) {
      alert(err?.message || 'Failed to delete override');
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="p-4 border-b border-gray-200 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Agent Commission Overrides</h3>
          <p className="text-xs text-gray-600 mt-0.5">
            Redirect a fixed dollar amount or percentage of {sourceAgentName || 'this agent'}&apos;s per-payment commission to another agent.
          </p>
        </div>
        {canEdit && !migrationPending && (
          <button
            type="button"
            onClick={openCreateModal}
            className="inline-flex items-center px-3 py-1.5 rounded-lg bg-oe-primary hover:bg-oe-dark text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            New Override
          </button>
        )}
      </div>

      {migrationPending && (
        <div className="m-4 p-3 bg-yellow-50 border border-yellow-200 text-yellow-800 rounded-lg flex items-start text-xs">
          <AlertCircle className="h-4 w-4 mr-2 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">Database migration pending</div>
            <div className="mt-0.5">
              Run <code className="bg-yellow-100 px-1 py-0.5 rounded">sql-changes/2026-04-15-agent-commission-overrides.sql</code> to enable this feature.
            </div>
          </div>
        </div>
      )}

      {error && !migrationPending && (
        <div className="m-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg flex items-start text-xs">
          <AlertCircle className="h-4 w-4 mr-2 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Recipient</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Effective</th>
              <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
              {canEdit && (
                <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              )}
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {loading && (
              <tr>
                <td colSpan={canEdit ? 6 : 5} className="px-4 py-4 text-center text-sm text-gray-500">Loading overrides…</td>
              </tr>
            )}
            {!loading && overrides.length === 0 && !migrationPending && (
              <tr>
                <td colSpan={canEdit ? 6 : 5} className="px-4 py-6 text-center text-sm text-gray-500">
                  No overrides configured for this agent.
                </td>
              </tr>
            )}
            {!loading && overrides.map((ov) => (
              <tr key={ov.overrideId} className="hover:bg-gray-50">
                <td className="px-4 py-2 text-sm text-gray-900">
                  <div className="flex items-center">
                    <ArrowRight className="h-3.5 w-3.5 text-gray-400 mr-1.5" />
                    {ov.recipientAgentName || 'Unknown'}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-gray-700">
                  <span className="inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full bg-blue-50 text-blue-700">
                    {ov.overrideType === 'Fixed' ? <DollarSign className="h-3 w-3 mr-0.5" /> : <Percent className="h-3 w-3 mr-0.5" />}
                    {ov.overrideType}
                  </span>
                </td>
                <td className="px-4 py-2 text-sm text-gray-900">
                  {ov.overrideType === 'Fixed' ? formatCurrency(ov.overrideAmount) : formatPercent(ov.overridePercentage)}
                </td>
                <td className="px-4 py-2 text-xs text-gray-600">
                  {formatDate(ov.effectiveDate)}
                  {ov.terminationDate && <span className="text-gray-400"> – {formatDate(ov.terminationDate)}</span>}
                </td>
                <td className="px-4 py-2 text-sm">
                  <span
                    className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${
                      ov.status === 'Active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {ov.status}
                  </span>
                </td>
                {canEdit && (
                  <td className="px-4 py-2 text-right text-sm">
                    <button
                      type="button"
                      onClick={() => openEditModal(ov)}
                      className="inline-flex items-center px-2 py-1 rounded hover:bg-gray-100 text-gray-600"
                      title="Edit"
                    >
                      <Edit3 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(ov)}
                      className="inline-flex items-center px-2 py-1 rounded text-red-600 hover:bg-red-50 ml-1"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-[70] bg-black bg-opacity-40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg border border-gray-200 shadow-lg w-full max-w-xl">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-medium text-gray-900">
                {editingOverride ? 'Edit Agent Override' : 'New Agent Override'}
              </h2>
              <p className="text-sm text-gray-600 mt-1">
                From <span className="font-medium">{sourceAgentName}</span>
                {editingOverride ? ' · source and recipient cannot be changed' : ''}
              </p>
            </div>
            <div className="p-6 space-y-4">
              {formError && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-800 rounded-lg text-sm flex items-start">
                  <AlertCircle className="h-4 w-4 mr-2 mt-0.5 flex-shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Recipient Agent</label>
                <SearchableDropdown
                  options={recipientOptions}
                  value={form.recipientAgentId}
                  onChange={(value, label) =>
                    setForm((prev) => ({ ...prev, recipientAgentId: value, recipientAgentName: label }))
                  }
                  placeholder="Select recipient agent"
                  searchPlaceholder="Search agents…"
                  loading={agentsLoading}
                  disabled={!!editingOverride}
                  showEmail
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Override Type</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, overrideType: 'Fixed' }))}
                    className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium ${
                      form.overrideType === 'Fixed'
                        ? 'bg-oe-primary border-oe-primary text-white'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <DollarSign className="inline h-4 w-4 mr-1" /> Fixed dollar amount
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((prev) => ({ ...prev, overrideType: 'Percentage' }))}
                    className={`flex-1 px-4 py-2 rounded-lg border text-sm font-medium ${
                      form.overrideType === 'Percentage'
                        ? 'bg-oe-primary border-oe-primary text-white'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <Percent className="inline h-4 w-4 mr-1" /> Percentage of commission
                  </button>
                </div>
              </div>

              {form.overrideType === 'Fixed' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Amount (per payment)</label>
                  <div className="relative">
                    <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={form.overrideAmount}
                      onChange={(e) => setForm((prev) => ({ ...prev, overrideAmount: e.target.value }))}
                      className="pl-7 pr-3 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
                      placeholder="5.00"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Percentage (of {sourceAgentName || 'source'}\u2019s per-payment commission)</label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={form.overridePercentage}
                      onChange={(e) => setForm((prev) => ({ ...prev, overridePercentage: e.target.value }))}
                      className="pr-7 pl-3 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
                      placeholder="25"
                    />
                    <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500">%</span>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Effective Date</label>
                  <input
                    type="date"
                    value={form.effectiveDate}
                    onChange={(e) => setForm((prev) => ({ ...prev, effectiveDate: e.target.value }))}
                    className="px-3 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Termination Date</label>
                  <input
                    type="date"
                    value={form.terminationDate}
                    onChange={(e) => setForm((prev) => ({ ...prev, terminationDate: e.target.value }))}
                    className="px-3 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value as AgentOverrideStatus }))}
                  className="px-3 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
                >
                  <option value="Active">Active</option>
                  <option value="Inactive">Inactive</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={form.notes}
                  onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
                  className="px-3 py-2 w-full border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:outline-none"
                  placeholder="Optional notes about this override"
                />
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 text-sm font-medium disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-oe-primary hover:bg-oe-dark text-white text-sm font-medium disabled:opacity-50"
              >
                {saving ? 'Saving…' : editingOverride ? 'Save Changes' : 'Create Override'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentCommissionOverridesSection;
