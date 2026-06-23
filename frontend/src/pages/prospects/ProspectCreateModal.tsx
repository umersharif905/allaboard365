// frontend/src/pages/prospects/ProspectCreateModal.tsx
// Manual prospect creation. Uses find-or-create on the backend, so re-entering an
// existing email/phone updates that prospect instead of duplicating it.

import { Loader2, X } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useCreateProspect } from '../../hooks/useProspects';

interface Props {
  onClose: () => void;
  onCreated: (prospectId: string, created: boolean) => void;
}

export default function ProspectCreateModal({ onClose, onCreated }: Props) {
  const createMutation = useCreateProspect();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    referralName: '',
    premiumAmount: '',
    notes: '',
  });
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!form.firstName && !form.lastName && !form.email && !form.phone) {
      setError('Enter at least a name, email, or phone.');
      return;
    }
    createMutation.mutate(
      {
        firstName: form.firstName || undefined,
        lastName: form.lastName || undefined,
        email: form.email || undefined,
        phone: form.phone || undefined,
        referralName: form.referralName || undefined,
        premiumAmount: form.premiumAmount ? Number(form.premiumAmount) : undefined,
        notes: form.notes || undefined,
      },
      {
        onSuccess: (res) => onCreated(res.prospect.ProspectId, res.created),
        onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to create prospect'),
      }
    );
  };

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-lg border border-gray-200 shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Add Prospect</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">{error}</div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Input label="First name" value={form.firstName} onChange={set('firstName')} />
            <Input label="Last name" value={form.lastName} onChange={set('lastName')} />
          </div>
          <Input label="Email" type="email" value={form.email} onChange={set('email')} />
          <Input label="Phone" value={form.phone} onChange={set('phone')} />
          <Input label="Referral name" value={form.referralName} onChange={set('referralName')} />
          <Input label="Estimated premium" type="number" value={form.premiumAmount} onChange={set('premiumAmount')} />
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              value={form.notes}
              onChange={set('notes')}
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-oe-primary hover:bg-oe-dark rounded-lg disabled:opacity-60"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}

function Input({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={onChange}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
      />
    </div>
  );
}
