import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Plus, Server, Trash2, XCircle, Pencil } from 'lucide-react';
import {
  useVendorSftpConnections,
  useDeleteSftpConnection,
  useTestSftpConnection,
} from '../../../hooks/vendor/useVendorSftpConnections';
import VendorSftpConnectionModal from './VendorSftpConnectionModal';
import type { SftpConnection, SftpTestResult } from '../../../types/vendor/vendorSftpImport.types';

const AuthBadge: React.FC<{ connection: SftpConnection }> = ({ connection }) => {
  if (connection.authType === 'privateKey') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-purple-50 text-purple-700 border border-purple-200">
        Private key
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600 border border-gray-200">
      Password
    </span>
  );
};

const VendorSftpConnectionsManager: React.FC = () => {
  const { data: connections = [], isLoading, isError } = useVendorSftpConnections();
  const deleteMutation = useDeleteSftpConnection();
  const testMutation = useTestSftpConnection();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<SftpConnection | null>(null);
  const [testResults, setTestResults] = useState<Record<string, SftpTestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleAdd = () => {
    setEditingConnection(null);
    setModalOpen(true);
  };

  const handleEdit = (conn: SftpConnection) => {
    setEditingConnection(conn);
    setModalOpen(true);
  };

  const handleTest = async (connectionId: string) => {
    setTestingId(connectionId);
    setTestResults((prev) => ({ ...prev, [connectionId]: { success: false } }));
    try {
      const result = await testMutation.mutateAsync({ connectionId });
      setTestResults((prev) => ({ ...prev, [connectionId]: result }));
    } catch (e) {
      setTestResults((prev) => ({
        ...prev,
        [connectionId]: { success: false, error: e instanceof Error ? e.message : 'Test failed' },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleDeleteConfirm = async (connectionId: string) => {
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(connectionId);
      setDeleteConfirmId(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading SFTP connections…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600 py-4">
        <AlertCircle className="h-4 w-4" /> Failed to load connections.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">SFTP Connections</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Reusable SFTP server credentials for scheduled imports. Credentials are encrypted at rest.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-lg"
        >
          <Plus className="h-4 w-4" /> Add connection
        </button>
      </div>

      {connections.length === 0 ? (
        <div className="text-center py-10 border border-dashed border-gray-300 rounded-lg">
          <Server className="h-8 w-8 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No SFTP connections configured yet.</p>
          <button
            type="button"
            onClick={handleAdd}
            className="mt-3 text-sm text-oe-primary hover:underline"
          >
            Add your first connection
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 divide-y divide-gray-100">
          {connections.map((conn) => {
            const testResult = testResults[conn.connectionId];
            const isTesting = testingId === conn.connectionId;

            return (
              <div key={conn.connectionId} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-sm text-gray-900">{conn.displayName}</span>
                      <AuthBadge connection={conn} />
                      {!conn.isActive && (
                        <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-500 border border-gray-200">
                          Inactive
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {conn.username}@{conn.host}:{conn.port}
                      {conn.baseDirectory ? ` — base: ${conn.baseDirectory}` : ''}
                    </p>
                    {testResult && (
                      <div className={`mt-2 flex items-center gap-1.5 text-xs ${testResult.success ? 'text-green-700' : 'text-red-600'}`}>
                        {testResult.success ? (
                          <>
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Connected successfully
                            {testResult.latencyMs !== undefined && ` (${testResult.latencyMs}ms)`}
                          </>
                        ) : (
                          <>
                            <XCircle className="h-3.5 w-3.5" />
                            {testResult.error ?? 'Connection failed'}
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleTest(conn.connectionId)}
                      disabled={isTesting}
                      className="px-2.5 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 flex items-center gap-1"
                    >
                      {isTesting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {isTesting ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleEdit(conn)}
                      className="p-1.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeleteConfirmId(conn.connectionId); setDeleteError(null); }}
                      className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {deleteConfirmId === conn.connectionId && (
                  <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm">
                    <p className="text-red-800 font-medium mb-2">Delete this connection?</p>
                    <p className="text-red-700 text-xs mb-3">
                      Jobs referencing this connection must be deleted or reassigned first (or deletion will be blocked).
                    </p>
                    {deleteError && (
                      <p className="text-red-600 text-xs mb-2 flex items-center gap-1">
                        <AlertCircle className="h-3.5 w-3.5" /> {deleteError}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleDeleteConfirm(conn.connectionId)}
                        disabled={deleteMutation.isPending}
                        className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
                      >
                        {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeleteConfirmId(null); setDeleteError(null); }}
                        className="px-3 py-1.5 text-xs border border-gray-300 rounded-lg hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <VendorSftpConnectionModal
        isOpen={modalOpen}
        connection={editingConnection}
        onClose={() => { setModalOpen(false); setEditingConnection(null); }}
      />
    </div>
  );
};

export default VendorSftpConnectionsManager;
