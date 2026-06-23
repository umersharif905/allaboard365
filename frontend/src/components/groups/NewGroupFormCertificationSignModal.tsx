// Modal for Agent or Group Admin to sign the New Group Form certification (sign or type — same as ASA).
import React, { useState } from 'react';
import { X } from 'lucide-react';
import SignaturePad from '../enrollment-wizard/SignaturePad';

interface NewGroupFormCertificationSignModalProps {
  title: string;
  onConfirm: (signatureData: string) => void;
  onClose: () => void;
  loading?: boolean;
}

const CERTIFY_MESSAGE = 'I certify that the group information in this document is accurate and correct.';

const NewGroupFormCertificationSignModal: React.FC<NewGroupFormCertificationSignModalProps> = ({
  title,
  onConfirm,
  onClose,
  loading = false
}) => {
  const [signatureData, setSignatureData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    const data = (signatureData || '').trim();
    if (!data) {
      setError('Please provide your signature (draw or type your name).');
      return;
    }
    setError(null);
    onConfirm(data);
  };

  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 text-gray-500"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-gray-700">{CERTIFY_MESSAGE}</p>
          <SignaturePad
            label="Your signature"
            placeholder="Click and drag to sign, or type your name below"
            isRequired
            onSignatureChange={(v) => {
              setSignatureData(v || null);
              setError(null);
            }}
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="p-6 border-t border-gray-200 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={loading || !(signatureData && signatureData.trim())}
            className="px-4 py-2 rounded-lg text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Saving…' : 'Sign & Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default NewGroupFormCertificationSignModal;
