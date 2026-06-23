// File: MessageCenterLayout.tsx
// Path: frontend/src/components/layout/MessageCenterLayout.tsx

import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { Mail, Calendar, FileText, Send, History, BarChart3, FileCheck, Megaphone, GitBranch } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const MessageCenterLayout: React.FC = () => {
  const { user } = useAuth();
  const location = useLocation();
  const userRole = user?.currentRole || user?.roles?.[0] || user?.userType;

  // Define navigation items based on role
  const getNavigationItems = () => {
    const baseItems = [
      {
        to: 'blast',
        icon: Megaphone,
        label: 'Message Blast',
        description: 'Send email and SMS campaigns'
      },
      {
        to: 'templates',
        icon: FileText,
        label: 'Templates',
        description: 'Create and manage email & SMS templates'
      },
      {
        to: 'campaigns',
        icon: GitBranch,
        label: 'Campaigns',
        description: 'Automated message sequences'
      },
      {
        to: 'proposals',
        icon: FileCheck,
        label: 'Proposals',
        description: 'Create and manage proposal templates'
      },
      {
        to: 'scheduled',
        icon: Calendar,
        label: 'Scheduled Messages',
        description: 'Schedule automated email campaigns'
      },
      {
        to: 'queue',
        icon: Send,
        label: 'Message Queue',
        description: 'View pending and processing messages'
      },
      {
        to: 'history',
        icon: History,
        label: 'Message History',
        description: 'Track sent messages and delivery status'
      }
    ];

    baseItems.push({
      to: 'analytics',
      icon: BarChart3,
      label: 'Analytics',
      description: 'Message performance and statistics'
    });

    return baseItems;
  };

  const navigationItems = getNavigationItems();

  return (
    <div className="h-[calc(100vh-64px)] flex bg-gray-50">
      {/* Sidebar - header at top, nav items vertically centered in remaining space */}
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
                    ? 'bg-blue-50 text-oe-primary-dark'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <item.icon className={`h-5 w-5 mt-0.5 ${isActive ? 'text-oe-primary' : 'text-gray-400'}`} />
                <div className="flex-1">
                  <div className={`font-medium ${isActive ? 'text-oe-primary-dark' : 'text-gray-900'}`}>
                    {item.label}
                  </div>
                  <div className="text-xs text-gray-500">{item.description}</div>
                </div>
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-w-0 min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};

export default MessageCenterLayout;