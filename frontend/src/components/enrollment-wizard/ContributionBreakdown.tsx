import React from 'react';
import { type ContributionRule, type Product } from '../../services/ContributionCalculator';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';

// Debug utility function (reusing existing pattern)
const isDebugMode = () => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('debug') === '1';
};

interface ContributionBreakdownProps {
  products: Product[];
  selectedConfigs: Record<string, string>;
  allProductsRules: ContributionRule[];
  totals: {
    totalPremium: number;
    totalEmployerContribution: number;
    totalEmployeeContribution: number;
  };
  memberTier?: string;
  memberAge?: number;
  memberJobPosition?: string;
}

// Helper to format rule details for display
const formatRuleDetails = (rule: ContributionRule, memberAge?: number, memberJobPosition?: string): string => {
  const parts: string[] = [];
  
  // Rule type and direction
  parts.push(`${rule.type} (${rule.contributionDirection || 'Employer'})`);
  
  // Age-based rules
  if (rule.ageRules && rule.ageRules.length > 0) {
    const applicableAgeRule = memberAge !== undefined 
      ? rule.ageRules.find(r => {
          const age = memberAge || 0;
          return age >= r.minAge && (r.maxAge === null || age <= r.maxAge);
        })
      : null;
    
    if (applicableAgeRule) {
      parts.push(`Age ${applicableAgeRule.minAge}-${applicableAgeRule.maxAge || '∞'}: $${applicableAgeRule.contributionAmount.toFixed(2)}/${applicableAgeRule.contributionType === 'percentage' ? '%' : 'mo'}`);
    } else {
      parts.push(`Age ranges: ${rule.ageRules.map(r => `${r.minAge}-${r.maxAge || '∞'}`).join(', ')}`);
    }
  }
  
  // Job position filter
  if (rule.jobPositions && rule.jobPositions.length > 0) {
    const jobPositionLabels = rule.jobPositions.map(jp => {
      const found = DEFAULT_JOB_POSITIONS.find(djp => djp.id === jp);
      return found ? found.label : jp;
    });
    parts.push(`Job Positions: ${jobPositionLabels.join(', ')}`);
    if (memberJobPosition) {
      const matches = rule.jobPositions.includes(memberJobPosition);
      parts.push(`Member matches: ${matches ? '✓' : '✗'}`);
    }
  }
  
  // Tier-based rules
  if (rule.tierContributions) {
    const tierKeys = Object.keys(rule.tierContributions);
    if (tierKeys.length > 0) {
      parts.push(`Tiers: ${tierKeys.map(t => `${t}: $${rule.tierContributions![t as keyof typeof rule.tierContributions]}`).join(', ')}`);
    }
  }
  
  // Tenure-based rules
  if (rule.tenureRules && rule.tenureRules.length > 0) {
    parts.push(`Tenure ranges: ${rule.tenureRules.map(r => `${r.minTenure}-${r.maxTenure || '∞'} years`).join(', ')}`);
  }
  
  // Amount
  if (rule.amount > 0) {
    if (rule.type === 'percentage') {
      parts.push(`${rule.amount}%`);
    } else {
      parts.push(`$${rule.amount.toFixed(2)}`);
    }
  }
  
  return parts.join(' | ');
};

