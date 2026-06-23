import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import type { MarketingFolderTree, MarketingResourceItem } from '../../services/marketing-resources.service';
import { VendorResourceLibraryService } from '../../services/vendor-resource-library.service';
import { copyToClipboard } from '../../utils/clipboard';

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

const TREE_KEY = ['vendor-resource-library', 'tree'] as const;
const TENANTS_KEY = ['vendor-resource-library', 'tenants'] as const;

const VendorResourceLibraryPage: React.FC = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const role = user?.currentRole || '';
  const isAdmin = role === 'VendorAdmin';
  const canEdit = role === 'VendorAdmin' || role === 'VendorAgent';
  const canDelete = isAdmin;
  const canCopyFromOrg = isAdmin;
  const uploadEntityId = user?.currentTenantId || user?.tenantId || '';

  const treeQuery = useQuery({
    queryKey: TREE_KEY,
    queryFn: () => VendorResourceLibraryService.getTree(),
    enabled: canEdit
  });

  const folders = treeQuery.data ?? [];
  const displayFolders = sortedFolders(folders);

  const [localError, setLocalError] = useState<string | null>(null);
  const [copiedResourceId, setCopiedResourceId] = useState<string | null>(null);
  const [folderModal, setFolderModal] = useState<{ mode: 'create' | 'edit'; folder?: MarketingFolderTree } | null>(null);
  const [folderName, setFolderName] = useState('');
  const [folderDescription, setFolderDescription] = useState('');

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

  const [moveModal, setMoveModal] = useState<{ resource: MarketingResourceItem; sourceFolderId: string } | null>(null);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState('');

  const [orgBrowseOpen, setOrgBrowseOpen] = useState(false);
  const [selectedOrgFolderIds, setSelectedOrgFolderIds] = useState<Record<string, boolean>>({});
  const [sourceTenantId, setSourceTenantId] = useState<string>('');

  const tenantsQuery = useQuery({
    queryKey: TENANTS_KEY,
    queryFn: () => VendorResourceLibraryService.listTenants(),
    enabled: orgBrowseOpen && canCopyFromOrg
  });

  const orgCatalogQuery = useQuery({
    queryKey: ['vendor-resource-library', 'org-catalog', sourceTenantId],
    queryFn: () => VendorResourceLibraryService.getOrganizationCatalog(sourceTenantId || undefined),
    enabled: orgBrowseOpen && canCopyFromOrg && !!sourceTenantId
  });

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: TREE_KEY });
  }, [queryClient]);

  const createFolderMutation = useMutation({
    mutationFn: (payload: { name: string; description?: string }) =>
      VendorResourceLibraryService.createFolder(payload),
    onSuccess: () => {
      setFolderModal(null);
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const updateFolderMutation = useMutation({
    mutationFn: (payload: { folderId: string; name: string; description?: string | null }) =>
      VendorResourceLibraryService.updateFolder(payload.folderId, {
        name: payload.name,
        description: payload.description
      }),
    onSuccess: () => {
      setFolderModal(null);
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const deleteFolderMutation = useMutation({
    mutationFn: (folderId: string) => VendorResourceLibraryService.deleteFolder(folderId),
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const reorderFoldersMutation = useMutation({
    mutationFn: (ids: string[]) => VendorResourceLibraryService.reorderFolders(ids),
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const reorderResourcesMutation = useMutation({
    mutationFn: (p: { folderId: string; orderedResourceIds: string[] }) =>
      VendorResourceLibraryService.reorderResources(p.folderId, p.orderedResourceIds),
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const deleteResourceMutation = useMutation({
    mutationFn: (resourceId: string) => VendorResourceLibraryService.deleteResource(resourceId),
    onSuccess: () => invalidate(),
    onError: (e: Error) => setLocalError(e.message)
  });

  const moveResourceToFolderMutation = useMutation({
    mutationFn: (p: { resourceId: string; folderId: string }) =>
      VendorResourceLibraryService.updateResource(p.resourceId, { folderId: p.folderId }),
    onSuccess: () => {
      setMoveModal(null);
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const copyFromOrgMutation = useMutation({
    mutationFn: (folderIds: string[]) =>
      VendorResourceLibraryService.copyFoldersFromOrganization(folderIds, sourceTenantId || undefined),
    onSuccess: () => {
      setOrgBrowseOpen(false);
      setSelectedOrgFolderIds({});
      invalidate();
    },
    onError: (e: Error) => setLocalError(e.message)
  });

  const openOrgBrowse = () => {
    setSelectedOrgFolderIds({});
    setSourceTenantId(user?.currentTenantId || user?.tenantId || '');
    setLocalError(null);
    setOrgBrowseOpen(true);
  };

  const toggleOrgFolder = (id: string) => {
    setSelectedOrgFolderIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const submitCopyFromOrg = () => {
    const ids = Object.entries(selectedOrgFolderIds).filter(([, v]) => v).map(([k]) => k);
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
    setFolderModal({ mode: 'create' });
    setLocalError(null);
  };

  const openEditFolder = (f: MarketingFolderTree) => {
    setFolderName(f.name);
    setFolderDescription(f.description || '');
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
        description: folderDescription.trim() || undefined
      });
    } else if (folderModal?.folder) {
      updateFolderMutation.mutate({
        folderId: folderModal.folder.folderId,
        name: folderName.trim(),
        description: folderDescription.trim() === '' ? undefined : folderDescription.trim()
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
        await VendorResourceLibraryService.updateResource(resourceModal.resource.resourceId, {
          title: resTitle.trim(),
          description: resDescription.trim() === '' ? null : resDescription.trim()
        });
      } else if (resKind === 'link') {
        if (!resUrl.trim()) {
          setLocalError('URL is required');
          setSaving(false);
          return;
        }
        await VendorResourceLibraryService.createResource({
          folderId: resourceModal.folderId,
          title: resTitle.trim(),
          description: resDescription.trim() || undefined,
          resourceType: 'link',
          externalUrl: resUrl.trim()
        });
      } else {
        if (!resFile) {
          setLocalError('Choose a file');
          setSaving(false);
          return;
        }
        const up = await VendorResourceLibraryService.uploadFile(resFile, uploadEntityId);
        await VendorResourceLibraryService.createResource({
          folderId: resourceModal.folderId,
          title: resTitle.trim(),
          description: resDescription.trim() || undefined,
          resourceType: 'file',
          fileId: up.fileId,
          fileName: up.fileName || resFile.name,
          storedFileName: up.filename,
          fileUrl: up.url,
          mimeType: up.mimeType || resFile.type,
          fileSize: up.fileSize ?? resFile.size
        });
      }
      setResourceModal(null);
      invalidate();
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

  if (!canEdit) {
    return <p className="text-gray-600 p-6">The Resource Library is only available to vendor portal users.</p>;
  }

  const queryError = treeQuery.error;
  const loading = treeQuery.isLoading;

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Resource Library</h1>
          <p className="text-sm text-gray-600 mt-1">
            Documents and resources for your vendor team.
            {!canDelete ? ' Folders and files can be added or reorganized; deletion is reserved for admins.' : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void treeQuery.refetch()}
            className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 text-sm font-medium"
          >
            Refresh
          </button>
          {canCopyFromOrg && (
            <button
              type="button"
              onClick={openOrgBrowse}
              className="inline-flex items-center px-4 py-2 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 text-sm font-medium"
            >
              Copy from tenant
            </button>
          )}
          <button
            type="button"
            onClick={openCreateFolder}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark text-sm font-medium"
          >
            <Plus className="h-4 w-4 mr-2" />
            New folder
          </button>
        </div>
      </div>

      {(queryError || localError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex justify-between items-center">
          <span>
            {localError || (queryError instanceof Error ? queryError.message : String(queryError || 'Failed to load library'))}
          </span>
          <button
            type="button"
            onClick={() => {
              setLocalError(null);
              void treeQuery.refetch();
            }}
            className="text-red-600 hover:text-red-800"
          >
            <X className="h-4 w-4" />
          </button>
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
          <p>No folders yet.</p>
          <p className="text-sm mt-2 text-gray-600">
            {canCopyFromOrg
              ? 'Copy folders from a tenant library or create a folder to get started.'
              : 'Create a folder to get started.'}
          </p>
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
                  <FolderOpen className="h-5 w-5 text-oe-primary shrink-0" />
                  <div className="min-w-0">
                    <h3 className="text-lg font-medium text-gray-900 truncate">{folder.name}</h3>
                    {folder.description ? <p className="text-sm text-gray-600 truncate">{folder.description}</p> : null}
                  </div>
                </div>
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
                    className="inline-flex items-center px-3 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark text-sm font-medium"
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
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete folder "${folder.name}" and hide all items inside? This cannot be undone.`)) {
                          deleteFolderMutation.mutate(folder.folderId);
                        }
                      }}
                      className="p-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                      aria-label="Delete folder"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
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
                            {r.description ? <p className="text-sm text-gray-600 break-words mt-0.5">{r.description}</p> : null}
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
                                className="inline-flex items-center px-3 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark text-sm font-medium"
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
                                className="inline-flex items-center px-3 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark text-sm font-medium"
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
                          {canDelete && (
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              value={folderDescription}
              onChange={(e) => setFolderDescription(e.target.value)}
            />
          </div>
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
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!moveModal} onClose={() => setMoveModal(null)} title="Move to folder">
        <div className="space-y-4">
          {moveModal ? (
            <p className="text-sm text-gray-600">
              Move <span className="font-medium text-gray-900">&quot;{moveModal.resource.title}&quot;</span> into another folder.
            </p>
          ) : null}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="move-folder-select">
              Destination folder
            </label>
            <select
              id="move-folder-select"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
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
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-2"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
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
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
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
                    <input type="radio" name="resKind" checked={resKind === 'link'} onChange={() => setResKind('link')} />
                    External link
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                    <input type="radio" name="resKind" checked={resKind === 'file'} onChange={() => setResKind('file')} />
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
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
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
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-2"
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
        title="Copy from tenant library"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="source-tenant-select">
              Source tenant
            </label>
            <select
              id="source-tenant-select"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              value={sourceTenantId}
              onChange={(e) => {
                setSourceTenantId(e.target.value);
                setSelectedOrgFolderIds({});
              }}
              disabled={tenantsQuery.isLoading}
            >
              {tenantsQuery.isLoading ? (
                <option value="">Loading tenants…</option>
              ) : (
                <>
                  {!sourceTenantId && <option value="">Select a tenant…</option>}
                  {(tenantsQuery.data ?? []).map((t) => (
                    <option key={t.tenantId} value={t.tenantId}>
                      {t.name}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>
          <p className="text-sm text-gray-600">
            Select folders to copy into your vendor library. Files are duplicated, so removing them here won&apos;t affect
            the original library.
          </p>
          {!sourceTenantId ? (
            <p className="text-sm text-gray-500 py-2">Pick a source tenant above to browse its library.</p>
          ) : orgCatalogQuery.isLoading ? (
            <div className="flex items-center gap-2 text-gray-600 py-6">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading…
            </div>
          ) : (
            <ul className="space-y-2 max-h-[50vh] overflow-y-auto border border-gray-100 rounded-lg p-3">
              {(orgCatalogQuery.data?.folders ?? []).map((f) => (
                <li key={f.folderId}>
                  <label className="flex items-start gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-oe-primary"
                      checked={Boolean(selectedOrgFolderIds[f.folderId])}
                      onChange={() => toggleOrgFolder(f.folderId)}
                    />
                    <span className="font-medium text-gray-900">{f.name}</span>
                  </label>
                </li>
              ))}
              {!orgCatalogQuery.isLoading && orgCatalogQuery.data && orgCatalogQuery.data.folders.length === 0 ? (
                <li className="text-sm text-gray-500">No folders in this tenant&apos;s library.</li>
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
                !sourceTenantId ||
                orgCatalogQuery.isLoading ||
                copyFromOrgMutation.isPending ||
                !Object.values(selectedOrgFolderIds).some(Boolean)
              }
              className="px-4 py-2 rounded-lg bg-oe-primary text-white hover:bg-oe-dark disabled:opacity-50 inline-flex items-center gap-2"
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

export default VendorResourceLibraryPage;
