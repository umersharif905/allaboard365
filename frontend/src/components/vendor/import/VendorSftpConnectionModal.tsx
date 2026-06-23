import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X, XCircle } from 'lucide-react';
import {
  useCreateSftpConnection,
  useUpdateSftpConnection,
  useTestSftpConnection,
} from '../../../hooks/vendor/useVendorSftpConnections';
import type {
  SftpConnection,
  SftpConnectionFormValues,
  SftpTestConnectionParams,
  SftpTestResult,
} from '../../../types/vendor/vendorSftpImport.types';

interface Props {
  isOpen: boolean;
  connection: SftpConnection | null;
  onClose: () => void;
}

const DEFAULT_PORT = 22;

const VendorSftpConnectionModal: React.FC<Props> = ({ isOpen, connection, onClose }) => {
  const isEdit = !!connection;
  const createMutation = useCreateSftpConnection();
  const updateMutation = useUpdateSftpConnection();
  const testMutation = useTestSftpConnection();

  const [displayName, setDisplayName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState<number>(DEFAULT_PORT);
  const [username, setUsername] = useState('');
  const [authType, setAuthType] = useState<SftpConnectionFormValues['authType']>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [baseDirectory, setBaseDirectory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<SftpTestResult | null>(null);

  // Reset form when connection changes
  useEffect(() => {
    if (connection) {
      setDisplayName(connection.displayName);
      setHost(connection.host);
      setPort(connection.port);
      setUsername(connection.username);
      setAuthType(connection.authType);
      setPassword('');
      setPrivateKey('');
      setPassphrase('');
      setBaseDirectory(connection.baseDirectory ?? '');
    } else {
      setDisplayName('');
      setHost('');
      setPort(DEFAULT_PORT);
      setUsername('');
      setAuthType('password');
      setPassword('');
      setPrivateKey('');
      setPassphrase('');
      setBaseDirectory('');
    }
    setError(null);
    setTestResult(null);
  }, [connection, isOpen]);

  if (!isOpen) return null;

  const hasCredForTest =
    authType === 'password'
      ? Boolean(password) || Boolean(isEdit && connection?.hasPassword)
      : Boolean(privateKey) || Boolean(isEdit && connection?.hasPrivateKey);

  const canTest = host.trim().length > 0 && username.trim().length > 0 && hasCredForTest;

  const buildTestPayload = (): SftpTestConnectionParams => {
    const payload: SftpTestConnectionParams = {
      host: host.trim(),
      port,
      username: username.trim(),
      authType,
    };
    if (authType === 'password' && password) payload.password = password;
    if (authType === 'privateKey' && privateKey) payload.privateKey = privateKey;
    if (authType === 'privateKey' && passphrase) payload.passphrase = passphrase;
    if (isEdit && connection) payload.connectionId = connection.connectionId;
    return payload;
  };

  const handleTest = async () => {
    setTestResult(null);
    try {
      const result = await testMutation.mutateAsync(buildTestPayload());
      setTestResult(result);
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : 'Test failed' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setTestResult(null);

    try {
      if (isEdit && connection) {
        const body: Partial<SftpConnectionFormValues> = {
          displayName: displayName.trim(),
          host: host.trim(),
          port,
          username: username.trim(),
          authType,
          baseDirectory: baseDirectory.trim() || undefined,
        };
        // Only include credentials if the user entered something — blank retains existing
        if (authType === 'password' && password) body.password = password;
        if (authType === 'privateKey' && privateKey) body.privateKey = privateKey;
        if (authType === 'privateKey' && passphrase) body.passphrase = passphrase;
        await updateMutation.mutateAsync({ connectionId: connection.connectionId, body });
      } else {
        const body: SftpConnectionFormValues = {
          displayName: displayName.trim(),
          host: host.trim(),
          port,
          username: username.trim(),
          authType,
          baseDirectory: baseDirectory.trim() || undefined,
        };
        if (authType === 'password') body.password = password;
        else body.privateKey = privateKey;
        if (authType === 'privateKey' && passphrase) body.passphrase = passphrase;
        await createMutation.mutateAsync(body);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  };

  const isBusy = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">
            {isEdit ? 'Edit SFTP Connection' : 'New SFTP Connection'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4">
          {/* Display name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display name</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. ShareWELL Production SFTP"
              required
            />
          </div>

          {/* Host + Port */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">Host</label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="sftp.example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Port</label>
              <input
                type="number"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={port}
                onChange={(e) => setPort(Number(e.target.value) || DEFAULT_PORT)}
                min={1}
                max={65535}
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Username</label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="sftpuser"
              required
              autoComplete="off"
            />
          </div>

          {/* Auth type */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Authentication</label>
            <div className="flex gap-3">
              {(['password', 'privateKey'] as const).map((t) => (
                <label key={t} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="authType"
                    checked={authType === t}
                    onChange={() => setAuthType(t)}
                    className="accent-oe-primary"
                  />
                  {t === 'password' ? 'Password' : 'Private key'}
                </label>
              ))}
            </div>
          </div>

          {/* Password credential */}
          {authType === 'password' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
              <input
                type="password"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isEdit && connection?.hasPassword ? '••••••••  (blank retains existing)' : 'Enter password'}
                autoComplete="new-password"
              />
            </div>
          )}

          {/* Private key credential */}
          {authType === 'privateKey' && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Private key (PEM)</label>
                <textarea
                  className="w-full font-mono text-xs border border-gray-300 rounded-lg px-3 py-2 min-h-[100px] resize-y"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder={
                    isEdit && connection?.hasPrivateKey
                      ? '••••••••  (blank retains existing key)'
                      : '-----BEGIN OPENSSH PRIVATE KEY-----\n...'
                  }
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Passphrase <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input
                  type="password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={
                    isEdit && connection?.hasPassphrase
                      ? '••••••••  (blank retains existing)'
                      : 'Optional key passphrase'
                  }
                  autoComplete="new-password"
                />
              </div>
            </>
          )}

          {/* Base directory */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Base directory <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={baseDirectory}
              onChange={(e) => setBaseDirectory(e.target.value)}
              placeholder="e.g. /uploads"
            />
          </div>

          {/* Test connection (uses current form values; edit merges blank secrets with saved) */}
          <div className="pt-2">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testMutation.isPending || !canTest}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {testMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {testMutation.isPending ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <span className={`ml-3 inline-flex items-center gap-1 text-sm ${testResult.success ? 'text-green-700' : 'text-red-600'}`}>
                {testResult.success ? (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Connected
                    {testResult.latencyMs !== undefined ? ` (${testResult.latencyMs}ms)` : ''}
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4" />
                    {testResult.error ?? 'Failed'}
                  </>
                )}
              </span>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isBusy}
              className="px-4 py-2 text-sm bg-oe-primary hover:bg-oe-dark text-white rounded-lg disabled:opacity-50 flex items-center gap-1.5"
            >
              {isBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              {isBusy ? 'Saving…' : isEdit ? 'Save changes' : 'Create connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default VendorSftpConnectionModal;
