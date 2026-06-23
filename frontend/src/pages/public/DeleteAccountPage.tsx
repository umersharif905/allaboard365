import { Loader2, Mail } from 'lucide-react';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiService } from '../../services/api.service';
import { getErrorMessage } from '../../utils/helpers';

const LOGO_URL = '/images/branding/allaboard365/allaboard365-logo-primary-transparent.png';

const DeleteAccountPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setSubmitting(true);
    try {
      const result = await apiService.post<{ success: boolean; message?: string }>(
        '/api/public/delete-account/request',
        { email: email.trim() }
      );
      if (result.success) {
        setSuccessMessage(
          result.message ||
            'Thanks — we received your request. We will be in touch soon to confirm account cancellation.'
        );
        setEmail('');
      } else {
        setError(result.message || 'Request could not be submitted.');
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-lg">
        <div className="flex justify-center mb-8">
          <img
            src={LOGO_URL}
            alt="AllAboard365"
            className="h-24 sm:h-28 md:h-32 w-auto max-w-full"
          />
        </div>

        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
          <div className="p-6 border-b border-gray-200">
            <h1 className="text-2xl font-semibold text-gray-900">Request account cancellation</h1>
            <p className="mt-2 text-gray-600 text-sm">
              Enter the email address associated with your account. We will email our team and follow up with you to
              confirm cancellation.
            </p>
          </div>

          <div className="p-6">
            {successMessage ? (
              <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-800 text-sm">
                {successMessage}
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="delete-account-email" className="block text-sm font-medium text-gray-700 mb-1">
                    Email address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                    <input
                      id="delete-account-email"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-800 text-sm">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Submitting…
                    </>
                  ) : (
                    'Submit request'
                  )}
                </button>
              </form>
            )}

            <p className="mt-6 text-center text-sm text-gray-500">
              <Link to="/login" className="text-blue-600 hover:text-blue-700 font-medium">
                Back to login
              </Link>
              {' · '}
              <Link to="/privacy-policy" className="text-blue-600 hover:text-blue-700 font-medium">
                Privacy policy
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default DeleteAccountPage;
