import { ExternalLink, Loader2, Stethoscope } from 'lucide-react';
import React, { useState } from 'react';
import { useTelemedicineStatus } from '../../hooks/member/useTelemedicineStatus';
import { TelemedicineService } from '../../services/member/telemedicine.service';

export default function Telemedicine() {
  const { data: status, isLoading, error } = useTelemedicineStatus();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const portalAccessErrorMessage =
    "Failed to access portal. Your Telemedicine will not be available until your plan's effective date. If this is a mistake please contact support: support@mightywell.us";

  const handleOpenPortal = async () => {
    setOpenError(null);
    setOpening(true);
    try {
      const res = await TelemedicineService.getSsoUrl();
      if (res.success && res.data?.url) {
        window.open(res.data.url, '_blank', 'noopener,noreferrer');
      } else {
        const raw = res.message || 'Could not open portal. Please try again.';
        setOpenError(
          raw.includes('Could not create portal access') ? portalAccessErrorMessage : raw
        );
      }
    } catch (e: unknown) {
      const msg =
        (e && typeof (e as { message?: string }).message === 'string')
          ? (e as { message: string }).message
          : (e instanceof Error ? e.message : 'Failed to open portal');
      setOpenError(
        msg.includes('Could not create portal access') ? portalAccessErrorMessage : msg
      );
    } finally {
      setOpening(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 text-gray-600">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span>Loading telemedicine...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">
          {error instanceof Error ? error.message : 'Failed to load telemedicine status'}
        </div>
      </div>
    );
  }

  if (!status?.hasTelemedicine) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">Telemedicine</h1>
          <p className="text-gray-600">You do not have an active telemedicine product. If you believe this is an error, please contact support.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-blue-50 p-2">
            <Stethoscope className="h-8 w-8 text-blue-600" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Telemedicine</h1>
            {status.productName && (
              <p className="text-sm text-gray-500">{status.productName}</p>
            )}
          </div>
        </div>

        {!status.ssoConfigured && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800 mb-4">
            <p className="font-medium">Telemedicine account may not be setup yet</p>
            <p className="mt-1 text-sm">{status.message || 'Please wait for effective date or contact support if this is a mistake.'}</p>
            {status.effectiveDate && (
              <p className="mt-2 text-sm">Effective date: {status.effectiveDate}</p>
            )}
            <p className="mt-2 text-sm">You can try opening the portal anyway—if it&apos;s not ready, we&apos;ll show the reason below.</p>
          </div>
        )}

        <div className="space-y-4">
          {status.ssoConfigured && (
            <p className="text-gray-600">Open your telemedicine portal to access virtual care.</p>
          )}
          {openError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {openError}
            </div>
          )}
          <button
            type="button"
            onClick={handleOpenPortal}
            disabled={opening}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {opening ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            {opening ? 'Opening...' : 'Open portal'}
          </button>
        </div>
      </div>
    </div>
  );
}
