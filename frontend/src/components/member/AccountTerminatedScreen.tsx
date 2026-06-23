import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { apiService } from '../../services/api.service';

interface AccountTerminatedScreenProps {
  memberId?: string;
  terminatedDate?: string;
}

const AccountTerminatedScreen: React.FC<AccountTerminatedScreenProps> = ({ 
  memberId, 
  terminatedDate 
}) => {
  const [isReactivating, setIsReactivating] = useState(false);
  const [reactivationMessage, setReactivationMessage] = useState('');
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleReactivate = async () => {
    try {
      setIsReactivating(true);
      setReactivationMessage('');
      
      const response = await apiService.put('/api/me/member/reactivate', {}) as any;
      
      if (response.success) {
        setReactivationMessage('Account reactivated successfully! Redirecting...');
        setTimeout(() => {
          navigate('/member/dashboard');
        }, 2000);
      } else {
        setReactivationMessage(response.message || 'Failed to reactivate account');
      }
    } catch (error) {
      setReactivationMessage('Error reactivating account. Please try again.');
    } finally {
      setIsReactivating(false);
    }
  };

  const handleContactSupport = () => {
    // You can implement this to open a support ticket or contact form
    window.open('mailto:improve@allaboard365.com?subject=Account Termination Issue', '_blank');
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Account Terminated
          </h1>
          <p className="text-lg text-gray-600">
            Your member account has been terminated
          </p>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-white py-8 px-4 shadow sm:rounded-lg sm:px-10">
          <div className="text-center mb-6">
            <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
              <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">
              Account Access Suspended
            </h2>
            <p className="text-gray-600">
              Your member account has been terminated and you no longer have access to member services.
            </p>
          </div>

          {memberId && (
            <div className="bg-gray-50 rounded-md p-4 mb-6">
              <div className="text-sm text-gray-600">
                <p><strong>Member ID:</strong> {memberId}</p>
                {terminatedDate && (
                  <p><strong>Terminated:</strong> {new Date(terminatedDate).toLocaleDateString()}</p>
                )}
              </div>
            </div>
          )}

          <div className="space-y-4">
            <button
              onClick={handleReactivate}
              disabled={isReactivating}
              className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-oe-primary hover:bg-oe-primary-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isReactivating ? 'Reactivating...' : 'Reactivate Account'}
            </button>

            <button
              onClick={handleContactSupport}
              className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
            >
              Contact Support
            </button>

            <button
              onClick={handleLogout}
              className="w-full flex justify-center py-2 px-4 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-oe-primary"
            >
              Sign Out
            </button>
          </div>

          {reactivationMessage && (
            <div className={`mt-4 p-3 rounded-md text-sm ${
              reactivationMessage.includes('successfully') 
                ? 'bg-green-50 text-green-800 border border-green-200' 
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}>
              {reactivationMessage}
            </div>
          )}

          <div className="mt-6 text-center">
            <p className="text-xs text-gray-500">
              If you believe this is an error or need assistance, please contact our support team.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AccountTerminatedScreen;
