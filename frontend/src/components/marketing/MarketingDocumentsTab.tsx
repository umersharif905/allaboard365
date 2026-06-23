import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  EyeOff,
  FileText,
  FolderInput,
  FolderOpen,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X
} from 'lucide-react';
import React, { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  marketingLibraryKeys,
  useMarketingLibraryTree,
  useTenantAdminAgencyLibrary
} from '../../hooks/useMarketingLibrary';
import type { AgentResourceLibraryPayload } from '../../services/marketing-resources.service';
import {
  AgencyApiMode,
  MarketingFolderTree,
  MarketingResourceItem,
  MarketingResourcesService
} from '../../services/marketing-resources.service';
import { copyToClipboard } from '../../utils/clipboard';

interface MarketingDocumentsTabProps {
  /**
   * When provided AND user is TenantAdmin/SysAdmin, the tab manages this
   * agency's library (not the org library). Includes the
   * UseCustomResourceLibrary toggle and copy-from-org browser.
   */
  tenantAdminAgencyContext?: {
    agencyId: string;
    agencyName?: string;
  } | null;
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ open, onClose, title, children }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
      <div className="bg-white rounded-lg border border-gray-200 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-gray-200 flex justify-between items-center">
          <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
};

function sortedResources(resources: MarketingResourceItem[]) {
  return [...resources].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function sortedFolders(folders: MarketingFolderTree[]) {
  return [...folders].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
}

function parseAgentPayload(data: unknown): AgentResourceLibraryPayload | null {
  if (!data || typeof data !== 'object' || !('libraryMode' in data)) return null;
  return data as AgentResourceLibraryPayload;
}

const MarketingDocumentsTab: React.FC<MarketingDocumentsTabProps> = ({ tenantAdminAgencyContext = null }) => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const role = user?.currentRole || '';
  const isAdminRole = role === 'TenantAdmin' || role === 'SysAdmin';
  const isTenantAdmin = isAdminRole;
  const isAgent = role === 'Agent';
  const entityId = user?.currentTenantId || user?.tenantId || '';
  const tenantIdForKey = user?.currentTenantId ?? user?.tenantId ?? '';

  /** Tenant admin / sysadmin acting on a specific agency's library inside their tenant. */
  const tenantAdminAgencyId = isAdminRole && tenantAdminAgencyContext?.agencyId ? tenantAdminAgencyContext.agencyId : null;
  const tenantAdminAgencyName = tenantAdminAgencyContext?.agencyName || '';
  const isTenantAdminAgencyView = !!tenantAdminAgencyId;
  const agencyApiMode: AgencyApiMode = isTenantAdminAgencyView ? 'tenantAdmin' : 'agent';

  const [localError, setLocalError] = useState<string | null>(null);
  const [copiedResourceId, setCopiedResourceId] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<{ mode: 'create' | 'edit'; folder?: MarketingFolderTree } | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderDescription, setFolderDescription] = useState('');
  const [folderHideFromAgents, setFolderHideFromAgents] = useState(false);

  const [resourceModal, setResourceModal] = useState<{
    folderId: string;
    mode: 'add' | 'edit';
    resource?: MarketingResourceItem;
  } | null>(null);
  const [resTitle, setResTitle] = useState('');
  const [resDescription, setResDescription] = useState('');
  const [resUrl, setResUrl] = useState('');
  const [resKind, setResKind] = useState<'file' | 'link'>('link');
  const [resFile, setResFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const [moveModal, setMoveModal] = useState<{
    resource: MarketingResourceItem;
    sourceFolderId: string;
  } | null>(null);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');

  const [orgBrowseOpen, setOrgBrowseOpen] = useState(false);
  const [orgCatalog, setOrgCatalog] = useState<{ organizationName: string; folders: MarketingFolderTree[] } | null>(
    null
  );
  const [selectedOrgFolderIds, setSelectedOrgFolderIds] = useState<Record<string, boolean>>({});
  const [catalogLoading, setCatalogLoading] = useState(false);

  const invalidate = useCallback(() => {
    if (isTenantAdminAgencyView && tenantAdminAgencyId) {
      queryClient.invalidateQueries({
        queryKey: marketingLibraryKeys.tenantAdminAgencyTree(tenantIdForKey, tenantAdminAgencyId)
      });
    } else {
      queryClient.invalidateQueries({ queryKey: marketingLibraryKeys.tree(role, tenantIdForKey) });
    }
  }, [queryClient, role, tenantIdForKey, isTenantAdminAgencyView, tenantAdminAgencyId]);

  const orgLibraryQuery = useMarketingLibraryTree();
  const tenantAdminAgencyQuery = useTenantAdminAgencyLibrary(tenantAdminAgencyId);

  const activeQuery = isTenantAdminAgencyView ? tenantAdminAgencyQuery : orgLibraryQuery;
  const libraryPayload = activeQuery.data;
  const isLoading = activeQuery.isLoading;
  const queryError = activeQuery.error;
  const refetch = activeQuery.refetch;

  const folders = libraryPayload?.folders ?? [];
  const displayFolders = sortedFolders(folders);
  const loading = isLoading;

  const agentMeta = !isTenantAdminAgencyView ? parseAgentPayload(libraryPayload) : null;
  const libraryMode = agentMeta?.libraryMode;
  const organizationName = agentMeta?.organizationName ?? '';
  const agentAgencyId = agentMeta?.agencyId ?? null;
  const isAgencyAdminFlag = Boolean(agentMeta?.isAgencyAdmin);

  const tenantAdminAgencyMeta = isTenantAdminAgencyView
    ? (libraryPayload as { agencyId?: string; useCustomResourceLibrary?: boolean } | undefined)
    : undefined;

  const useCustomResourceLibrary = isTenantAdminAgencyView
    ? Boolean(tenantAdminAgencyMeta?.useCustomResourceLibrary)
    : Boolean(agentMeta?.useCustomResourceLibrary);

  const agencyId = isTenantAdminAgencyView ? tenantAdminAgencyId : agentAgencyId;

  const canManageAgencyLibrary = Boolean(
    (isAgent && libraryMode === 'agency' && isAgencyAdminFlag && agencyId) ||
      (isTenantAdminAgencyView && agencyId)
  );
  const canManage = (isTenantAdmin && !isTenantAdminAgencyView) || canManageAgencyLibrary;

  const uploadEntityId = canManageAgencyLibrary && agencyId ? agencyId : entityId;

  const createFolderMutation = useMutation({
    mutationFn: (payload: { name: string; description?: string; hideFromAgents?: boolean }) => {
      if (agencyId && canManageAgencyLibrary)
        return MarketingResourcesService.createAgencyFolder(agencyId, payload, agencyApiMode);
      if (isTenantAdmin) return MarketingResourcesService.createFolder(payload);
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => {
      setFolderModal(null);
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const updateFolderMutation = useMutation({
    mutationFn: (payload: {
      folderId: string;
      name: string;
      description?: string;
      hideFromAgents?: boolean;
    }) => {
      if (agencyId && canManageAgencyLibrary) {
        return MarketingResourcesService.updateAgencyFolder(
          agencyId,
          payload.folderId,
          {
            name: payload.name,
            description: payload.description,
            hideFromAgents: payload.hideFromAgents
          },
          agencyApiMode
        );
      }
      if (isTenantAdmin) {
        return MarketingResourcesService.updateFolder(payload.folderId, {
          name: payload.name,
          description: payload.description,
          hideFromAgents: payload.hideFromAgents
        });
      }
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => {
      setFolderModal(null);
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (folderId: string) => {
      if (agencyId && canManageAgencyLibrary)
        return MarketingResourcesService.deleteAgencyFolder(agencyId, folderId, agencyApiMode);
      if (isTenantAdmin) return MarketingResourcesService.deleteFolder(folderId);
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const reorderFoldersMutation = useMutation({
    mutationFn: (ids: string[]) => {
      if (agencyId && canManageAgencyLibrary)
        return MarketingResourcesService.reorderAgencyFolders(agencyId, ids, agencyApiMode);
      if (isTenantAdmin) return MarketingResourcesService.reorderFolders(ids);
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const reorderResourcesMutation = useMutation({
    mutationFn: (p: { folderId: string; orderedResourceIds: string[] }) => {
      if (agencyId && canManageAgencyLibrary)
        return MarketingResourcesService.reorderAgencyResources(
          agencyId,
          p.folderId,
          p.orderedResourceIds,
          agencyApiMode
        );
      if (isTenantAdmin)
        return MarketingResourcesService.reorderResources(p.folderId, p.orderedResourceIds);
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const deleteResourceMutation = useMutation({
    mutationFn: (resourceId: string) => {
      if (agencyId && canManageAgencyLibrary)
        return MarketingResourcesService.deleteAgencyResource(agencyId, resourceId, agencyApiMode);
      if (isTenantAdmin) return MarketingResourcesService.deleteResource(resourceId);
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const moveResourceToFolderMutation = useMutation({
    mutationFn: (p: { resourceId: string; folderId: string }) => {
      if (agencyId && canManageAgencyLibrary)
        return MarketingResourcesService.updateAgencyResource(
          agencyId,
          p.resourceId,
          { folderId: p.folderId },
          agencyApiMode
        );
      if (isTenantAdmin) return MarketingResourcesService.updateResource(p.resourceId, { folderId: p.folderId });
      return Promise.reject(new Error('Not allowed'));
    },
    onSuccess: () => {
      setMoveModal(null);
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const patchLibraryMutation = useMutation({
    mutationFn: async (next: boolean) => {
      if (!agencyId) throw new Error('Agency not available');
      await MarketingResourcesService.patchAgencyLibrarySettings(agencyId, next, agencyApiMode);
    },
    onSuccess: () => {
      invalidate();
      void refetch();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const copyFromOrgMutation = useMutation({
    mutationFn: (folderIds: string[]) => {
      if (!agencyId) return Promise.reject(new Error('Agency not available'));
      return MarketingResourcesService.copyOrganizationFoldersToAgency(agencyId, folderIds, agencyApiMode);
    },
    onSuccess: () => {
      setOrgBrowseOpen(false);
      setSelectedOrgFolderIds({});
      invalidate();
      void refetch();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const openOrgBrowse = async () => {
    if (!agencyId) return;
    setOrgBrowseOpen(true);
    setCatalogLoading(true);
    setSelectedOrgFolderIds({});
    setLocalError(null);
    try {
      const cat = await MarketingResourcesService.getOrganizationCatalog(agencyId, agencyApiMode);
      setOrgCatalog(cat);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Failed to load organization library');
    } finally {
      setCatalogLoading(false);
    }
  };

  const toggleOrgFolder = (id: string) => {
    setSelectedOrgFolderIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const submitCopyFromOrg = () => {
    const ids = Object.entries(selectedOrgFolderIds)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (!ids.length) {
      setLocalError('Select at least one folder to copy');
      return;
    }
    setLocalError(null);
    copyFromOrgMutation.mutate(ids);
  };

  const openCreateFolder = () => {
    setFolderName('');
    setFolderDescription('');
    setFolderHideFromAgents(false);
    setFolderModal({ mode: 'create' });
    setLocalError(null);
  };

  const openEditFolder = (f: MarketingFolderTree) => {
    setFolderName(f.name);
    setFolderDescription(f.description || '');
    setFolderHideFromAgents(Boolean(f.hideFromAgents));
    setFolderModal({ mode: 'edit', folder: f });
    setLocalError(null);
  };

  const submitFolder = () => {
    if (!folderName.trim()) {
      setLocalError('Folder name is required');
      return;
    }
    if (folderModal?.mode === 'create') {
      createFolderMutation.mutate({
        name: folderName.trim(),
        description: folderDescription.trim() || undefined,
        hideFromAgents: folderHideFromAgents
      });
    } else if (folderModal?.folder) {
      updateFolderMutation.mutate({
        folderId: folderModal.folder.folderId,
        name: folderName.trim(),
        description: folderDescription.trim() === '' ? undefined : folderDescription.trim(),
        hideFromAgents: folderHideFromAgents
      });
    }
  };

  const moveFolder = (index: number, dir: -1 | 1) => {
    const list = sortedFolders(displayFolders);
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[index], next[j]] = [next[j], next[index]];
    reorderFoldersMutation.mutate(next.map((f) => f.folderId));
  };

  const moveResource = (folderId: string, resources: MarketingResourceItem[], index: number, dir: -1 | 1) => {
    const list = sortedResources(resources);
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[index], next[j]] = [next[j], next[index]];
    reorderResourcesMutation.mutate({
      folderId,
      orderedResourceIds: next.map((r) => r.resourceId)
    });
  };

  const openAddResource = (folderId: string) => {
    setResourceModal({ folderId, mode: 'add' });
    setResTitle('');
    setResDescription('');
    setResUrl('');
    setResKind('link');
    setResFile(null);
    setLocalError(null);
  };

  const openEditResource = (folderId: string, r: MarketingResourceItem) => {
    setResourceModal({ folderId, mode: 'edit', resource: r });
    setResTitle(r.title);
    setResDescription(r.description || '');
    setResUrl('');
    setResKind(r.resourceType);
    setResFile(null);
    setLocalError(null);
  };

  const openMoveResource = (sourceFolderId: string, r: MarketingResourceItem) => {
    const dest = sortedFolders(displayFolders).find((f) => f.folderId !== sourceFolderId);
    setMoveTargetFolderId(dest?.folderId || '');
    setMoveModal({ resource: r, sourceFolderId });
    setLocalError(null);
  };

  const submitMoveResource = () => {
    if (!moveModal || !moveTargetFolderId) return;
    if (moveTargetFolderId === moveModal.sourceFolderId) {
      setLocalError('Choose a different folder');
      return;
    }
    setLocalError(null);
    moveResourceToFolderMutation.mutate({
      resourceId: moveModal.resource.resourceId,
      folderId: moveTargetFolderId
    });
  };

  const submitResource = async () => {
    if (!resourceModal) return;
    if (!resTitle.trim()) {
      setLocalError('Title is required');
      return;
    }
    setSaving(true);
    setLocalError(null);
    try {
      if (resourceModal.mode === 'edit' && resourceModal.resource) {
        if (agencyId && canManageAgencyLibrary) {
          await MarketingResourcesService.updateAgencyResource(
            agencyId,
            resourceModal.resource.resourceId,
            {
              title: resTitle.trim(),
              description: resDescription.trim() === '' ? null : resDescription.trim()
            },
            agencyApiMode
          );
        } else if (isTenantAdmin) {
          await MarketingResourcesService.updateResource(resourceModal.resource.resourceId, {
            title: resTitle.trim(),
            description: resDescription.trim() === '' ? null : resDescription.trim()
          });
        } else {
          throw new Error('Not allowed');
        }
        setResourceModal(null);
        invalidate();
        await refetch();
      } else {
        if (resKind === 'link') {
          if (!resUrl.trim()) {
            setLocalError('URL is required');
            setSaving(false);
            return;
          }
          const linkBody = {
            folderId: resourceModal.folderId,
            title: resTitle.trim(),
            description: resDescription.trim() || undefined,
            resourceType: 'link' as const,
            externalUrl: resUrl.trim()
          };
          if (agencyId && canManageAgencyLibrary) {
            await MarketingResourcesService.createAgencyResource(agencyId, linkBody, agencyApiMode);
          } else if (isTenantAdmin) {
            await MarketingResourcesService.createResource(linkBody);
          } else {
            throw new Error('Not allowed');
          }
        } else {
          if (!resFile) {
            setLocalError('Choose a file');
            setSaving(false);
            return;
          }
          const up = await MarketingResourcesService.uploadMarketingFile(resFile, uploadEntityId);
          const body = {
            folderId: resourceModal.folderId,
            title: resTitle.trim(),
            description: resDescription.trim() || undefined,
            resourceType: 'file' as const,
            fileId: up.fileId,
            fileName: up.fileName || resFile.name,
            storedFileName: up.filename,
            fileUrl: up.url,
            mimeType: up.mimeType || resFile.type,
            fileSize: up.fileSize ?? resFile.size
          };
          if (agencyId && canManageAgencyLibrary) {
            await MarketingResourcesService.createAgencyResource(agencyId, body, agencyApiMode);
          } else if (isTenantAdmin) {
            await MarketingResourcesService.createResource(body);
          } else {
            throw new Error('Not allowed');
          }
        }
        setResourceModal(null);
        invalidate();
        await refetch();
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyUrl = async (resourceId: string, text: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedResourceId(resourceId);
      setTimeout(() => setCopiedResourceId((id) => (id === resourceId ? null : id)), 1500);
    } else {
      setLocalError('Could not copy to clipboard');
    }
  };

  if (!isTenantAdmin && !isAgent) {
    return <p className="text-gray-600">Documents are available to agents and tenant administrators.</p>;
  }

  const showHideFromAgentsFolderOption = isTenantAdmin || canManageAgencyLibrary;

  return (
    <div className="space-y-4">
      {(queryError || localError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex justify-between items-center">
          <span>
            {localError ||
              (queryError instanceof Error ? queryError.message : String(queryError || 'Failed to load documents'))}
          </span>
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              void refetch();
            }}
            className="text-red-600 hover:text-red-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isAgent && agentMeta && !loading && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-950">
          {libraryMode === 'agency' ? (
            <>
              Showing your agency resource library
              {organizationName ? (
                <>
                  {' '}
                  (organization: <span className="font-medium">{organizationName}</span>)
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              Showing the{' '}
              <span className="font-medium">{organizationName || 'organization'}</span> resource library.
            </>
          )}
        </div>
      )}

      {((isAgent && isAgencyAdminFlag) || isTenantAdminAgencyView) && agencyId && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-4 space-y-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              checked={useCustomResourceLibrary}
              onChange={(e) => patchLibraryMutation.mutate(e.target.checked)}
              disabled={patchLibraryMutation.isPending}
            />
            <span className="text-sm text-gray-800">
              <span className="font-medium text-gray-900 block">Use agency-only resource library</span>
              <span className="text-gray-600 mt-0.5 block">
                {isTenantAdminAgencyView ? (
                  <>
                    When enabled, agents assigned to{' '}
                    <span className="font-medium">{tenantAdminAgencyName || 'this agency'}</span> see only the agency
                    library below (not the organization library). Agency library data is kept when toggled off.
                  </>
                ) : (
                  <>
                    When enabled, agents assigned to your agency see only your agency library below (not the{' '}
                    {organizationName ? (
                      <span className="font-medium">{organizationName}</span>
                    ) : (
                      <span className="font-medium">organization</span>
                    )}{' '}
                    library). Your agency library data is kept when you turn this off.
                  </>
                )}
              </span>
            </span>
          </label>
          {useCustomResourceLibrary && (
            <div>
              <button
                type="button"
                onClick={() => void openOrgBrowse()}
                className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm font-medium"
              >
                Browse{' '}
                <span className="font-semibold mx-1">
                  {isTenantAdminAgencyView ? 'tenant' : organizationName || 'organization'}
                </span>{' '}
                library — copy folders
              </button>
            </div>
          )}
        </div>
      )}

      {(isTenantAdmin || isAgent) && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
          >
            Refresh
          </button>
          {canManage && (
            <button
              type="button"
              onClick={openCreateFolder}
              className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium"
            >
              <Plus className="h-4 w-4 mr-2" />
              New folder
            </button>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-gray-600 py-8">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading library…
        </div>
      )}

      {!loading && displayFolders.length === 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-600">
          <FolderOpen className="h-10 w-10 mx-auto text-gray-400 mb-2" />
          <p>No document folders yet.</p>
          {isTenantAdmin && !isTenantAdminAgencyView && (
            <p className="text-sm mt-1">Create a folder, then add files or links.</p>
          )}
          {((libraryMode === 'agency' && canManageAgencyLibrary) || isTenantAdminAgencyView) && (
            <p className="text-sm mt-2 text-gray-600">
              {isTenantAdminAgencyView
                ? 'Copy folders from the tenant library or create a folder to get started.'
                : `Copy folders from the ${organizationName || 'organization'} library or create a folder to get started.`}
            </p>
          )}
        </div>
      )}

      {!loading &&
        displayFolders.map((folder, fi) => {
          const resources = sortedResources(folder.resources || []);
          const otherFolders = sortedFolders(displayFolders).filter((f) => f.folderId !== folder.folderId);
          return (
            <div key={folder.folderId} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center gap-2 justify-between bg-gray-50">
                <div className="flex items-center gap-2 min-w-0">
                  <FolderOpen className="h-5 w-5 text-blue-600 shrink-0" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <h3 className="text-lg font-medium text-gray-900 truncate">{folder.name}</h3>
                      {canManage && folder.hideFromAgents ? (
                        <span className="inline-flex items-center gap-1 shrink-0 px-2 py-0.5 text-xs font-semibold rounded-full bg-gray-200 text-gray-800">
                          <EyeOff className="h-3.5 w-3.5" aria-hidden />
                          Hidden from agents
                        </span>
                      ) : null}
                    </div>
                    {folder.description ? <p className="text-sm text-gray-600 truncate">{folder.description}</p> : null}
                  </div>
                </div>
                {canManage && (
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveFolder(fi, -1)}
                      disabled={fi === 0 || reorderFoldersMutation.isPending}
                      className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                      aria-label="Move folder up"
                    >
                      <ChevronUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveFolder(fi, 1)}
                      disabled={fi >= displayFolders.length - 1 || reorderFoldersMutation.isPending}
                      className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                      aria-label="Move folder down"
                    >
                      <ChevronDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openAddResource(folder.folderId)}
                      className="inline-flex items-center px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium"
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => openEditFolder(folder)}
                      className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100"
                      aria-label="Edit folder"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete folder "${folder.name}" and hide all items inside? This cannot be undone.`
                          )
                        ) {
                          deleteFolderMutation.mutate(folder.folderId);
                        }
                      }}
                      className="p-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                      aria-label="Delete folder"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
              <div className="p-4">
                {resources.length === 0 ? (
                  <p className="text-sm text-gray-500">No resources in this folder.</p>
                ) : (
                  <ul className="divide-y divide-gray-200">
                    {resources.map((r, ri) => (
                      <li
                        key={r.resourceId}
                        className="py-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-4"
                      >
                        <div className="flex items-start gap-2 min-w-0 w-full lg:flex-1">
                          {r.resourceType === 'link' ? (
                            <ExternalLink className="h-5 w-5 text-gray-500 shrink-0 mt-0.5" />
                          ) : (
                            <FileText className="h-5 w-5 text-gray-500 shrink-0 mt-0.5" />
                          )}
                          <div className="min-w-0 flex-1 overflow-hidden">
                            <p className="font-medium text-gray-900 break-words lg:truncate" title={r.title}>
                              {r.title}
                            </p>
                            {r.description ? (
                              <p className="text-sm text-gray-600 break-words mt-0.5">{r.description}</p>
                            ) : null}
                            {r.resourceType === 'file' && r.fileName ? (
                              <p
                                className="text-xs text-gray-500 mt-1 break-words line-clamp-2 lg:truncate lg:line-clamp-none"
                                title={r.fileName}
                              >
                                {r.fileName}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1 w-full lg:w-auto lg:shrink-0 lg:justify-end">
                          {r.resourceType === 'link' && r.externalUrl && (
                            <>
                              <a
                                href={r.externalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium"
                              >
                                Open
                              </a>
                              <button
                                type="button"
                                onClick={() => void handleCopyUrl(r.resourceId, r.externalUrl!)}
                                className={`inline-flex items-center px-3 py-2 rounded-lg border text-sm font-medium ${
                                  copiedResourceId === r.resourceId
                                    ? 'border-green-200 bg-green-50 text-green-800'
                                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                {copiedResourceId === r.resourceId ? (
                                  <>
                                    <Check className="h-4 w-4 mr-1" />
                                    Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-4 w-4 mr-1" />
                                    Copy
                                  </>
                                )}
                              </button>
                            </>
                          )}
                          {r.resourceType === 'file' && r.fileUrl && (
                            <>
                              <a
                                href={r.fileUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium"
                              >
                                Open
                              </a>
                              <button
                                type="button"
                                onClick={() => void handleCopyUrl(r.resourceId, r.fileUrl!)}
                                className={`inline-flex items-center px-3 py-2 rounded-lg border text-sm font-medium ${
                                  copiedResourceId === r.resourceId
                                    ? 'border-green-200 bg-green-50 text-green-800'
                                    : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                                }`}
                              >
                                {copiedResourceId === r.resourceId ? (
                                  <>
                                    <Check className="h-4 w-4 mr-1" />
                                    Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-4 w-4 mr-1" />
                                    Copy
                                  </>
                                )}
                              </button>
                            </>
                          )}
                          {canManage && (
                            <>
                              <button
                                type="button"
                                onClick={() => moveResource(folder.folderId, resources, ri, -1)}
                                disabled={ri === 0 || reorderResourcesMutation.isPending}
                                className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                                aria-label="Move resource up"
                              >
                                <ChevronUp className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveResource(folder.folderId, resources, ri, 1)}
                                disabled={ri >= resources.length - 1 || reorderResourcesMutation.isPending}
                                className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                                aria-label="Move resource down"
                              >
                                <ChevronDown className="h-4 w-4" />
                              </button>
                              {otherFolders.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => openMoveResource(folder.folderId, r)}
                                  disabled={moveResourceToFolderMutation.isPending}
                                  className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                                  aria-label="Move resource to another folder"
                                >
                                  <FolderInput className="h-4 w-4" />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => openEditResource(folder.folderId, r)}
                                className="p-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-100"
                                aria-label="Edit resource"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  if (window.confirm(`Remove "${r.title}" from the library?`)) {
                                    deleteResourceMutation.mutate(r.resourceId);
                                  }
                                }}
                                className="p-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                                aria-label="Delete resource"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}

      <Modal
        open={!!folderModal}
        onClose={() => setFolderModal(null)}
        title={folderModal?.mode === 'create' ? 'New folder' : 'Edit folder'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="folder-name">
              Name
            </label>
            <input
              id="folder-name"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="folder-desc">
              Description (optional)
            </label>
            <textarea
              id="folder-desc"
              rows={3}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              value={folderDescription}
              onChange={(e) => setFolderDescription(e.target.value)}
            />
          </div>
          {showHideFromAgentsFolderOption && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3">
              <label className="flex items-start gap-2 cursor-pointer text-sm text-gray-800">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  checked={folderHideFromAgents}
                  onChange={(e) => setFolderHideFromAgents(e.target.checked)}
                />
                <span>
                  <span className="font-medium text-gray-900">Hide from agents</span>
                  <span className="block text-gray-600 mt-0.5">
                    {isTenantAdmin ? (
                      <>
                        When checked, this folder does not appear in the agent Resource Library (tenant admins still see
                        it here).
                      </>
                    ) : (
                      <>
                        When checked, other agents in your agency do not see this folder in the Resource Library (you
                        still see it here).
                      </>
                    )}
                  </span>
                </span>
              </label>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setFolderModal(null)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitFolder}
              disabled={createFolderMutation.isPending || updateFolderMutation.isPending}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!moveModal}
        onClose={() => setMoveModal(null)}
        title="Move to folder"
      >
        <div className="space-y-4">
          {moveModal ? (
            <p className="text-sm text-gray-600">
              Move <span className="font-medium text-gray-900">&quot;{moveModal.resource.title}&quot;</span> into
              another folder.
            </p>
          ) : null}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="move-folder-select">
              Destination folder
            </label>
            <select
              id="move-folder-select"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              value={moveTargetFolderId}
              onChange={(e) => setMoveTargetFolderId(e.target.value)}
            >
              {moveModal &&
                sortedFolders(displayFolders)
                  .filter((f) => f.folderId !== moveModal.sourceFolderId)
                  .map((f) => (
                    <option key={f.folderId} value={f.folderId}>
                      {f.name}
                    </option>
                  ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setMoveModal(null)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitMoveResource}
              disabled={!moveTargetFolderId || moveResourceToFolderMutation.isPending}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {moveResourceToFolderMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Move
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!resourceModal}
        onClose={() => setResourceModal(null)}
        title={resourceModal?.mode === 'edit' ? 'Edit resource' : 'Add resource'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="res-title">
              Title
            </label>
            <input
              id="res-title"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              value={resTitle}
              onChange={(e) => setResTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="res-desc">
              Description (optional)
            </label>
            <textarea
              id="res-desc"
              rows={2}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
              value={resDescription}
              onChange={(e) => setResDescription(e.target.value)}
            />
          </div>
          {resourceModal?.mode === 'add' && (
            <>
              <div>
                <span className="block text-sm font-medium text-gray-700 mb-2">Type</span>
                <div className="flex gap-4">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="radio"
                      name="resKind"
                      checked={resKind === 'link'}
                      onChange={() => setResKind('link')}
                    />
                    External link
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="radio"
                      name="resKind"
                      checked={resKind === 'file'}
                      onChange={() => setResKind('file')}
                    />
                    File upload
                  </label>
                </div>
              </div>
              {resKind === 'link' ? (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="res-url">
                    URL
                  </label>
                  <input
                    id="res-url"
                    type="url"
                    placeholder="https://"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    value={resUrl}
                    onChange={(e) => setResUrl(e.target.value)}
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="res-file">
                    File
                  </label>
                  <input
                    id="res-file"
                    type="file"
                    className="w-full text-sm text-gray-600"
                    onChange={(e) => setResFile(e.target.files?.[0] || null)}
                  />
                </div>
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setResourceModal(null)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submitResource()}
              disabled={saving}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={orgBrowseOpen}
        onClose={() => setOrgBrowseOpen(false)}
        title={`${orgCatalog?.organizationName ?? organizationName ?? 'Organization'} library (read-only)`}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            Select folders to copy into your agency library. Existing files are duplicated so removing them here does not
            affect the original library.
          </p>
          {catalogLoading ? (
            <div className="flex items-center gap-2 text-gray-600 py-6">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading…
            </div>
          ) : (
            <ul className="space-y-2 max-h-[50vh] overflow-y-auto border border-gray-100 rounded-lg p-3">
              {(orgCatalog?.folders ?? []).map((f) => (
                <li key={f.folderId}>
                  <label className="flex items-start gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600"
                      checked={Boolean(selectedOrgFolderIds[f.folderId])}
                      onChange={() => toggleOrgFolder(f.folderId)}
                    />
                    <span className="font-medium text-gray-900">{f.name}</span>
                  </label>
                </li>
              ))}
              {!catalogLoading && orgCatalog && orgCatalog.folders.length === 0 ? (
                <li className="text-sm text-gray-500">No folders in the organization library.</li>
              ) : null}
            </ul>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setOrgBrowseOpen(false)}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submitCopyFromOrg()}
              disabled={
                catalogLoading ||
                copyFromOrgMutation.isPending ||
                !Object.values(selectedOrgFolderIds).some(Boolean)
              }
              className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
              {copyFromOrgMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Copy selected
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default MarketingDocumentsTab;
