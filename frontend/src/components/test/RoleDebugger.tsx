// src/components/test/RoleDebugger.tsx
// Debug component to see what's happening with roles

import React from 'react';
import { useAuth } from '../../contexts/AuthContext';

const RoleDebugger: React.FC = () => {
  const { user } = useAuth();

  return (
    <div className="fixed top-4 right-4 bg-white p-4 border-2 border-red-500 rounded-lg shadow-lg z-50 max-w-md">
      <h3 className="text-lg font-bold text-red-600 mb-2">🐛 Role Debug Info</h3>
      
      <div className="space-y-2 text-sm">
        <div>
          <strong>User Object:</strong>
          <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto">
            {JSON.stringify(user, null, 2)}
          </pre>
        </div>
        
        <div>
          <strong>LocalStorage Data:</strong>
          <div className="bg-gray-100 p-2 rounded text-xs">
            <div>roles: {localStorage.getItem('roles')}</div>
            <div>currentRole: {localStorage.getItem('currentRole')}</div>
            <div>roles: {localStorage.getItem('roles')}</div>
            <div>currentRole: {localStorage.getItem('currentRole')}</div>
            <div>userId: {localStorage.getItem('userId')}</div>
          </div>
        </div>

        <div>
          <strong>Role Analysis:</strong>
          <div className="text-xs">
            <div>• Has user: {user ? '✅' : '❌'}</div>
            <div>• Has roles array: {user?.roles ? '✅' : '❌'}</div>
            <div>• Roles length: {user?.roles?.length || 0}</div>
            <div>• Should show switcher: {user?.roles?.length > 1 ? '✅' : '❌'}</div>
          </div>
        </div>

        <div>
          <strong>Raw Data Check:</strong>
          <div className="text-xs bg-yellow-100 p-1 rounded">
            <div>user.userType: "{user?.userType}"</div>
            <div>user.currentRole: "{user?.currentRole}"</div>
            <div>user.roles: {JSON.stringify(user?.roles)}</div>
          </div>
        </div>
      </div>
      
      <button 
        onClick={() => console.log('Full AuthContext user:', user)}
        className="mt-2 px-2 py-1 bg-oe-primary text-white text-xs rounded"
      >
        Log to Console
      </button>
    </div>
  );
};

export default RoleDebugger;