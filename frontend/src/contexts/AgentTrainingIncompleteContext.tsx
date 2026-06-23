import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { hasAgentTrainingIncomplete, type TrainingStatusPayload } from '../components/agent/AgentTrainingStatusPanel';
import { useAuth } from '../hooks/useAuth';
import { apiService } from '../services/api.service';

type AgentTrainingStatusTone = 'complete' | 'in_progress' | 'needs_attention';

type AgentTrainingModuleSegment = {
  key: string;
  label: string;
  completed: boolean;
};

type AgentTrainingSummary = {
  hasAssignedTraining: boolean;
  statusLine: string;
  statusTone: AgentTrainingStatusTone;
  modulesCompleted: number;
  modulesTotal: number;
  quizzesPassed: number;
  quizzesTotal: number;
  remainingItems: number;
  focusPackageTitle: string;
  moduleSegments: AgentTrainingModuleSegment[];
};

type AgentTrainingIncompleteContextValue = {
  trainingIncomplete: boolean;
  /** False when tenant disabled agent portal training; sidebar hides Training. */
  agentPortalTrainingEnabled: boolean;
  trainingSummary: AgentTrainingSummary | null;
  refresh: () => Promise<void>;
};

const AgentTrainingIncompleteContext = createContext<AgentTrainingIncompleteContextValue | null>(null);

/**
 * Fetches `/api/me/agent/training/library-status` on mount and exposes whether assigned training is incomplete.
 * Used for navigation and global training progress summaries.
 */
export function AgentTrainingIncompleteProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const [trainingIncomplete, setTrainingIncomplete] = useState(false);
  const [agentPortalTrainingEnabled, setAgentPortalTrainingEnabled] = useState(true);
  const [trainingSummary, setTrainingSummary] = useState<AgentTrainingSummary | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = (await apiService.get('/api/me/agent/training/library-status')) as {
        success?: boolean;
        data?: TrainingStatusPayload;
      };
      if (!res?.success || !res.data) {
        setTrainingIncomplete(false);
        setAgentPortalTrainingEnabled(true);
        setTrainingSummary(null);
        return;
      }
      const portalOn = res.data.agentPortalTrainingEnabled !== false;
      setAgentPortalTrainingEnabled(portalOn);
      if (!portalOn) {
        setTrainingIncomplete(false);
        return;
      }

      const { libraryPackages } = res.data;
      const hasContent = libraryPackages && libraryPackages.length > 0;
      if (!hasContent) {
        setTrainingIncomplete(false);
        setTrainingSummary(null);
        return;
      }

      const totalModules = (libraryPackages || []).reduce((sum, pkg) => sum + (pkg.modulesTotal || 0), 0);
      const completedModules = (libraryPackages || []).reduce(
        (sum, pkg) => sum + (pkg.modulesCompleted || 0),
        0
      );
      const remainingModules = Math.max(0, totalModules - completedModules);
      const remainingItems = remainingModules;
      const incomplete = hasAgentTrainingIncomplete(res.data);

      const focusPackage =
        (libraryPackages || []).find(pkg => pkg.modulesCompleted < pkg.modulesTotal) ||
        (libraryPackages || [])[0] ||
        null;

      const moduleSegments: AgentTrainingModuleSegment[] = focusPackage
        ? (
            focusPackage.modules && focusPackage.modules.length > 0
              ? focusPackage.modules
              : Array.from({ length: focusPackage.modulesTotal || 0 }, (_, idx) => ({
                  moduleId: `${focusPackage.packageId}-module-${idx + 1}`,
                  title: `Module ${idx + 1}`,
                  completed: idx < (focusPackage.modulesCompleted || 0)
                }))
          ).map(module => ({
            key: module.moduleId,
            label: module.title,
            completed: Boolean(module.completed)
          }))
        : [];

      const statusTone: AgentTrainingStatusTone =
        remainingItems === 0
          ? 'complete'
          : completedModules === 0
            ? 'needs_attention'
            : 'in_progress';

      setTrainingIncomplete(incomplete);
      setTrainingSummary({
        hasAssignedTraining: true,
        statusLine:
          remainingItems > 0
            ? `Training: ${completedModules}/${totalModules} modules complete - ${remainingItems} module${remainingItems === 1 ? '' : 's'} left for your MightyWELL certificate.`
            : `Training complete: ${completedModules}/${totalModules} modules complete.`,
        statusTone,
        modulesCompleted: completedModules,
        modulesTotal: totalModules,
        quizzesPassed: 0,
        quizzesTotal: 0,
        remainingItems,
        focusPackageTitle: focusPackage?.title || 'Assigned Package',
        moduleSegments
      });
    } catch {
      setTrainingIncomplete(false);
      setAgentPortalTrainingEnabled(true);
      setTrainingSummary(null);
    }
  }, [activeTenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ trainingIncomplete, agentPortalTrainingEnabled, trainingSummary, refresh }),
    [trainingIncomplete, agentPortalTrainingEnabled, trainingSummary, refresh]
  );

  return (
    <AgentTrainingIncompleteContext.Provider value={value}>
      {children}
    </AgentTrainingIncompleteContext.Provider>
  );
}

export function useAgentTrainingIncomplete(): AgentTrainingIncompleteContextValue {
  const ctx = useContext(AgentTrainingIncompleteContext);
  if (!ctx) {
    throw new Error('useAgentTrainingIncomplete must be used within AgentTrainingIncompleteProvider');
  }
  return ctx;
}
