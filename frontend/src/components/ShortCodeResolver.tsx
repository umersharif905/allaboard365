// frontend/src/components/ShortCodeResolver.tsx
// Resolves short codes (/enroll-now/:shortCode) to enrollment links and redirects

import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { apiService } from '../services/api.service';

export const ShortCodeResolver: React.FC = () => {
  const { shortCode } = useParams<{ shortCode: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    const resolveShortCode = async () => {
      if (!shortCode) {
        console.error('❌ No short code provided');
        navigate('/error?message=Invalid enrollment link');
        return;
      }

      try {
        console.log('🔍 Resolving short code:', shortCode);

        const response = await apiService.get<{ success: boolean; data?: { linkToken: string; linkType: string; shortCode: string } }>(`/api/enroll-now/${shortCode}`);

        if (response.success && response.data?.linkToken) {
          const { linkToken } = response.data;
          console.log('✅ Short code resolved to linkToken:', linkToken);

          // Redirect to the enrollment wizard with the resolved link token
          navigate(`/enroll/${linkToken}`);
        } else {
          console.error('❌ Invalid response from server:', response);
          navigate('/error?message=Invalid enrollment link response');
        }
      } catch (error: any) {
        console.error('❌ Error resolving short code:', error);

        // Display user-friendly error message
        const errorMessage = error.response?.data?.message || error.message || 'Invalid or expired enrollment link';
        navigate(`/error?message=${encodeURIComponent(errorMessage)}`);
      }
    };

    resolveShortCode();
  }, [shortCode, navigate]);

  // Show loading spinner while resolving
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary mx-auto mb-4"></div>
        <p className="text-gray-600">Loading your enrollment...</p>
      </div>
    </div>
  );
};

