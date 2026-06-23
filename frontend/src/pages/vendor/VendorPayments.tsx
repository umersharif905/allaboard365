// frontend/src/pages/vendor/VendorPayments.tsx
import React from 'react';
import { DollarSign, Clock } from 'lucide-react';

const VendorPayments: React.FC = () => {
  return (
    <div className="p-6">
      <div className="flex items-center gap-3 mb-6">
        <DollarSign className="h-6 w-6 text-oe-primary" />
        <h1 className="text-2xl font-semibold text-gray-900">Payments</h1>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-12 text-center">
          <div className="mx-auto w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mb-4">
            <Clock className="h-8 w-8 text-oe-primary" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Coming Soon</h2>
          <p className="text-gray-600 max-w-md mx-auto">
            This page will display payments received from tenants that sell your products. 
            Payment tracking and reporting features are currently under development.
          </p>
          <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-100 max-w-md mx-auto">
            <p className="text-sm text-blue-800">
              <strong>Note:</strong> To manage your ACH accounts for receiving payments, 
              please visit the <span className="font-semibold">Settings</span> page and select the 
              <span className="font-semibold"> ACH Accounts</span> tab.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VendorPayments;
