// frontend/src/pages/prospects/ProspectDetailModal.tsx
// Prospect detail (Phase 1): overview + editable status/fields, products, and the
// "possible member match" banner (suggest → agent confirms link, which closes the prospect).

import { Link2, Loader2, Trash2, UserCheck, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useDownlineAgentsForFilter } from '../../hooks/useDownlineAgentsForFilter';
import {
  useConfirmMemberLink,
  useDeleteProspect,
  useProspect,
  useReassignProspect,
  useTenantAgentsForFilter,
  useUpdateProspect,
} from '../../hooks/useProspects';
import {
  PROSPECT_STATUSES,
  ProspectStatus,
} from '../../services/prospect.service';
import { statusBadgeClass } from './prospectStatus';
import ProspectCommunicationsTab from './ProspectCommunicationsTab';
import ProspectProposalsTab from './ProspectProposalsTab';
import ProspectTagPicker from './ProspectTagPicker';

type TabKey = 'details' | 'communications' | 'proposals';

interface Props {
  prospectId: string;
  onClose: () => void;
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString() : '—';

const fullName = (first?: string | null, last?: string | null) =>
  [first, last].filter(Boolean).join(' ').trim() || '—';

export default function ProspectDetailModal({ prospectId, onClose }: Props) {
  const { user } = useAuth();
  const isAgentPortal = user?.currentRole === 'Agent' || user?.currentRole === 'AgencyOwner';
  const isAdmin = user?.currentRole === 'TenantAdmin' || user?.currentRole === 'SysAdmin';

  const { data, isLoading } = useProspect(prospectId);
  const updateMutation = useUpdateProspect();
  const linkMutation = useConfirmMemberLink();
  const deleteMutation = useDeleteProspect();
  const reassignMutation = useReassignProspect();

  // Agent downline options (for agent-portal reassign)
  const { data: downlineAgentOptions = [] } = useDownlineAgentsForFilter({
    includeShowAllOption: false,
    agencyOwnerFilter: true,
  });
  const hasDownline = isAgentPortal && downlineAgentOptions.filter((o) => o.value && o.value !== '').length > 0;

  // Admin-level agents
  const { data: adminAgents = [] } = useTenantAgentsForFilter(isAdmin);

  const canReassign = isAdmin || hasDownline;

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    premiumAmount: '',
    referralName: '',
    notes: '',
    status: 'New' as ProspectStatus,
    nextFollowUpDate: '',
  });
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('details');
  const [reassignAgentId, setReassignAgentId] = useState('');

  useEffect(() => {
    if (data?.prospect) {
      const d = data.prospect;
      setForm({
        firstName: d.FirstName || '',
        lastName: d.LastName || '',
        email: d.Email || '',
        phone: d.Phone || '',
        premiumAmount: d.PremiumAmount != null ? String(d.PremiumAmount) : '',
        referralName: d.ReferralName || '',
        notes: d.Notes || '',
        status: d.Status,
        nextFollowUpDate: d.NextFollowUpDate ? d.NextFollowUpDate.slice(0, 10) : '',
      });
      setDirty(false);
      setConfirmDelete(false);
    }
  }, [data?.prospect?.ProspectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = data?.prospect;
  const member = data?.member;
  const products = data?.products || [];
  const assignedTags = data?.tags ?? p?.Tags ?? [];
  const hasUnconfirmedMatch = !!p?.SuggestedMemberId && !p?.MemberId;

  // Last contacted display
  const lastContacted = p?.LastContactedDate;
  const lastContactedDisplay = (() => {
    if (!lastContacted) return 'Never';
    const d = new Date(lastContacted);
    const daysAgo = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    return `${d.toLocaleDateString()} (${daysAgo === 0 ? 'today' : daysAgo === 1 ? '1 day ago' : `${daysAgo} days ago`})`;
  })();

  const set = (k: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [k]: value }));
    setDirty(true);
  };

  const handleSave = () => {
    if (!p) return;
    updateMutation.mutate(
      {
        prospectId: p.ProspectId,
        input: {
          firstName: form.firstName || null,
          lastName: form.lastName || null,
          email: form.email || null,
          phone: form.phone || null,
          premiumAmount: form.premiumAmount ? Number(form.premiumAmount) : null,
          referralName: form.referralName || null,
          notes: form.notes || null,
          status: form.status,
          nextFollowUpDate: form.nextFollowUpDate || null,
        },
      },
      { onSuccess: () => setDirty(false) }
    );
  };

  const handleReassign = () => {
    if (!p || !reassignAgentId) return;
    reassignMutation.mutate(
      { prospectId: p.ProspectId, agentId: reassignAgentId },
      { onSuccess: () => setReassignAgentId('') }
    );
  };

  const handleConfirmLink = () => {
    if (!p) return;
    linkMutation.mutate({ prospectId: p.ProspectId });
  };

  const handleDelete = () => {
    if (!p) return;
    deleteMutation.mutate(p.ProspectId, { onSuccess: () => onClose() });
  };

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {p ? fullName(p.FirstName, p.LastName) : 'Prospect'}
            </h2>
            {p && (
              <span className={`inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded ${statusBadgeClass(p.Status)}`}>
                {p.Status}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        {p && (
          <div className="flex gap-1 px-6 pt-3 border-b border-gray-200">
            {([
              ['details', 'Details'],
              ['communications', 'Communications'],
              ['proposals', 'Proposals & Quotes'],
            ] as [TabKey, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px ${
                  activeTab === key
                    ? 'border-oe-primary text-oe-dark'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {isLoading || !p ? (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        ) : activeTab === 'communications' ? (
          <div className="p-6">
            <ProspectCommunicationsTab prospect={p} />
          </div>
        ) : activeTab === 'proposals' ? (
          <div className="p-6">
            <ProspectProposalsTab prospect={p} />
          </div>
        ) : (
          <div className="p-6 space-y-6">
            {/* Member match banner */}
            {hasUnconfirmedMatch && (
              <div className="flex items-start gap-3 p-4 rounded-lg bg-oe-light border border-oe-primary/30">
                <UserCheck className="w-5 h-5 text-oe-dark flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">Possible member match found</p>
                  <p className="text-sm text-gray-600">
                    {member
                      ? `${fullName(member.FirstName, member.LastName)} (${member.Email || member.PhoneNumber || 'member'}) appears to already be enrolled.`
                      : 'This prospect appears to match an existing member.'}{' '}
                    Confirm to link and mark as Closed.
                  </p>
                </div>
                <button
                  onClick={handleConfirmLink}
                  disabled={linkMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
                >
                  {linkMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                  Confirm link
                </button>
              </div>
            )}

            {/* Confirmed member link */}
            {p.MemberId && member && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800">
                <Link2 className="w-4 h-4" />
                Linked to member {fullName(member.FirstName, member.LastName)} ({member.Status}).
              </div>
            )}

            {/* Tags section */}
            <ProspectTagPicker prospectId={p.ProspectId} assignedTags={assignedTags} />

            {/* Editable contact details */}
            <div className="grid grid-cols-2 gap-4">
              <TextField label="First name" value={form.firstName} onChange={(v) => set('firstName', v)} />
              <TextField label="Last name" value={form.lastName} onChange={(v) => set('lastName', v)} />
              <TextField label="Email" type="email" value={form.email} onChange={(v) => set('email', v)} />
              <TextField label="Phone" value={form.phone} onChange={(v) => set('phone', v)} />
              <TextField label="Estimated premium" type="number" value={form.premiumAmount} onChange={(v) => set('premiumAmount', v)} />
              <Field label="Source" value={p.Source} />
              <Field label="Owning agent" value={fullName(p.AgentFirstName, p.AgentLastName)} />
              <Field label="Created" value={fmtDate(p.CreatedDate)} />
              {/* Follow-up date — editable */}
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Follow-up date</label>
                <input
                  type="date"
                  value={form.nextFollowUpDate}
                  onChange={(e) => set('nextFollowUpDate', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                />
              </div>
              {/* Last contacted — read-only */}
              <Field label="Last contacted" value={lastContactedDisplay} />
            </div>

            {/* Reassign agent */}
            {canReassign && (
              <div className="border-t border-gray-200 pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-2">Reassign to agent</h3>
                <div className="flex items-center gap-2">
                  <select
                    value={reassignAgentId}
                    onChange={(e) => setReassignAgentId(e.target.value)}
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary text-sm"
                  >
                    <option value="">Select agent…</option>
                    {isAdmin
                      ? adminAgents.map((a) => (
                          <option key={a.AgentId} value={a.AgentId}>
                            {[a.FirstName, a.LastName].filter(Boolean).join(' ').trim() || a.Email || 'Agent'}
                          </option>
                        ))
                      : downlineAgentOptions
                          .filter((o) => o.value && o.value !== '')
                          .map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                  </select>
                  <button
                    onClick={handleReassign}
                    disabled={!reassignAgentId || reassignMutation.isPending}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
                  >
                    {reassignMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                    Reassign
                  </button>
                </div>
              </div>
            )}

            {/* Products */}
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Products</h3>
              {products.length === 0 ? (
                <p className="text-sm text-gray-500">No products attached.</p>
              ) : (
                <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                  {products.map((pr) => (
                    <li key={pr.ProspectProductId} className="flex items-center justify-between px-3 py-2 text-sm">
                      <span className="text-gray-900">{pr.ProductName || pr.ProductId}</span>
                      <span className="text-gray-500">{fmtMoney(pr.PremiumAmount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Editable fields */}
            <div className="space-y-4 border-t border-gray-200 pt-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => set('status', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                >
                  {PROSPECT_STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <TextField label="Referral name" value={form.referralName} onChange={(v) => set('referralName', v)} />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
                />
              </div>
            </div>
          </div>
        )}

        {/* Footer (Details tab only) */}
        {p && activeTab === 'details' && (
        <div className="flex items-center justify-between gap-2 p-6 border-t border-gray-200">
          {/* Delete (with inline confirm) */}
          <div>
            {!p ? null : confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Delete this prospect?</span>
                <button
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-60"
                >
                  {deleteMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                  Confirm delete
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1.5 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg"
              >
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
            >
              Close
            </button>
            <button
              onClick={handleSave}
              disabled={!dirty || updateMutation.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
            >
              {updateMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Save changes
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-gray-900 mt-0.5 break-words">{value}</p>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
      />
    </div>
  );
}
