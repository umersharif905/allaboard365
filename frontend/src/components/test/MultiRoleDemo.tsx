// src/components/test/MultiRoleDemo.tsx
// This is a test component to demonstrate multi-role functionality
import React from 'react';
import { useAuth } from '../../contexts/AuthContext';

const MultiRoleDemo: React.FC = () => {
  const { user, switchRole } = useAuth();

  if (!user) {
    return <div className="p-4">No user logged in</div>;
  }

  return (
    <div className="p-6 bg-white rounded-lg border border-gray-200 max-w-md">
      <h3 className="text-lg font-semibold mb-4">Multi-Role Test</h3>
      
      <div className="mb-4">
        <h4 className="font-medium text-gray-700">Current User:</h4>
        <p className="text-sm text-gray-600">{user.firstName} {user.lastName}</p>
        <p className="text-sm text-gray-600">{user.email}</p>
      </div>

      <div className="mb-4">
        <h4 className="font-medium text-gray-700">Current Role:</h4>
        <p className="text-sm font-mono bg-blue-100 text-blue-800 px-2 py-1 rounded">
          {user.currentRole}
        </p>
      </div>

      <div className="mb-4">
        <h4 className="font-medium text-gray-700">Available Roles:</h4>
        <div className="flex flex-wrap gap-2 mt-2">
          {user.roles?.map((role) => (
            <button
              key={role}
              onClick={() => switchRole(role)}
              className={`px-3 py-1 text-xs rounded-full border ${
                role === user.currentRole
                  ? 'bg-green-100 text-green-800 border-green-300'
                  : 'bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200'
              }`}
            >
              {role}
            </button>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-500">
        <p>Legacy UserType: {user.userType}</p>
        <p>Role Count: {user.roles?.length || 0}</p>
      </div>
    </div>
  );
};

export default MultiRoleDemo;