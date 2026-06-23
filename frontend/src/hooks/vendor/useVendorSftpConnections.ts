// frontend/src/hooks/vendor/useVendorSftpConnections.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { vendorSftpImportService } from '../../services/vendorSftpImport.service';
import type { SftpConnectionFormValues, SftpTestConnectionParams } from '../../types/vendor/vendorSftpImport.types';

const QUERY_KEY = ['vendorSftpConnections'];

export const useVendorSftpConnections = () =>
  useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => vendorSftpImportService.listConnections(),
  });

export const useCreateSftpConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SftpConnectionFormValues) => vendorSftpImportService.createConnection(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useUpdateSftpConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ connectionId, body }: { connectionId: string; body: Partial<SftpConnectionFormValues> }) =>
      vendorSftpImportService.updateConnection(connectionId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useDeleteSftpConnection = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) => vendorSftpImportService.deleteConnection(connectionId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
};

export const useTestSftpConnection = () =>
  useMutation({
    mutationFn: (params: SftpTestConnectionParams) => vendorSftpImportService.testConnection(params),
  });
