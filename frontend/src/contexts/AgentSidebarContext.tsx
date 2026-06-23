import React, { createContext, useContext } from 'react';

export type AgentSidebarContextValue = {
  sidebarOpen: boolean;
};

const AgentSidebarContext = createContext<AgentSidebarContextValue | null>(null);

export const AgentSidebarProvider: React.FC<{
  value: AgentSidebarContextValue;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <AgentSidebarContext.Provider value={value}>{children}</AgentSidebarContext.Provider>
);

export function useAgentSidebar(): AgentSidebarContextValue | null {
  return useContext(AgentSidebarContext);
}
