// frontend/src/hooks/vendor/useCaseForwarding.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { caseForwardingService } from '../../services/caseForwarding.service';

export const useForwardingTargets = () =>
  useQuery({
    queryKey: ['forwardingTargets'],
    queryFn: () => caseForwardingService.listTargets(),
    select: (r) => (r.success ? r.data : []),
  });

export const useForwardingPreview = (caseId: string | null) =>
  useQuery({
    queryKey: ['forwardingPreview', caseId],
    queryFn: () => caseForwardingService.getPreview(caseId as string),
    enabled: !!caseId,
    select: (r) => r.data,
  });

export const useSendForwarding = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ caseId, ...body }: { caseId: string; to: string[]; subject: string; body: string; documentIds: string[] }) =>
      caseForwardingService.send(caseId, body),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['forwardingPreview', vars.caseId] });
      qc.invalidateQueries({ queryKey: ['caseHistory', vars.caseId] });
    },
  });
};
