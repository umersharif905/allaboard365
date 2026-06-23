import React, { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { getApiUrl, loadRuntimeConfig } from '../../config/api';

/**
 * Landing page for email unsubscribe links. If ?token= is present, redirects to the API
 * to verify the JWT and record opt-out, then the API redirects back with ?confirmed=1.
 */
export default function MarketingUnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const confirmed = params.get('confirmed');
  const err = params.get('error');

  useEffect(() => {
    if (!token || confirmed || err) return;
    let cancelled = false;
    (async () => {
      await loadRuntimeConfig();
      if (cancelled) return;
      const base = getApiUrl().replace(/\/$/, '');
      window.location.replace(`${base}/api/public/marketing-unsubscribe?token=${encodeURIComponent(token)}`);
    })();
    return () => {
      cancelled = true;
    };
  }, [token, confirmed, err]);

  if (token && !confirmed && !err) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-6">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-10 max-w-md w-full text-center">
          <div className="mx-auto mb-5 h-16 w-16 rounded-full bg-oe-light flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-oe-primary" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Processing your request</h1>
          <p className="text-gray-500">Updating your email preferences…</p>
        </div>
      </div>
    );
  }

  if (confirmed === '1') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6">
        <div className="bg-white rounded-lg border border-gray-200 p-8 max-w-md text-center shadow-sm">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">You are unsubscribed</h1>
          <p className="text-gray-600 mb-6">
            You will no longer receive marketing emails from us. You may still get account or legally required messages.
          </p>
          <Link to="/login" className="text-oe-primary hover:text-oe-dark font-medium">
            Sign in to the member portal
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 p-6">
      <div className="bg-white rounded-lg border border-red-200 p-8 max-w-md text-center">
        <h1 className="text-xl font-semibold text-gray-900 mb-2">Link not valid</h1>
        <p className="text-red-800 text-sm mb-4">{err ? decodeURIComponent(err) : 'This unsubscribe link is invalid or has expired.'}</p>
        <Link to="/" className="text-oe-primary hover:text-oe-dark font-medium">
          Home
        </Link>
      </div>
    </div>
  );
}
