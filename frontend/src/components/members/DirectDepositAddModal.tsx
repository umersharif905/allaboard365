import { FormEvent, useState } from 'react';
import { X, Banknote, Loader2 } from 'lucide-react';
import {
  useAddMemberDirectDeposit
} from '../../hooks/members/useMemberDirectDeposits';

interface Props {
  memberId: string;
  tenantId?: string | null;
  onClose: () => void;
  onAdded?: () => void;
}

const DirectDepositAddModal = ({ memberId, tenantId, onClose, onAdded }: Props) => {
  const addMutation = useAddMemberDirectDeposit(memberId, tenantId);

  const [accountHolderName, setAccountHolderName] = useState('');
  const [bankName, setBankName] = useState('');
  const [bankAccountType, setBankAccountType] = useState<'Checking' | 'Savings' | ''>('');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!bankAccountType) {
      setError('Select an account type');
      return;
    }
    try {
      await addMutation.mutateAsync({
        accountHolderName,
        bankName,
        bankAccountType,
        routingNumber,
        accountNumber
      });
      onAdded?.();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save direct deposit';
      setError(msg);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
          <div className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-oe-primary" aria-hidden />
            <h2 className="text-lg font-semibold text-gray-900">Add direct deposit</h2>
          </div>
          <button
            type="button"
            className="rounded p-1 text-gray-500 hover:bg-gray-100"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 px-6 py-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Account holder name <span className="text-red-600">*</span>
            </label>
            <input
              type="text"
              value={accountHolderName}
              onChange={(e) => setAccountHolderName(e.target.value)}
              required
              maxLength={200}
              placeholder="Full name as it appears on the bank account"
              className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-oe-primary focus:outline-none focus:ring-1 focus:ring-oe-primary"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Bank name <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                required
                maxLength={200}
                placeholder="e.g. Chase, Wells Fargo"
                className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-oe-primary focus:outline-none focus:ring-1 focus:ring-oe-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Account type <span className="text-red-600">*</span>
              </label>
              <select
                value={bankAccountType}
                onChange={(e) => setBankAccountType(e.target.value as 'Checking' | 'Savings' | '')}
                required
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 focus:border-oe-primary focus:outline-none focus:ring-1 focus:ring-oe-primary"
              >
                <option value="">Select account type</option>
                <option value="Checking">Checking</option>
                <option value="Savings">Savings</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Routing number <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={routingNumber}
                onChange={(e) => setRoutingNumber(e.target.value.replace(/\D/g, '').slice(0, 9))}
                required
                placeholder="9-digit routing number"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono focus:border-oe-primary focus:outline-none focus:ring-1 focus:ring-oe-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Account number <span className="text-red-600">*</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 17))}
                required
                placeholder="Account number"
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono focus:border-oe-primary focus:outline-none focus:ring-1 focus:ring-oe-primary"
              />
            </div>
          </div>

          <p className="text-xs text-gray-500">
            Adding a new direct deposit deactivates any existing active record. The
            previous record stays in history.
          </p>

          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2 border-t border-gray-200 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={addMutation.isPending}
              className="inline-flex items-center gap-2 rounded-md bg-oe-primary px-4 py-2 text-sm font-medium text-white hover:bg-oe-dark disabled:opacity-60"
            >
              {addMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DirectDepositAddModal;
