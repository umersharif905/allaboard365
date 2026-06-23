import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle, Users, X } from 'lucide-react';
import SearchableDropdown from '../common/SearchableDropdown';
import { useTenantsForDropdown } from '../../hooks/useEnrollmentLinkTemplates';
import TenantAdminAgentsService, { AgentRecord } from '../../services/tenant-admin/agents.service';
import {
  AgentMigrationPreview,
  AgentTenantMigrationService
} from '../../services/admin/agent-tenant-migration.service';
type WizardStep = 'tenant' | 'placement' | 'preview' | 'done';

interface Props {
  agentId: string;
  agentName: string;
  sourceTenantId: string;
  sourceTenantName: string;
  isOpen: boolean;
  onClose: () => void;
  onCompleted?: () => void;
}

const AgentTenantMigrationWizard: React.FC<Props> = ({
  agentId,
  agentName,
  sourceTenantId,
  sourceTenantName,
  isOpen,
  onClose,
  onCompleted
}) => {
  const { data: tenants = [] } = useTenantsForDropdown();
  const [step, setStep] = useState<WizardStep>('tenant');
  const [targetTenantId, setTargetTenantId] = useState('');
  const [targetAgencyId, setTargetAgencyId] = useState('');
  const [targetParentAgentId, setTargetParentAgentId] = useState('');
  const [targetCommissionLevelId, setTargetCommissionLevelId] = useState('');
  const [agencies, setAgencies] = useState<AgentRecord[]>([]);
  const [uplineAgents, setUplineAgents] = useState<AgentRecord[]>([]);
  const [commissionLevels, setCommissionLevels] = useState<
    { commissionLevelId: string; displayName: string }[]
  >([]);
  const [sourceTierLabel, setSourceTierLabel] = useState<string | null>(null);
  const [preview, setPreview] = useState<AgentMigrationPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tenantOptions = useMemo(
    () =>
      tenants
        .filter((t) => t.TenantId !== sourceTenantId)
        .map((t) => ({ id: t.TenantId, label: t.TenantName, value: t.TenantId })),
    [tenants, sourceTenantId]
  );

  const reset = useCallback(() => {
    setStep('tenant');
    setTargetTenantId('');
    setTargetAgencyId('');
    setTargetParentAgentId('');
    setTargetCommissionLevelId('');
    setAgencies([]);
    setUplineAgents([]);
    setCommissionLevels([]);
    setSourceTierLabel(null);
    setPreview(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (!isOpen) reset();
  }, [isOpen, reset]);

  const loadTargetTenantOptions = async (tenantId: string) => {
    const resp = await TenantAdminAgentsService.getAgentsAndAgencies({
      tenantId,
      status: 'Active',
      limit: 500
    });
    if (resp.success && resp.data) {
      setAgencies(resp.data.filter((r) => r.Type === 'Agency'));
      setUplineAgents(
        resp.data.filter((r) => r.Type === 'Agent' && r.Id !== agentId)
      );
    }

    const levelsResp = await TenantAdminAgentsService.getCommissionLevels(
      false,
      tenantId
    );
    if (levelsResp.success && Array.isArray(levelsResp.data)) {
      setCommissionLevels(
        levelsResp.data.map((l) => ({
          commissionLevelId: String(l.CommissionLevelId),
          displayName: l.DisplayName
        }))
      );
    } else {
      setCommissionLevels([]);
    }
  };

  const runPreview = async () => {
    if (!targetAgencyId) {
      setError('Destination agency is required.');
      return;
    }
    if (!targetCommissionLevelId) {
      setError('Destination agent tier is required.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const resp = await AgentTenantMigrationService.preview(agentId, {
        targetTenantId,
        targetAgencyId,
        targetParentAgentId: targetParentAgentId || null,
        targetCommissionLevelId
      });
      if (!resp.success || !resp.data) {
        setError(resp.message || 'Preview failed');
        return;
      }
      setPreview(resp.data);
      setSourceTierLabel(resp.data.commission?.source?.displayName || null);
      setStep('preview');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  };

  const runExecute = async () => {
    if (!preview?.canExecute || !targetAgencyId || !targetCommissionLevelId) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await AgentTenantMigrationService.execute(agentId, {
        targetTenantId,
        targetAgencyId,
        targetParentAgentId: targetParentAgentId || null,
        targetCommissionLevelId
      });
      if (!resp.success) {
        setError(resp.message || 'Migration failed');
        return;
      }
      setStep('done');
      onCompleted?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Migration failed');
    } finally {
      setLoading(false);
    }
  };

  const applySuggestedTier = () => {
    const suggested = preview?.commission?.suggestedTargetCommissionLevelId;
    if (suggested) setTargetCommissionLevelId(suggested);
  };

  useEffect(() => {
    if (step !== 'placement' || !targetTenantId) return;
    const suggested = preview?.commission?.suggestedTargetCommissionLevelId;
    if (suggested && !targetCommissionLevelId) {
      setTargetCommissionLevelId(suggested);
    }
  }, [step, targetTenantId, preview, targetCommissionLevelId]);

  if (!isOpen) return null;

  const selectedTierName =
    commissionLevels.find((l) => l.commissionLevelId === targetCommissionLevelId)?.displayName ||
    preview?.commission?.selectedTargetDisplayName ||
    '';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-gray-200">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Migrate agent to another tenant</h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {agentName} · currently on <strong>{sourceTenantName}</strong>
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-2 text-gray-500 hover:text-gray-700 rounded-lg">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800">{error}</div>
          )}

          {step === 'tenant' && (
            <>
              <p className="text-sm text-gray-600">
                Moves this agent, their downline, and related members/enrollments that belong to the source tenant.
                Agent onboarding links and enrollment link templates move to the destination tenant; root-agent
                onboarding links are assigned to the destination agency you select.
                Commissions and historical audit rows are not moved.
              </p>
              <label className="block text-sm font-medium text-gray-700">Destination tenant</label>
              <SearchableDropdown
                options={tenantOptions}
                value={targetTenantId}
                onChange={(v) => setTargetTenantId(v)}
                placeholder="Select tenant..."
                searchPlaceholder="Search tenants..."
                className="w-full"
              />
            </>
          )}

          {step === 'placement' && (
            <>
              <p className="text-sm text-gray-600">
                Assign the migrating agent to an agency and tier in the destination tenant. Upline is optional.
              </p>
              {sourceTierLabel && (
                <p className="text-sm text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  Current tier on source tenant: <strong>{sourceTierLabel}</strong>
                </p>
              )}
              <label className="block text-sm font-medium text-gray-700">
                Agency <span className="text-red-600">*</span>
              </label>
              <SearchableDropdown
                options={agencies.map((a) => ({
                  id: a.Id,
                  label: a.Name,
                  value: a.Id
                }))}
                value={targetAgencyId}
                onChange={setTargetAgencyId}
                placeholder="Select agency..."
                searchPlaceholder="Search agencies..."
                className="w-full"
              />
              <label className="block text-sm font-medium text-gray-700 mt-3">
                Agent tier on destination tenant <span className="text-red-600">*</span>
              </label>
              <SearchableDropdown
                options={commissionLevels.map((l) => ({
                  id: l.commissionLevelId,
                  label: l.displayName,
                  value: l.commissionLevelId
                }))}
                value={targetCommissionLevelId}
                onChange={setTargetCommissionLevelId}
                placeholder="Select tier..."
                searchPlaceholder="Search tiers..."
                className="w-full"
              />
              {preview?.commission?.suggestedTargetCommissionLevelId &&
                targetCommissionLevelId !== preview.commission.suggestedTargetCommissionLevelId && (
                  <button
                    type="button"
                    className="text-sm text-oe-primary hover:underline"
                    onClick={applySuggestedTier}
                  >
                    Use suggested match: {preview.commission.selectedTargetDisplayName || 'matched tier'}
                  </button>
                )}
              <label className="block text-sm font-medium text-gray-700 mt-3">Upline agent (optional)</label>
              <SearchableDropdown
                options={[
                  { id: '', label: 'No upline (root)', value: '' },
                  ...uplineAgents.map((a) => ({
                    id: a.Id,
                    label: a.Name,
                    value: a.Id,
                    email: a.Email
                  }))
                ]}
                value={targetParentAgentId}
                onChange={setTargetParentAgentId}
                placeholder="Select upline..."
                showEmail
                className="w-full"
              />
            </>
          )}

          {step === 'preview' && preview && (
            <>
              <div className="text-sm text-gray-700 space-y-1 p-3 bg-blue-50 border border-blue-100 rounded-lg">
                <div>
                  <span className="font-medium">Agency:</span>{' '}
                  {agencies.find((a) => a.Id === targetAgencyId)?.Name || '—'}
                </div>
                <div>
                  <span className="font-medium">Destination tier:</span> {selectedTierName || '—'}
                </div>
                {targetParentAgentId && (
                  <div>
                    <span className="font-medium">Upline:</span>{' '}
                    {uplineAgents.find((a) => a.Id === targetParentAgentId)?.Name || '—'}
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                {[
                  ['Agents (subtree)', preview.counts.agents],
                  ['Member records', preview.counts.members],
                  ['Households', preview.counts.households],
                  ['Enrollments', preview.counts.enrollments],
                  ['Groups', preview.counts.groups],
                  ['Onboarding links', preview.counts.onboardingLinks]
                ].map(([label, count]) => (
                  <div key={String(label)} className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg border border-gray-100">
                    <Users className="h-4 w-4 text-oe-primary flex-shrink-0" />
                    <span className="text-gray-700">{label}</span>
                    <span className="ml-auto font-semibold text-gray-900">{count}</span>
                  </div>
                ))}
              </div>

              {preview.warnings.length > 0 && (
                <div className="p-3 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-900">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                    <ul className="list-disc pl-4 space-y-1">
                      {preview.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {preview.blockingProducts.length > 0 && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-900">
                  <p className="font-medium mb-2">Blocked — destination tenant does not subscribe to:</p>
                  <ul className="list-disc pl-4">
                    {preview.blockingProducts.map((p) => (
                      <li key={p.productId}>{p.productName}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center text-center py-6 gap-3">
              <CheckCircle className="h-12 w-12 text-green-600" />
              <p className="text-lg font-medium text-gray-900">Migration complete</p>
              <p className="text-sm text-gray-600">
                {agentName} and related records were moved to {preview?.targetTenant.name || 'the new tenant'}.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 p-4 border-t border-gray-200">
          <button
            type="button"
            onClick={() => {
              if (step === 'tenant') onClose();
              else if (step === 'placement') setStep('tenant');
              else if (step === 'preview') setStep('placement');
              else onClose();
            }}
            className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            {step === 'tenant' ? 'Cancel' : 'Back'}
          </button>

          {step === 'tenant' && (
            <button
              type="button"
              disabled={!targetTenantId || loading}
              onClick={async () => {
                setLoading(true);
                setError(null);
                try {
                  await loadTargetTenantOptions(targetTenantId);
                  const peek = await AgentTenantMigrationService.preview(agentId, {
                    targetTenantId
                  });
                  if (peek.success && peek.data?.commission?.source?.displayName) {
                    setSourceTierLabel(peek.data.commission.source.displayName);
                  }
                  if (peek.success && peek.data?.commission?.suggestedTargetCommissionLevelId) {
                    setTargetCommissionLevelId(peek.data.commission.suggestedTargetCommissionLevelId);
                  }
                  setPreview(peek.success ? peek.data : null);
                  setStep('placement');
                } catch (e: unknown) {
                  setError(e instanceof Error ? e.message : 'Failed to load destination options');
                } finally {
                  setLoading(false);
                }
              }}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-1"
            >
              {loading ? 'Loading…' : 'Next'}
              <ArrowRight className="h-4 w-4" />
            </button>
          )}

          {step === 'placement' && (
            <button
              type="button"
              disabled={loading || !targetAgencyId || !targetCommissionLevelId}
              onClick={runPreview}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
            >
              {loading ? 'Loading preview…' : 'Preview migration'}
            </button>
          )}

          {step === 'preview' && (
            <button
              type="button"
              disabled={!preview?.canExecute || loading}
              onClick={runExecute}
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
            >
              {loading ? 'Migrating…' : 'Confirm migration'}
            </button>
          )}

          {step === 'done' && (
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark">
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentTenantMigrationWizard;
