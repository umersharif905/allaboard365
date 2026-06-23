import { useQuery } from '@tanstack/react-query';
import AgentService from '../../services/agent/agent.service';

export const useAgentDashboard = () => {
  return useQuery({
    queryKey: ['agentDashboard'],
    queryFn: () => AgentService.getAgentDashboard(),
  });
}; 