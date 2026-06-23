// src/contexts/TenantContext.tsx
import React, { createContext, useContext, ReactNode } from 'react';

interface TenantContextType {
  currentTenant: any;
  tenants: any[];
  setCurrentTenant: (tenant: any) => void;
  loading: boolean;
}

const TenantContext = createContext<TenantContextType | undefined>(undefined);

export const useTenant = () => {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
};

export const TenantProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <TenantContext.Provider value={{
      currentTenant: null,
      tenants: [],
      setCurrentTenant: () => {},
      loading: false
    }}>
      {children}
    </TenantContext.Provider>
  );
};
