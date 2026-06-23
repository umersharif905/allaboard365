// TPA Case Forwarding settings (VendorAdmin). Manage per-plan-vendor forwarding
// targets (comma-separated recipient list + template) and create starter
// ARM / Tall Tree templates. See backend routes/me/vendor/case-forwarding.js.
import { useState } from 'react';
import { Plus, Trash2, Save, FileText } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useForwardingTargets } from '../../../hooks/vendor/useCaseForwarding';
import { caseForwardingService, type ForwardingTarget } from '../../../services/caseForwarding.service';

const TpaForwardingTab = () => {
  const { data: targets = [], isLoading } = useForwardingTargets();
  const qc = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ planVendorId: '', label: '', forwardingEmails: '', templateId: '' });
  // Per-target in-progress edits of the recipient list (controlled inputs).
  const [emailEdits, setEmailEdits] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['forwardingTargets'] });

  const handleCreate = async () => {
    setMsg(null);
    try {
      await caseForwardingService.createTarget({
        planVendorId: form.planVendorId.trim(),
        label: form.label.trim(),
        forwardingEmails: form.forwardingEmails.trim(),
        templateId: form.templateId.trim() || null,
      });
      setForm({ planVendorId: '', label: '', forwardingEmails: '', templateId: '' });
      refresh();
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed to create'); }
  };

  const handleSaveEmails = async (t: ForwardingTarget) => {
    setMsg(null);
    setSavingId(t.TargetId);
    const forwardingEmails = (emailEdits[t.TargetId] ?? t.ForwardingEmails).trim();
    try {
      await caseForwardingService.updateTarget(t.TargetId, {
        label: t.Label, forwardingEmails, templateId: t.TemplateId, isActive: t.IsActive,
      });
      // Drop the local edit so the input falls back to the refetched value.
      setEmailEdits((prev) => { const next = { ...prev }; delete next[t.TargetId]; return next; });
      refresh();
      setMsg(`Saved recipients for ${t.Label}.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this forwarding target?')) return;
    await caseForwardingService.deleteTarget(id);
    refresh();
  };

  const handleStarter = async (variant: 'arm' | 'tallTree') => {
    try {
      const r = await caseForwardingService.createStarterTemplate(variant);
      setMsg(`Created template "${r.data.TemplateName}" (id ${r.data.TemplateId}). Paste this id into a target's Template field.`);
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Failed'); }
  };

  return (
    <div className="space-y-6">
      {msg && <div className="p-3 rounded-lg bg-oe-light text-oe-dark text-sm">{msg}</div>}

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Starter templates</h3>
        <div className="flex gap-2">
          <button type="button" onClick={() => handleStarter('arm')} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50"><FileText className="h-3.5 w-3.5" /> Create ARM template</button>
          <button type="button" onClick={() => handleStarter('tallTree')} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-gray-300 rounded-md hover:bg-gray-50"><FileText className="h-3.5 w-3.5" /> Create Tall Tree template</button>
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Add forwarding target</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <input placeholder="Plan Vendor ID (ARM / Tall Tree)" value={form.planVendorId} onChange={(e) => setForm({ ...form, planVendorId: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
          <input placeholder="Label (e.g. ARM)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm" />
          <input placeholder="Forwarding emails (comma-separated)" value={form.forwardingEmails} onChange={(e) => setForm({ ...form, forwardingEmails: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm md:col-span-2" />
          <input placeholder="Template ID (optional)" value={form.templateId} onChange={(e) => setForm({ ...form, templateId: e.target.value })} className="border border-gray-300 rounded-md px-2 py-1 text-sm md:col-span-2" />
        </div>
        <button type="button" onClick={handleCreate} className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-oe-primary text-white rounded-md hover:bg-oe-dark"><Plus className="h-4 w-4" /> Add target</button>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Configured targets</h3>
        {isLoading ? <p className="text-sm text-gray-500">Loading…</p> : targets.length === 0 ? (
          <p className="text-sm text-gray-500">No targets configured yet.</p>
        ) : (
          <div className="space-y-3">
            {targets.map((t) => (
              <div key={t.TargetId} className="border border-gray-200 rounded-md p-3 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t.Label}</span>
                <span className="text-xs text-gray-500">({t.PlanVendorName})</span>
                <input
                  value={emailEdits[t.TargetId] ?? t.ForwardingEmails}
                  onChange={(e) => setEmailEdits((prev) => ({ ...prev, [t.TargetId]: e.target.value }))}
                  placeholder="comma-separated emails"
                  className="flex-1 min-w-[200px] border border-gray-300 rounded px-2 py-1 text-xs"
                />
                <button
                  type="button"
                  onClick={() => handleSaveEmails(t)}
                  disabled={savingId === t.TargetId || (emailEdits[t.TargetId] ?? t.ForwardingEmails) === t.ForwardingEmails}
                  className="text-oe-dark hover:bg-oe-light rounded p-1 disabled:opacity-40"
                  title="Save recipients"
                >
                  <Save className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => handleDelete(t.TargetId)} className="text-red-600 hover:bg-red-50 rounded p-1" title="Delete"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default TpaForwardingTab;
