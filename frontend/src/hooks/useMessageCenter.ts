// File: useMessageCenter.ts
// Path: frontend/src/hooks/useMessageCenter.ts

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { messageTemplateService } from '../services/messageCenter.service';

export const useMessageTemplates = (params: any) => {
  return useQuery({
    queryKey: ['messageTemplates', params],
    queryFn: () => messageTemplateService.getTemplates(params)
  });
};

export const useCreateMessageTemplate = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: messageTemplateService.createTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['messageTemplates'] });
    }
  });
};

// Add more hooks for other operations