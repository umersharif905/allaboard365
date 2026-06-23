import React from 'react';
import { CheckCircle, Mail, ArrowRight } from 'lucide-react';
import { useSearchParams, Link } from 'react-router-dom';

const OnboardingSuccess: React.FC = () => {
  const [searchParams] = useSearchParams();
  const agentId = searchParams.get('agentId');

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-md mx-auto text-center px-4">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <CheckCircle className="w-16 h-16 text-green-500 mx-auto mb-6" />
          
          <h1 className="text-2xl font-bold text-gray-900 mb-4">
            Onboarding Complete!
          </h1>
          
          <p className="text-gray-600 mb-6">
            Congratulations! Your agent account has been successfully created. 
            You'll receive your login credentials via email shortly.
          </p>
          
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
            <div className="flex items-center">
              <Mail className="w-5 h-5 text-blue-500 mr-2" />
              <div className="text-sm text-oe-primary-dark">
                Check your email for login instructions and temporary password
              </div>
            </div>
          </div>
          
          <div className="space-y-3">
            <Link
              to="/login"
              className="w-full inline-flex items-center justify-center px-4 py-2 bg-[#1f8dbf] text-white rounded-lg hover:bg-[#1a7ba8] transition-colors text-sm font-medium"
            >
              Go to Login
              <ArrowRight className="w-4 h-4 ml-2" />
            </Link>
            
            <div className="text-xs text-gray-500">
              Agent ID: {agentId || 'N/A'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingSuccess;


