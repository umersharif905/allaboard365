// frontend/src/components/accounting/SendNACHAModal.tsx
import { Loader2, Send, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { apiService } from '../../services/api.service';
import { NACHAGeneration, nachaService } from '../../services/nachaService';

interface VendorOption {
  Id: string;
  VendorName: string;
  HasSftp?: boolean;
}

interface VendorExportDetails {
  SftpPath?: string | null;
  ExportEmailAddress?: string | null;
  SftpHostname?: string | null;
  SftpPort?: number | null;
  SftpUsername?: string | null;
}

interface SendNACHAModalProps {
  nacha: NACHAGeneration;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const SendNACHAModal: React.FC<SendNACHAModalProps> = ({ nacha, isOpen, onClose, onSuccess }) => {
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [vendorsLoading, setVendorsLoading] = useState(false);
  const [vendorId, setVendorId] = useState('');
  const [vendorDetails, setVendorDetails] = useState<VendorExportDetails | null>(null);
  const [sftpPath, setSftpPath] = useState('');
  const [exportEmailAddress, setExportEmailAddress] = useState('');
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [markAsSent, setMarkAsSent] = useState(true);

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setSuccessMessage(null);
      setMarkAsSent(true);
      setVendorId('');
      setVendorDetails(null);
      setSftpPath('');
      setExportEmailAddress('');
      fetchVendors();
    }
  }, [isOpen]);

  const fetchVendors = async () => {
    setVendorsLoading(true);
    try {
      const [vendorsRes, defaultRes] = await Promise.all([
        apiService.get<{ success: boolean; data?: VendorOption[] }>('/api/vendors?includeSftpStatus=1&limit=500'),
        nachaService.getDefaultSendVendor(nacha.nachaId)
      ]);
      if (vendorsRes.success && Array.isArray(vendorsRes.data)) {
        setVendors(vendorsRes.data);
        if (defaultRes.success && defaultRes.vendorId) {
          const hasSftp = vendorsRes.data.find((v) => v.Id === defaultRes.vendorId)?.HasSftp;
          if (hasSftp) setVendorId(defaultRes.vendorId);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vendors');
    } finally {
      setVendorsLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !vendorId) {
      setVendorDetails(null);
      setSftpPath('');
      setExportEmailAddress('');
      return;
    }
    setDetailsLoading(true);
    setError(null);
    apiService
      .get<{ success: boolean; data?: VendorExportDetails }>(`/api/vendors/${vendorId}`)
      .then((res) => {
        if (res.success && res.data) {
          setVendorDetails(res.data);
          setSftpPath(res.data.SftpPath ?? '');
          setExportEmailAddress(res.data.ExportEmailAddress ?? '');
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to load vendor details');
        setVendorDetails(null);
      })
      .finally(() => setDetailsLoading(false));
  }, [isOpen, vendorId]);

  const handleSend = async () => {
    if (!vendorId) {
      setError('Please select a send destination (vendor).');
      return;
    }
    setSending(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const res = await nachaService.sendNACHA(nacha.nachaId, {
        vendorId,
        sftpPath: sftpPath.trim() || undefined,
        exportEmailAddress: exportEmailAddress.trim() || undefined
      });
      if (res.success) {
        let markSuccess = false;
        if (markAsSent && nacha.status === 'Pending') {
          try {
            await nachaService.markNACHAasSent(nacha.nachaId);
            markSuccess = true;
          } catch (markErr) {
            setError(markErr instanceof Error ? markErr.message : 'Failed to mark NACHA as paid.');
          }
        }
        const baseMsg = res.data?.emailQueued
          ? `File uploaded to SFTP and notification email queued. Path: ${res.data.remotePath ?? '—'}`
          : `File uploaded to SFTP. Path: ${res.data?.remotePath ?? '—'}`;
        setSuccessMessage(markSuccess ? `${baseMsg} NACHA marked as paid.` : baseMsg);
        onSuccess?.();
      } else {
        setError((res as any).message || 'Send failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send NACHA file');
    } finally {
      setSending(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="fixed inset-0 bg-gray-500 bg-opacity-75" onClick={onClose} aria-hidden="true" />
        <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Send NACHA File</h3>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 p-1 rounded"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-sm text-gray-600 mb-4">
            File: <span className="font-medium text-gray-900">{nacha.fileName}</span>
          </p>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Send destination (vendor)</label>
              <select
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                disabled={vendorsLoading}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              >
                <option value="">Select a vendor...</option>
                {vendors.map((v) => {
                  const hasSftp = Boolean(v.HasSftp);
                  return (
                    <option
                      key={v.Id}
                      value={v.Id}
                      disabled={!hasSftp}
                    >
                      {v.VendorName}
                      {!hasSftp ? ' (No SFTP)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>

            {detailsLoading && vendorId && (
              <div className="flex items-center text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading destination details...
              </div>
            )}

            {vendorId && vendorDetails && !detailsLoading && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">SFTP destination</p>
                <dl className="grid grid-cols-1 gap-1 text-sm">
                  {vendorDetails.SftpHostname != null && vendorDetails.SftpHostname !== '' && (
                    <>
                      <dt className="text-gray-500">Host</dt>
                      <dd className="font-mono text-gray-900">{vendorDetails.SftpHostname}</dd>
                    </>
                  )}
                  {vendorDetails.SftpPort != null && Number(vendorDetails.SftpPort) > 0 && (
                    <>
                      <dt className="text-gray-500">Port</dt>
                      <dd className="font-mono text-gray-900">{vendorDetails.SftpPort}</dd>
                    </>
                  )}
                  {vendorDetails.SftpUsername != null && vendorDetails.SftpUsername !== '' && (
                    <>
                      <dt className="text-gray-500">Username</dt>
                      <dd className="font-mono text-gray-900">{vendorDetails.SftpUsername}</dd>
                    </>
                  )}
                  {(!vendorDetails.SftpHostname || vendorDetails.SftpHostname === '') &&
                    (!vendorDetails.SftpUsername || vendorDetails.SftpUsername === '') && (
                      <dd className="text-gray-500">No SFTP details configured for this vendor.</dd>
                    )}
                </dl>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">SFTP path (folder location)</label>
              <input
                type="text"
                value={sftpPath}
                onChange={(e) => setSftpPath(e.target.value)}
                placeholder="e.g. /incoming/nacha"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              <p className="text-xs text-gray-500 mt-1">Leave blank to use vendor default. Change here only affects this send.</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Notification email</label>
              <input
                type="email"
                value={exportEmailAddress}
                onChange={(e) => setExportEmailAddress(e.target.value)}
                placeholder="Email to notify when file is uploaded"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              />
              <p className="text-xs text-gray-500 mt-1">Leave blank to use vendor default. Change here only affects this send.</p>
            </div>

            {nacha.status === 'Pending' && (
              <>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={markAsSent}
                    onChange={(e) => setMarkAsSent(e.target.checked)}
                    className="rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  />
                  <span className="text-sm font-medium text-gray-700">Mark as paid</span>
                </label>
                <p className="text-xs text-gray-500 -mt-2 ml-6">If checked, marks this NACHA as paid and updates payment records (same as the row action).</p>
              </>
            )}
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              {error}
            </div>
          )}
          {successMessage && (
            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
              {successMessage}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
            >
              {successMessage ? 'Close' : 'Cancel'}
            </button>
            {!successMessage && (
              <button
                type="button"
                onClick={handleSend}
                disabled={sending || !vendorId}
                className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 flex items-center gap-2"
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" />
                    Send
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SendNACHAModal;
