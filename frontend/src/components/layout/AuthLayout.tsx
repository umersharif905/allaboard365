import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import SessionManager from '../SessionManager';
import { useAuth } from '../../contexts/AuthContext';

// Simple inline loader component
const PageLoader = () => (
  <div className="flex items-center justify-center h-screen">
    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
  </div>
);

const AuthLayout: React.FC = () => {
  const { user, isLoading } = useAuth();
  const isAuthenticated = !!user;
  const location = useLocation();

  if (isLoading) {
    return <PageLoader />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return (
    // This is the root layout wrapper for all authenticated routes
    <div className="flex min-h-screen bg-gray-100 overflow-hidden">
      <div className="flex-1 min-w-0 relative">
        <Outlet />
      </div>
      <SessionManager />
    </div>
  );
};

export default AuthLayout; 