const ContributionBreakdown: React.FC<ContributionBreakdownProps> = ({
  products,
  selectedConfigs,
  allProductsRules,
  totals,
  memberTier,
  memberAge,
  memberJobPosition
}) => {
  // Only render if debug mode is enabled
  if (!isDebugMode()) {
    return null;
  }

  // Use backend-calculated contributions from products instead of recalculating
  const selectedProducts = products.filter(product => selectedConfigs[product.productId]);
  
  // Get product contributions from backend-calculated values
  const productContributions = selectedProducts.map(product => {
    const selectedConfig = selectedConfigs[product.productId];
    const variation = product.pricingVariations?.find(v => v.configValue === selectedConfig);
    const monthlyPremium = variation?.monthlyPremium || (product as any).monthlyPremium || 0;
    const employerContribution = (product as any).employerContribution || 0;
    const employeeContribution = (product as any).employeeContribution || 0;
    const contributionRules = product.contributionRules || [];
    
    return {
      productId: product.productId,
      productName: product.productName,
      selectedConfig,
      monthlyPremium,
      employer: employerContribution,
      employee: employeeContribution,
      appliedRules: contributionRules
    };
  });

  // Calculate remaining premium for all-products rules
  const totalProductPremium = productContributions.reduce((sum, p) => sum + p.monthlyPremium, 0);
  const totalProductEmployerContribution = productContributions.reduce((sum, p) => sum + p.employer, 0);
  const remainingPremium = totalProductPremium - totalProductEmployerContribution;

  return (
    <div className="contribution-breakdown bg-yellow-50 border border-yellow-200 rounded-lg p-6 mt-6">
      <div className="flex items-center mb-4">
        <h3 className="text-lg font-semibold text-gray-900">Contribution Breakdown (Backend Calculated)</h3>
        <span className="ml-3 px-2 py-1 text-xs font-medium bg-yellow-200 text-yellow-800 rounded-full">
          DEBUG MODE
        </span>
      </div>
      
      {/* Member Criteria */}
      {(memberAge !== undefined || memberJobPosition || memberTier) && (
        <div className="mb-4 p-3 bg-blue-50 rounded border border-blue-200">
          <h4 className="text-sm font-medium text-blue-900 mb-2">Member Criteria:</h4>
          <div className="text-xs text-oe-primary-dark space-y-1">
            {memberAge !== undefined && <div>Age: {memberAge}</div>}
            {memberJobPosition && <div>Job Position: {memberJobPosition}</div>}
            {memberTier && <div>Tier: {memberTier}</div>}
          </div>
        </div>
      )}
      
      {/* Product-specific contributions */}
      {productContributions.length > 0 && (
        <div className="mb-6">
          <h4 className="text-md font-medium text-gray-800 mb-3">Product Contributions</h4>
          <div className="space-y-3">
            {productContributions.map(contribution => (
              <div key={contribution.productId} className="bg-white rounded-lg p-4 border border-gray-200">
                <div className="flex justify-between items-start mb-2">
                  <h5 className="font-medium text-gray-900">{contribution.productName}</h5>
                  <div className="text-right">
                    <div className="text-sm text-gray-600">
                      Config: {contribution.selectedConfig || 'N/A'}
                    </div>
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-4 text-sm mb-3">
                  <div>
                    <span className="text-gray-600">Monthly Premium:</span>
                    <span className="ml-2 font-medium">
                      ${contribution.monthlyPremium.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">Employer Contribution:</span>
                    <span className="ml-2 font-medium text-green-600">
                      ${contribution.employer.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">Employee Contribution:</span>
                    <span className="ml-2 font-medium text-oe-primary">
                      ${contribution.employee.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">Employer %:</span>
                    <span className="ml-2 font-medium">
                      {contribution.monthlyPremium > 0 
                        ? ((contribution.employer / contribution.monthlyPremium) * 100).toFixed(1) 
                        : 0}%
                    </span>
                  </div>
                </div>
                
                {contribution.appliedRules.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="text-xs text-gray-500 mb-2 font-medium">Applied Rules ({contribution.appliedRules.length}):</div>
                    {contribution.appliedRules.map((rule, index) => (
                      <div key={index} className="text-xs text-gray-700 mb-1 pl-2 border-l-2 border-gray-300">
                        <div className="font-medium">{rule.description || `Rule ${index + 1}`}</div>
                        <div className="text-gray-600 mt-1">
                          {formatRuleDetails(rule, memberAge, memberJobPosition)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {/* All-products contributions */}
      {allProductsRules.length > 0 && (
        <div className="mb-6">
          <h4 className="text-md font-medium text-gray-800 mb-3">All-Products Rules</h4>
          <div className="bg-white rounded-lg p-4 border border-gray-200">
            <div className="grid grid-cols-2 gap-4 text-sm mb-3">
              <div>
                <span className="text-gray-600">Remaining Premium:</span>
                <span className="ml-2 font-medium">
                  ${remainingPremium.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-gray-600">Total Product Premium:</span>
                <span className="ml-2 font-medium">
                  ${totalProductPremium.toFixed(2)}
                </span>
              </div>
              <div>
                <span className="text-gray-600">Total Product Employer:</span>
                <span className="ml-2 font-medium text-green-600">
                  ${totalProductEmployerContribution.toFixed(2)}
                </span>
              </div>
            </div>
            
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="text-xs text-gray-500 mb-2 font-medium">All-Products Rules ({allProductsRules.length}):</div>
              {allProductsRules.map((rule, index) => (
                <div key={index} className="text-xs text-gray-700 mb-1 pl-2 border-l-2 border-gray-300">
                  <div className="font-medium">{rule.description || `All-Products Rule ${index + 1}`}</div>
                  <div className="text-gray-600 mt-1">
                    {formatRuleDetails(rule, memberAge, memberJobPosition)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* Final totals */}
      <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
        <h4 className="text-md font-medium text-blue-900 mb-3">Final Totals (Excluding Processing Fees)</h4>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <span className="text-oe-primary-dark">Total Premium:</span>
            <span className="ml-2 font-semibold text-blue-900">
              ${totals.totalPremium.toFixed(2)}
            </span>
          </div>
          <div>
            <span className="text-oe-primary-dark">Total Employer:</span>
            <span className="ml-2 font-semibold text-green-700">
              ${totals.totalEmployerContribution.toFixed(2)}
            </span>
          </div>
          <div>
            <span className="text-oe-primary-dark">Total Employee:</span>
            <span className="ml-2 font-semibold text-blue-800">
              ${totals.totalEmployeeContribution.toFixed(2)}
            </span>
          </div>
          <div>
            <span className="text-oe-primary-dark">Employer %:</span>
            <span className="ml-2 font-semibold text-green-700">
              {totals.totalPremium > 0 ? ((totals.totalEmployerContribution / totals.totalPremium) * 100).toFixed(1) : 0}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ContributionBreakdown;
