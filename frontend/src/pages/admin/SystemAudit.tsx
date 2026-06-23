import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { AlertTriangle, Bot, GitCompare, Receipt, ShieldCheck } from 'lucide-react';

// SysAdmin "System Audit" hub. Groups the three data-integrity / observability
// tools (Integration errors, Payout source audit, AI Inspector) behind a single
// left-nav entry with horizontal tabs rendered above each child page via Outlet.

const tabs = [
  {
    to: 'integration-errors',
    label: 'Integration errors',
    icon: AlertTriangle,
    description: 'Webhook and payment integration failures'
  },
  {
    to: 'payout-source-comparison',
    label: 'Payout source audit',
    icon: GitCompare,
    description: 'Compare oe.Payments vs oe.Invoices breakdown drift'
  },
  {
    to: 'billing-integrity',
    label: 'Billing integrity',
    icon: Receipt,
    description: 'Missing invoices, low system fees, orphan payments'
  },
  {
    to: 'ai-inspector',
    label: 'AI Inspector',
    icon: Bot,
    description: 'AI-powered log analysis and alerts'
  }
];

const SystemAudit: React.FC = () => {
  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 pt-6">
        <div className="flex items-center space-x-3 mb-4">
          <ShieldCheck className="h-7 w-7 text-oe-primary" />
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">System Audit</h1>
            <p className="text-sm text-gray-500">
              Data integrity and observability tools for platform administrators
            </p>
          </div>
        </div>

        <nav className="flex space-x-6 -mb-px">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  `flex items-center space-x-2 pb-3 px-1 border-b-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'border-oe-primary text-oe-primary'
                      : 'border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
                  }`
                }
              >
                <Icon className="h-4 w-4" />
                <span>{tab.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};

export default SystemAudit;
