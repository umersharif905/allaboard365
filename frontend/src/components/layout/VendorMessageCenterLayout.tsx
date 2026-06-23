// File: VendorMessageCenterLayout.tsx
// Path: frontend/src/components/layout/VendorMessageCenterLayout.tsx

import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { Mail, FileText, Megaphone, GitBranch } from 'lucide-react';

const VendorMessageCenterLayout: React.FC = () => {
  const location = useLocation();

  const navigationItems = [
    { to: 'templates', icon: FileText, label: 'Templates', description: 'Create and manage email & SMS templates' },
    { to: 'blast', icon: Megaphone, label: 'Message Blast', description: 'Send email and SMS to recipients' },
    { to: 'campaigns', icon: GitBranch, label: 'Campaigns', description: 'Automated message sequences' }
  ];

  return (
    <div className="h-[calc(100vh-64px)] flex bg-gray-50">
      <div className="w-64 flex-shrink-0 flex flex-col bg-white shadow-md border-r border-gray-200">
        <div className="p-6 border-b border-gray-200 flex-shrink-0">
          <div className="flex items-center space-x-3">
            <Mail className="h-8 w-8 text-oe-primary" />
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Message Center</h1>
              <p className="text-sm text-gray-500">Communication Hub</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 flex flex-col p-4 space-y-1 min-h-0 overflow-y-auto">
          {navigationItems.map((item) => {
            const isActive = location.pathname.includes(item.to);
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex items-start space-x-3 p-3 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-oe-light text-oe-dark'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <item.icon className={`h-5 w-5 mt-0.5 ${isActive ? 'text-oe-primary' : 'text-gray-400'}`} />
                <div className="flex-1">
                  <div className={`font-medium ${isActive ? 'text-oe-dark' : 'text-gray-900'}`}>
                    {item.label}
                  </div>
                  <div className="text-xs text-gray-500">{item.description}</div>
                </div>
              </NavLink>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 min-w-0 min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};

export default VendorMessageCenterLayout;
