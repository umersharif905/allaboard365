import { Mail, X } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { billingService } from '../../services/billing.service';

type Props = {
  open: boolean;
  onClose: () => void;
  currentRole: string;
  /** Required when SysAdmin is viewing a specific tenant */
  tenantId?: string;
};

export function BillingAuditReportEmailsModal({ open, onClose, currentRole, tenantId }: Props) {
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!open) return;
    if (currentRole === 'SysAdmin' && !tenantId) return;
    setLoading(true);
    try {
      const res = await billingService.getAuditReportRecipients(currentRole, tenantId);
      if (res.success && res.data) setValue(res.data.emails || '');
      else {
        setValue('');
        if (res.message) toast.error(res.message);
      }
    } catch {
      setValue('');
      toast.error('Failed to load recipients');
    } finally {
      setLoading(false);
    }
  }, [open, currentRole, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (currentRole === 'SysAdmin' && !tenantId) {
      toast.error('Select a tenant first');
      return;
    }
    setSaving(true);
    try {
      const res = await billingService.putAuditReportRecipients(currentRole, tenantId, value);
      if (res.success) {
        toast.success('Daily report recipients saved');
        if (res.data?.emails != null) setValue(res.data.emails);
        onClose();
      } else {
        toast.error(res.message || 'Save failed');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close"
        onClick={() => !saving && onClose()}
      />
      <div className="relative bg-white rounded-lg border border-gray-200 shadow-xl max-w-lg w-full p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 min-w-0">
            <Mail className="h-5 w-5 text-gray-600 shrink-0" aria-hidden />
            <div>
              <h2 className="text-lg font-medium text-gray-900">Daily billing audit report</h2>
              <p className="text-sm text-gray-600 mt-1">
                Comma-separated addresses that receive <strong>this tenant&apos;s</strong> row from the nightly job.
                A full multi-tenant summary is always sent to improve@allaboard365.com.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="p-1 rounded-lg text-gray-500 hover:bg-gray-100"
            aria-label="Close dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {currentRole === 'SysAdmin' && !tenantId ? (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
            Select a tenant in the header to configure recipients for that tenant.
          </p>
        ) : (
          <>
            <label htmlFor="audit-report-emails" className="block text-sm font-medium text-gray-700 mb-1">
              Email addresses
            </label>
            <textarea
              id="audit-report-emails"
              rows={4}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={loading || saving}
              placeholder="ops@example.com, billing@example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm text-gray-900 disabled:bg-gray-50"
            />
            <p className="mt-2 text-xs text-gray-500">Leave empty to only use the improve@ backup (no copy to your team).</p>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => !saving && onClose()}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={loading || saving}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
