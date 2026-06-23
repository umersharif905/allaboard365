import React from 'react';
import { usePricing } from '../../hooks/usePricing';

const PricingTestComponent: React.FC = () => {
  // Test the new pricing system
  const { data: pricingData, isLoading, error } = usePricing({
    calculationType: 'enrollment',
    memberCriteria: {
      age: 35,
      tobaccoUse: 'No',
      tier: 'EE',
      householdSize: 1
    },
    productSelections: [
      {
        productId: 'test-product-1',
        configValues: {}
      }
    ]
  }, true);

  if (isLoading) {
    return <div>Loading pricing...</div>;
  }

  if (error) {
    return <div>Error: {error.message}</div>;
  }

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">Pricing Test Component</h2>
      <div className="bg-gray-100 p-4 rounded">
        <h3 className="font-semibold mb-2">Pricing Data:</h3>
        <pre className="text-sm overflow-auto">
          {JSON.stringify(pricingData, null, 2)}
        </pre>
      </div>
    </div>
  );
};

export default PricingTestComponent;