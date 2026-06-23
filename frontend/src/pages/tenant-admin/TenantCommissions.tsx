// frontend/src/pages/tenant-admin/TenantCommissions.tsx
import React, { useState } from 'react';
import { CommissionRulesManager } from '../../components/commissions/CommissionRulesManager';
import { RuleCreationWizard } from '../../components/commissions/RuleCreationWizard';

const TenantCommissions: React.FC = () => {
  const [showCreateWizard, setShowCreateWizard] = useState(false);

  return (
    <div className="p-6 max-w-full">
      <div className="bg-white rounded-lg border border-gray-200">
        <CommissionRulesManager 
          onRuleChange={(ruleId) => console.log('Rule changed:', ruleId)}
          onCreateRule={() => setShowCreateWizard(true)}
        />
      </div>

      {/* Rule Creation Wizard */}
      <RuleCreationWizard
        open={showCreateWizard}
        onClose={() => setShowCreateWizard(false)}
        onRuleCreated={(rule) => {
          console.log('Rule created:', rule);
          setShowCreateWizard(false);
        }}
      />
    </div>
  );
};

export default TenantCommissions;