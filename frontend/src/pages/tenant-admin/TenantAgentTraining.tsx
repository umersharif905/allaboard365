import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { ArrowLeft, Eye, Loader2 } from 'lucide-react';

import { useAuth } from '../../contexts/AuthContext';
import ModuleEditorPanel from '../../components/tenant-admin/training/ModuleEditorPanel';
import TrainingModuleLibraryRawJsonEditor from '../../components/tenant-admin/training/TrainingModuleLibraryRawJsonEditor';
import ModuleLibraryPanel, {
  type ModuleLibraryArchiveFilter
} from '../../components/tenant-admin/training/ModuleLibraryPanel';
import PackageBuilderPanel from '../../components/tenant-admin/training/PackageBuilderPanel';
import PackageListPanel from '../../components/tenant-admin/training/PackageListPanel';
import TrainingEditorPlayerSplitPane from '../../components/tenant-admin/training/player/TrainingEditorPlayerSplitPane';
import TrainingPlayer2Panel from '../../components/tenant-admin/training/player/TrainingPlayer2/TrainingPlayer2Panel';
import { INITIAL_MODULE_LIBRARY, INITIAL_PACKAGES, createTrainingId } from '../../components/tenant-admin/training/trainingMockData';
import {
  parseModulePasteToTrainingModule,
  type ParseTrainingModuleJsonResult
} from '../../components/tenant-admin/training/trainingModuleImport';
import { logAdminSaveRecordedToConsole, writeAdminSaveClientMeta } from '../../components/tenant-admin/training/trainingPlayerDiagnostics';
import { apiService } from '../../services/api.service';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import type {
  AgentLibraryProgress,
  PackageModuleAssignment,
  ResolvedPackageModule,
  TrainingModule,
  TrainingPackage,
  TrainingPackageCertificate,
  TrainingPackageStatus
} from '../../components/tenant-admin/training/trainingTypes';

type CertificateGalleryItem = {
  packageId: string;
  packageTitle: string;
  certificate: TrainingPackageCertificate;
  earned: boolean;
  awardedAt?: string | null;
};

type AssignmentTenant = {
  TenantId: string;
  Name: string;
  Status: string;
};

const DEFAULT_CERTIFICATE_IMAGE_URL =
  'https://res.cloudinary.com/doi8qjcv6/image/upload/v1775672930/customers/mightywell/columbusmedal2_1_sby1ye.webp';

const normalizePackageCertificate = (
  packageRecord: Pick<TrainingPackage, 'title'> & { certificate?: Partial<TrainingPackageCertificate> }
): TrainingPackageCertificate => {
  const packageTitle = packageRecord.title || 'Training Package';
  const certificate = packageRecord.certificate || {};
  return {
    packageName: certificate.packageName || packageTitle,
    certificateName: certificate.certificateName || `${packageTitle} Certificate`,
    certificateDetails:
      certificate.certificateDetails ||
      'Awarded for achieving a cumulative quiz score of 70% or higher for this package.',
    certificateImageUrl: certificate.certificateImageUrl || DEFAULT_CERTIFICATE_IMAGE_URL
  };
};

const normalizePackage = (packageRecord: TrainingPackage): TrainingPackage => {
  const trimmedCard = packageRecord.packageImageUrl?.trim();
  const { packageImageUrl: _omitCard, ...rest } = packageRecord;
  return {
    ...rest,
    ...(trimmedCard ? { packageImageUrl: trimmedCard } : {}),
    certificate: normalizePackageCertificate(packageRecord)
  };
};

function stripModuleFromAllPackages(packageList: TrainingPackage[], moduleId: string): TrainingPackage[] {
  const target = String(moduleId);
  return packageList.map(pkg => {
    const filtered = pkg.moduleAssignments.filter(a => String(a.moduleId) !== target);
    if (filtered.length === pkg.moduleAssignments.length) {
      return pkg;
    }
    const reordered = [...filtered]
      .sort((a, b) => a.order - b.order)
      .map((assignment, index) => ({
        ...assignment,
        order: index + 1
      }));
    return { ...pkg, moduleAssignments: reordered };
  });
}

const TenantAgentTraining: React.FC = () => {
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const isSysAdmin = user?.currentRole === 'SysAdmin';
  const [fullOrgLibrary, setFullOrgLibrary] = useState(false);
  const [packages, setPackages] = useState<TrainingPackage[]>([]);
  const [moduleLibrary, setModuleLibrary] = useState<TrainingModule[]>([]);
  const [selectedPackageId, setSelectedPackageId] = useState<string>(INITIAL_PACKAGES[0]?.id || '');
  const [packageSearch, setPackageSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'All' | TrainingPackageStatus>('All');
  const [moduleSearch, setModuleSearch] = useState('');
  const [activeModuleId, setActiveModuleId] = useState<string>(INITIAL_MODULE_LIBRARY[0]?.id || '');
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [savingLibrary, setSavingLibrary] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string>('');
  const [packageAssignmentCounts, setPackageAssignmentCounts] = useState<Record<string, number>>({});
  const [isAssignModalOpen, setIsAssignModalOpen] = useState(false);
  const [assignmentSearch, setAssignmentSearch] = useState('');
  const [assignmentPackageId, setAssignmentPackageId] = useState('');
  const [assignmentPackageTitle, setAssignmentPackageTitle] = useState('');
  const [assignmentTenants, setAssignmentTenants] = useState<AssignmentTenant[]>([]);
  const [selectedAssignmentTenantIds, setSelectedAssignmentTenantIds] = useState<string[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [savingAssignments, setSavingAssignments] = useState(false);
  const [isNewModuleModalOpen, setIsNewModuleModalOpen] = useState(false);
  const [importModuleJsonText, setImportModuleJsonText] = useState('');
  const [importPasteValidation, setImportPasteValidation] = useState<ParseTrainingModuleJsonResult | null>(
    null
  );
  const [addImportedModuleToPackage, setAddImportedModuleToPackage] = useState(true);
  const [agentPortalTrainingEnabled, setAgentPortalTrainingEnabled] = useState(true);
  const [portalToggleLoading, setPortalToggleLoading] = useState(true);
  const [portalToggleSaving, setPortalToggleSaving] = useState(false);
  const [archiveDialogModuleId, setArchiveDialogModuleId] = useState<string | null>(null);
  const [archiveModuleSubmitting, setArchiveModuleSubmitting] = useState(false);
  const [showArchivedModules, setShowArchivedModules] = useState(false);
  const [moduleArchiveFilter, setModuleArchiveFilter] = useState<ModuleLibraryArchiveFilter>('all');
  const [permanentDeleteDialogModuleId, setPermanentDeleteDialogModuleId] = useState<string | null>(null);
  const [permanentDeleteSubmitting, setPermanentDeleteSubmitting] = useState(false);

  const [isAgentPreviewOpen, setIsAgentPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPackages, setPreviewPackages] = useState<TrainingPackage[]>([]);
  const [previewModuleLibrary, setPreviewModuleLibrary] = useState<TrainingModule[]>([]);
  const [previewCertificateGallery, setPreviewCertificateGallery] = useState<CertificateGalleryItem[]>([]);
  const [previewAgentProgress, setPreviewAgentProgress] = useState<AgentLibraryProgress | null>(null);
  const [previewHasAgentProfile, setPreviewHasAgentProfile] = useState(false);

  const draftPreviewPayload = useMemo(() => {
    const pkgs = packages.filter(p => p.status !== 'Archived');
    const moduleIds = new Set<string>();
    pkgs.forEach(p => {
      (p.moduleAssignments || []).forEach(a => {
        if (a.moduleId) moduleIds.add(a.moduleId);
      });
    });
    const mods = moduleLibrary.filter(m => moduleIds.has(m.id));
    return { packages: pkgs, moduleLibrary: mods };
  }, [packages, moduleLibrary]);

  /** Agent API only returns packages assigned to this tenant; if none, show editor library in the player (draft). */
  const isDraftPreviewActive = useMemo(
    () =>
      isAgentPreviewOpen &&
      !previewLoading &&
      !previewError &&
      previewPackages.length === 0 &&
      packages.some(p => p.status !== 'Archived'),
    [isAgentPreviewOpen, previewLoading, previewError, previewPackages, packages]
  );

  const loadAgentPreviewContent = useCallback(async (options?: { silent?: boolean }) => {
    const silent = Boolean(options?.silent);
    if (!silent) {
      setPreviewLoading(true);
    }
    setPreviewError(null);
    try {
      const res = (await apiService.get(
        '/api/me/agent/training/library-content?allowAdminPreview=1'
      )) as {
        success?: boolean;
        data?: {
          packages?: TrainingPackage[];
          moduleLibrary?: TrainingModule[];
          certificates?: CertificateGalleryItem[];
          agentProgress?: AgentLibraryProgress;
          hasAgentProfile?: boolean;
        };
        message?: string;
      };
      if (!res?.success) {
        setPreviewPackages([]);
        setPreviewModuleLibrary([]);
        setPreviewCertificateGallery([]);
        setPreviewAgentProgress(null);
        setPreviewHasAgentProfile(false);
        setPreviewError(res?.message || 'Failed to load agent preview');
        return;
      }
      const pkgs = Array.isArray(res.data?.packages) ? res.data.packages : [];
      const mods = Array.isArray(res.data?.moduleLibrary) ? res.data.moduleLibrary : [];
      const certs = Array.isArray(res.data?.certificates) ? res.data.certificates : [];
      setPreviewPackages(pkgs);
      setPreviewModuleLibrary(mods);
      setPreviewCertificateGallery(certs);
      const progress = res.data?.agentProgress;
      setPreviewAgentProgress(
        progress && Array.isArray(progress.quizCompletions) && Array.isArray(progress.moduleCompletions)
          ? progress
          : { quizCompletions: [], moduleCompletions: [] }
      );
      setPreviewHasAgentProfile(res.data?.hasAgentProfile === true);
    } catch (e) {
      setPreviewPackages([]);
      setPreviewModuleLibrary([]);
      setPreviewCertificateGallery([]);
      setPreviewAgentProgress(null);
      setPreviewHasAgentProfile(false);
      setPreviewError(e instanceof Error ? e.message : 'Failed to load preview');
    } finally {
      if (!silent) {
        setPreviewLoading(false);
      }
    }
  }, []);

  const openAgentPreview = useCallback(() => {
    setIsAgentPreviewOpen(true);
    void loadAgentPreviewContent();
  }, [loadAgentPreviewContent]);

  const closeAgentPreview = useCallback(() => {
    setIsAgentPreviewOpen(false);
    setPreviewError(null);
  }, []);

  const onPreviewUpdateModule = useCallback((moduleId: string, updater: (module: TrainingModule) => TrainingModule) => {
    setPreviewModuleLibrary(prev => prev.map(m => (m.id === moduleId ? updater(m) : m)));
  }, []);

  const handlePreviewUpdateModule = useCallback(
    (moduleId: string, updater: (module: TrainingModule) => TrainingModule) => {
      if (isDraftPreviewActive) {
        setModuleLibrary(previousModules =>
          previousModules.map(trainingModule =>
            trainingModule.id === moduleId ? updater(trainingModule) : trainingModule
          )
        );
      } else {
        onPreviewUpdateModule(moduleId, updater);
      }
    },
    [isDraftPreviewActive, onPreviewUpdateModule]
  );

  const onPreviewModuleCompleted = useCallback(
    async (packageId: string, moduleId: string) => {
      try {
        await apiService.post('/api/me/agent/training/library-modules/complete', { packageId, moduleId });
      } catch (err) {
        console.warn('[TrainingPreview] library module completion failed', err);
      }
      await loadAgentPreviewContent({ silent: true });
    },
    [loadAgentPreviewContent]
  );

  const onPreviewCompleteLibraryQuiz = useCallback(
    async ({
      packageId,
      moduleId,
      stepId,
      quizId,
      score,
      totalQuestions
    }: {
      packageId: string;
      moduleId: string;
      stepId: string;
      quizId: string;
      score: number;
      totalQuestions: number;
    }) => {
      const res = (await apiService.post('/api/me/agent/training/library-quizzes/complete', {
        packageId,
        moduleId,
        stepId,
        quizId,
        score,
        totalQuestions
      })) as {
        success?: boolean;
        data?: { packageCertification?: { passed?: boolean } };
      };
      await loadAgentPreviewContent({ silent: true });
      return {
        packageCertificationPassed: Boolean(res?.data?.packageCertification?.passed)
      };
    },
    [loadAgentPreviewContent]
  );

  useEffect(() => {
    if (!isAgentPreviewOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAgentPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isAgentPreviewOpen, closeAgentPreview]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setPortalToggleLoading(true);
      try {
        const res = await TenantAdminService.getTenantSettings();
        if (cancelled || !res.success || !res.data) {
          return;
        }
        const adv = (res.data as { advancedSettings?: { features?: { enableAgentPortalTraining?: boolean } } })
          .advancedSettings;
        setAgentPortalTrainingEnabled(adv?.features?.enableAgentPortalTraining !== false);
      } finally {
        if (!cancelled) {
          setPortalToggleLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persistAgentPortalTrainingEnabled = async (next: boolean): Promise<void> => {
    setPortalToggleSaving(true);
    setSaveMessage('');
    try {
      const res = await TenantAdminService.getTenantSettings();
      if (!res.success || !res.data) {
        setSaveMessage('Could not load tenant settings to update agent portal training.');
        return;
      }
      const data = res.data as { advancedSettings?: Record<string, unknown> };
      const advanced = { ...(data.advancedSettings || {}) };
      const features = {
        ...((advanced.features as Record<string, unknown> | undefined) || {}),
        enableAgentPortalTraining: next
      };
      advanced.features = features;
      const updateRes = await TenantAdminService.updateTenantSettings({
        AdvancedSettings: JSON.stringify(advanced)
      });
      if (!updateRes.success) {
        setSaveMessage(updateRes.message || 'Failed to save agent portal training setting.');
        return;
      }
      setAgentPortalTrainingEnabled(next);
      setSaveMessage(
        next
          ? 'Agent portal training is now visible to agents.'
          : 'Agent portal training is hidden for agents (Training tab removed).'
      );
    } catch {
      setSaveMessage('Failed to save agent portal training setting.');
    } finally {
      setPortalToggleSaving(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const loadLibrary = async () => {
      setLoadingLibrary(true);
      setSaveMessage('');
      try {
        const qs =
          isSysAdmin && fullOrgLibrary ? '?fullLibrary=true' : '';
        const response = await apiService.get<{
          success: boolean;
          data?: {
            packages: TrainingPackage[];
            moduleLibrary: TrainingModule[];
            packageAssignmentCounts?: Record<string, number>;
            seeded?: boolean;
            libraryScope?: string;
          };
        }>(`/api/me/tenant-admin/training-library${qs}`);

        const loadedPackages = Array.isArray(response?.data?.packages)
          ? response.data.packages.map(normalizePackage)
          : [];
        const loadedModules = Array.isArray(response?.data?.moduleLibrary)
          ? response.data.moduleLibrary
          : [];

        if (!cancelled) {
          setPackages(loadedPackages);
          setModuleLibrary(loadedModules);
          setPackageAssignmentCounts(response?.data?.packageAssignmentCounts || {});
          setSelectedPackageId(loadedPackages[0]?.id || '');
          setActiveModuleId(loadedModules[0]?.id || '');
          if (response?.data?.seeded) {
            setSaveMessage('Training library seeded from existing mock data.');
          }
        }
      } catch {
        if (!cancelled) {
          setPackages(INITIAL_PACKAGES.map(normalizePackage));
          setModuleLibrary(INITIAL_MODULE_LIBRARY);
          setSaveMessage('Could not load training library from server; using local defaults.');
        }
      } finally {
        if (!cancelled) {
          setLoadingLibrary(false);
        }
      }
    };

    void loadLibrary();

    return () => {
      cancelled = true;
    };
  }, [activeTenantId, fullOrgLibrary, isSysAdmin]);

  const saveLibraryToServer = async (): Promise<void> => {
    setSavingLibrary(true);
    setSaveMessage('');
    try {
      await apiService.put('/api/me/tenant-admin/training-library', {
        packages,
        moduleLibrary
      });
      const saveMeta = writeAdminSaveClientMeta(moduleLibrary);
      logAdminSaveRecordedToConsole(saveMeta);
      setSaveMessage('Training library saved to database.');
    } catch {
      setSaveMessage('Failed to save training library.');
    } finally {
      setSavingLibrary(false);
    }
  };

  const openAssignModal = async (): Promise<void> => {
    if (!selectedPackage) {
      return;
    }

    setIsAssignModalOpen(true);
    setAssignmentSearch('');
    setLoadingAssignments(true);
    setSavingAssignments(false);
    setAssignmentPackageId(selectedPackage.id);
    setAssignmentPackageTitle(selectedPackage.title);
    setSaveMessage('');

    try {
      const response = await apiService.get<{
        success: boolean;
        data?: {
          packageId: string;
          assignedTenantIds: string[];
          tenants: AssignmentTenant[];
        };
      }>(`/api/me/tenant-admin/training-library/packages/${selectedPackage.id}/tenant-assignments`);

      setAssignmentTenants(Array.isArray(response?.data?.tenants) ? response.data.tenants : []);
      setSelectedAssignmentTenantIds(
        Array.isArray(response?.data?.assignedTenantIds) ? response.data.assignedTenantIds : []
      );
    } catch {
      setAssignmentTenants([]);
      setSelectedAssignmentTenantIds([]);
      setSaveMessage('Failed to load tenant assignments.');
    } finally {
      setLoadingAssignments(false);
    }
  };

  const closeAssignModal = (): void => {
    if (savingAssignments) {
      return;
    }
    setIsAssignModalOpen(false);
  };

  const toggleTenantSelection = (tenantId: string): void => {
    setSelectedAssignmentTenantIds(previousValue => (
      previousValue.includes(tenantId)
        ? previousValue.filter(id => id !== tenantId)
        : [...previousValue, tenantId]
    ));
  };

  const saveTenantAssignments = async (): Promise<void> => {
    if (!assignmentPackageId) {
      return;
    }

    setSavingAssignments(true);
    setSaveMessage('');
    try {
      await apiService.put(
        `/api/me/tenant-admin/training-library/packages/${assignmentPackageId}/tenant-assignments`,
        { tenantIds: selectedAssignmentTenantIds }
      );

      setPackageAssignmentCounts(previousValue => ({
        ...previousValue,
        [assignmentPackageId]: selectedAssignmentTenantIds.length
      }));
      setSaveMessage('Tenant assignments saved.');
      setIsAssignModalOpen(false);
    } catch {
      setSaveMessage('Failed to save tenant assignments.');
    } finally {
      setSavingAssignments(false);
    }
  };

  const moduleLookup = useMemo(() => {
    return new Map(moduleLibrary.map(module => [module.id, module]));
  }, [moduleLibrary]);

  useEffect(() => {
    if (!packages.some(trainingPackage => trainingPackage.id === selectedPackageId)) {
      setSelectedPackageId(packages[0]?.id || '');
    }
  }, [packages, selectedPackageId]);

  useEffect(() => {
    if (!moduleLibrary.some(module => module.id === activeModuleId)) {
      setActiveModuleId(moduleLibrary[0]?.id || '');
    }
  }, [activeModuleId, moduleLibrary]);

  const filteredPackages = useMemo(() => {
    const normalizedSearch = packageSearch.trim().toLowerCase();
    return packages.filter(trainingPackage => {
      const matchesStatus =
        statusFilter === 'All' ? true : trainingPackage.status === statusFilter;
      if (!matchesStatus) {
        return false;
      }
      if (!normalizedSearch) {
        return true;
      }
      const moduleMatch = trainingPackage.moduleAssignments.some(assignment => {
        const module = moduleLookup.get(assignment.moduleId);
        return module
          ? module.title.toLowerCase().includes(normalizedSearch) ||
              module.modulePurpose.toLowerCase().includes(normalizedSearch) ||
              module.id.toLowerCase().includes(normalizedSearch)
          : false;
      });
      return (
        trainingPackage.title.toLowerCase().includes(normalizedSearch) ||
        trainingPackage.id.toLowerCase().includes(normalizedSearch) ||
        moduleMatch
      );
    });
  }, [moduleLookup, packageSearch, packages, statusFilter]);

  const selectedPackage = useMemo(
    () => packages.find(trainingPackage => trainingPackage.id === selectedPackageId) || null,
    [packages, selectedPackageId]
  );

  const resolvedModules = useMemo<ResolvedPackageModule[]>(() => {
    if (!selectedPackage) {
      return [];
    }
    return [...selectedPackage.moduleAssignments]
      .sort((a, b) => a.order - b.order)
      .map(assignment => ({
        assignment,
        module: moduleLookup.get(assignment.moduleId) || null
      }));
  }, [moduleLookup, selectedPackage]);

  const filteredLibraryModules = useMemo(() => {
    let list = moduleLibrary;
    if (!showArchivedModules) {
      list = list.filter(module => module.archived !== true);
    }
    if (moduleArchiveFilter === 'active') {
      list = list.filter(module => module.archived !== true);
    } else if (moduleArchiveFilter === 'archived') {
      list = list.filter(module => module.archived === true);
    }

    const normalizedSearch = moduleSearch.trim().toLowerCase();
    if (!normalizedSearch) {
      return list;
    }
    return list.filter(module => {
      return (
        module.title.toLowerCase().includes(normalizedSearch) ||
        module.modulePurpose.toLowerCase().includes(normalizedSearch) ||
        module.id.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [moduleLibrary, moduleSearch, moduleArchiveFilter, showArchivedModules]);

  const archiveDialogAffectedPackages = useMemo(() => {
    if (!archiveDialogModuleId) {
      return [];
    }
    return packages.filter(trainingPackage =>
      trainingPackage.moduleAssignments.some(a => a.moduleId === archiveDialogModuleId)
    );
  }, [archiveDialogModuleId, packages]);

  const archiveDialogModuleTitle = useMemo(() => {
    if (!archiveDialogModuleId) {
      return '';
    }
    return moduleLibrary.find(m => m.id === archiveDialogModuleId)?.title || archiveDialogModuleId;
  }, [archiveDialogModuleId, moduleLibrary]);

  const permanentDeleteDialogModuleTitle = useMemo(() => {
    if (!permanentDeleteDialogModuleId) {
      return '';
    }
    return (
      moduleLibrary.find(m => m.id === permanentDeleteDialogModuleId)?.title ||
      permanentDeleteDialogModuleId
    );
  }, [permanentDeleteDialogModuleId, moduleLibrary]);

  const canManageModuleLifecycle = user?.currentRole === 'TenantAdmin';

  const requestArchiveModule = (moduleId: string): void => {
    setArchiveDialogModuleId(moduleId);
  };

  const closeArchiveDialog = (): void => {
    if (archiveModuleSubmitting) {
      return;
    }
    setArchiveDialogModuleId(null);
  };

  const confirmArchiveModule = async (): Promise<void> => {
    if (!archiveDialogModuleId || archiveModuleSubmitting) {
      return;
    }
    const moduleId = archiveDialogModuleId;
    setArchiveModuleSubmitting(true);
    setSaveMessage('');
    try {
      await apiService.patch(`/api/me/tenant-admin/training-library/modules/${moduleId}/archive`, {});
      const archivedTitle =
        moduleLibrary.find(m => m.id === moduleId)?.title || moduleId;
      const nextLibrary = moduleLibrary.map(m =>
        m.id === moduleId
          ? {
              ...m,
              archived: true,
              archivedAt: new Date().toISOString(),
              archivedBy: user?.userId
            }
          : m
      );
      setModuleLibrary(nextLibrary);
      setPackages(previous => stripModuleFromAllPackages(previous, moduleId));
      setActiveModuleId(previous => {
        if (previous !== moduleId) {
          return previous;
        }
        return nextLibrary.find(m => m.archived !== true)?.id || '';
      });
      setSaveMessage(`Module archived: ${archivedTitle}`);
      setArchiveDialogModuleId(null);
    } catch {
      setSaveMessage('Failed to archive module.');
    } finally {
      setArchiveModuleSubmitting(false);
    }
  };

  const requestPermanentDeleteModule = (moduleId: string): void => {
    setPermanentDeleteDialogModuleId(moduleId);
  };

  const closePermanentDeleteDialog = (): void => {
    if (permanentDeleteSubmitting) {
      return;
    }
    setPermanentDeleteDialogModuleId(null);
  };

  const confirmPermanentDeleteModule = async (): Promise<void> => {
    if (!permanentDeleteDialogModuleId || permanentDeleteSubmitting) {
      return;
    }
    const moduleId = permanentDeleteDialogModuleId;
    const mod = moduleLibrary.find(m => m.id === moduleId);
    if (!mod || mod.archived !== true) {
      setSaveMessage('Only archived modules can be permanently deleted.');
      setPermanentDeleteDialogModuleId(null);
      return;
    }
    setPermanentDeleteSubmitting(true);
    setSaveMessage('');
    try {
      await apiService.delete(`/api/me/tenant-admin/training-library/modules/${encodeURIComponent(moduleId)}`);
      const title = mod.title || moduleId;
      const nextLibrary = moduleLibrary.filter(m => m.id !== moduleId);
      setModuleLibrary(nextLibrary);
      setPackages(previous => stripModuleFromAllPackages(previous, moduleId));
      setActiveModuleId(previous => {
        if (previous !== moduleId) {
          return previous;
        }
        return nextLibrary.find(m => m.archived !== true)?.id || nextLibrary[0]?.id || '';
      });
      setSaveMessage(`Module permanently deleted: ${title}`);
      setPermanentDeleteDialogModuleId(null);
    } catch {
      setSaveMessage('Failed to permanently delete module.');
    } finally {
      setPermanentDeleteSubmitting(false);
    }
  };

  const activeModule = useMemo(
    () => moduleLibrary.find(module => module.id === activeModuleId) || null,
    [activeModuleId, moduleLibrary]
  );

  const selectedPackageModuleIds = useMemo(() => {
    if (!selectedPackage) {
      return [];
    }
    return selectedPackage.moduleAssignments.map(assignment => assignment.moduleId);
  }, [selectedPackage]);

  const filteredAssignmentTenants = useMemo(() => {
    const normalizedSearch = assignmentSearch.trim().toLowerCase();
    if (!normalizedSearch) {
      return assignmentTenants;
    }
    return assignmentTenants.filter(tenant => (
      tenant.Name.toLowerCase().includes(normalizedSearch) ||
      tenant.TenantId.toLowerCase().includes(normalizedSearch)
    ));
  }, [assignmentSearch, assignmentTenants]);

  const updateSelectedPackage = (
    updater: (trainingPackage: TrainingPackage) => TrainingPackage
  ): void => {
    if (!selectedPackageId) {
      return;
    }
    setPackages(previousPackages =>
      previousPackages.map(trainingPackage =>
        trainingPackage.id === selectedPackageId ? updater(trainingPackage) : trainingPackage
      )
    );
  };

  const updateActiveModule = (
    updater: (trainingModule: TrainingModule) => TrainingModule
  ): void => {
    if (!activeModuleId) {
      return;
    }
    setModuleLibrary(previousModules =>
      previousModules.map(trainingModule =>
        trainingModule.id === activeModuleId ? updater(trainingModule) : trainingModule
      )
    );
  };

  const updateModuleById = (
    moduleId: string,
    updater: (trainingModule: TrainingModule) => TrainingModule
  ): void => {
    setModuleLibrary(previousModules =>
      previousModules.map(trainingModule =>
        trainingModule.id === moduleId ? updater(trainingModule) : trainingModule
      )
    );
  };

  const addPackage = (): void => {
    const newPackage: TrainingPackage = {
      id: createTrainingId('pkg'),
      title: 'New Training Package',
      packagePurpose: 'Describe package purpose and expected learning outcomes.',
      status: 'Draft',
      version: '0.1.0',
      certificate: {
        packageName: 'New Training Package',
        certificateName: 'New Training Package Certificate',
        certificateDetails:
          'Awarded for achieving a cumulative quiz score of 70% or higher for this package.',
        certificateImageUrl: DEFAULT_CERTIFICATE_IMAGE_URL
      },
      moduleAssignments: []
    };
    setPackages(previousPackages => [newPackage, ...previousPackages]);
    setSelectedPackageId(newPackage.id);
  };

  const updatePackageField = (
    field:
      | 'title'
      | 'packagePurpose'
      | 'status'
      | 'version'
      | 'packageImageUrl'
      | 'certificate.packageName'
      | 'certificate.certificateName'
      | 'certificate.certificateDetails'
      | 'certificate.certificateImageUrl',
    value: string
  ): void => {
    if (field === 'packageImageUrl') {
      const trimmed = value.trim();
      updateSelectedPackage(trainingPackage => {
        const { packageImageUrl: _omit, ...rest } = trainingPackage;
        return trimmed ? { ...rest, packageImageUrl: trimmed } : rest;
      });
      return;
    }
    updateSelectedPackage(trainingPackage => ({
      ...trainingPackage,
      ...(field.startsWith('certificate.')
        ? {
            certificate: {
              ...normalizePackageCertificate(trainingPackage),
              [field.replace('certificate.', '')]: value
            }
          }
        : {
            [field]:
              field === 'status'
                ? (value as TrainingPackageStatus)
                : value
          })
    }));
  };

  const addModuleToPackage = (moduleId: string): void => {
    if (!selectedPackage) {
      return;
    }
    const existing = selectedPackage.moduleAssignments.some(
      assignment => assignment.moduleId === moduleId
    );
    if (existing) {
      return;
    }
    const sourceModule = moduleLookup.get(moduleId);
    if (sourceModule?.archived) {
      return;
    }
    const nextOrder =
      selectedPackage.moduleAssignments.length === 0
        ? 1
        : Math.max(...selectedPackage.moduleAssignments.map(assignment => assignment.order)) + 1;

    const assignment: PackageModuleAssignment = {
      id: createTrainingId('pkgmod'),
      moduleId,
      required: sourceModule?.defaultRequired ?? false,
      order: nextOrder
    };

    updateSelectedPackage(trainingPackage => ({
      ...trainingPackage,
      moduleAssignments: [...trainingPackage.moduleAssignments, assignment]
    }));
  };

  const removeModuleAssignment = (assignmentId: string): void => {
    updateSelectedPackage(trainingPackage => {
      const remainingAssignments = trainingPackage.moduleAssignments
        .filter(assignment => assignment.id !== assignmentId)
        .sort((a, b) => a.order - b.order)
        .map((assignment, index) => ({
          ...assignment,
          order: index + 1
        }));
      return { ...trainingPackage, moduleAssignments: remainingAssignments };
    });
  };

  const toggleAssignmentRequired = (assignmentId: string): void => {
    updateSelectedPackage(trainingPackage => ({
      ...trainingPackage,
      moduleAssignments: trainingPackage.moduleAssignments.map(assignment =>
        assignment.id === assignmentId
          ? { ...assignment, required: !assignment.required }
          : assignment
      )
    }));
  };

  const moveModuleAssignment = (assignmentId: string, direction: 'up' | 'down'): void => {
    updateSelectedPackage(trainingPackage => {
      const orderedAssignments = [...trainingPackage.moduleAssignments].sort(
        (a, b) => a.order - b.order
      );
      const fromIndex = orderedAssignments.findIndex(
        assignment => assignment.id === assignmentId
      );
      if (fromIndex === -1) {
        return trainingPackage;
      }

      const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
      if (toIndex < 0 || toIndex >= orderedAssignments.length) {
        return trainingPackage;
      }

      const reorderedAssignments = [...orderedAssignments];
      const [movedAssignment] = reorderedAssignments.splice(fromIndex, 1);
      reorderedAssignments.splice(toIndex, 0, movedAssignment);

      return {
        ...trainingPackage,
        moduleAssignments: reorderedAssignments.map((assignment, index) => ({
          ...assignment,
          order: index + 1
        }))
      };
    });
  };

  const openNewModuleModal = (): void => {
    setImportModuleJsonText('');
    setImportPasteValidation(null);
    setAddImportedModuleToPackage(true);
    setIsNewModuleModalOpen(true);
  };

  const closeNewModuleModal = (): void => {
    setIsNewModuleModalOpen(false);
    setImportPasteValidation(null);
  };

  const runImportPasteValidation = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      setImportPasteValidation(null);
      return;
    }
    setImportPasteValidation(parseModulePasteToTrainingModule(text));
  };

  useEffect(() => {
    if (!isNewModuleModalOpen) {
      return;
    }
    const trimmed = importModuleJsonText.trim();
    if (!trimmed) {
      setImportPasteValidation(null);
      return;
    }
    const timer = window.setTimeout(() => {
      setImportPasteValidation(parseModulePasteToTrainingModule(importModuleJsonText));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [importModuleJsonText, isNewModuleModalOpen]);

  const createBlankModule = (): void => {
    const newModule: TrainingModule = {
      id: createTrainingId('mod'),
      title: 'Untitled Module',
      modulePurpose: '',
      defaultRequired: false,
      attachments: [],
      moduleSteps: []
    };
    setModuleLibrary(previousModules => [newModule, ...previousModules]);
    setActiveModuleId(newModule.id);
    closeNewModuleModal();
  };

  const importModuleFromJson = (): void => {
    const result = parseModulePasteToTrainingModule(importModuleJsonText);
    setImportPasteValidation(result);
    if (!result.ok) {
      return;
    }

    const mod = result.module;
    if (moduleLibrary.some(m => m.id === mod.id)) {
      setImportPasteValidation({
        ok: false,
        error: `A module with id "${mod.id}" already exists in the library.`
      });
      return;
    }

    setModuleLibrary(previousModules => [mod, ...previousModules]);
    setActiveModuleId(mod.id);

    if (addImportedModuleToPackage && selectedPackageId) {
      setPackages(previousPackages =>
        previousPackages.map(trainingPackage => {
          if (trainingPackage.id !== selectedPackageId) {
            return trainingPackage;
          }
          if (trainingPackage.moduleAssignments.some(a => a.moduleId === mod.id)) {
            return trainingPackage;
          }
          const nextOrder =
            trainingPackage.moduleAssignments.length === 0
              ? 1
              : Math.max(...trainingPackage.moduleAssignments.map(a => a.order)) + 1;
          const assignment: PackageModuleAssignment = {
            id: createTrainingId('pkgmod'),
            moduleId: mod.id,
            required: mod.defaultRequired,
            order: nextOrder
          };
          return {
            ...trainingPackage,
            moduleAssignments: [...trainingPackage.moduleAssignments, assignment]
          };
        })
      );
    }

    setImportModuleJsonText('');
    setImportPasteValidation(null);
    setIsNewModuleModalOpen(false);
  };

  const previewPlayerPackages = isDraftPreviewActive ? draftPreviewPayload.packages : previewPackages;
  const previewPlayerModules = isDraftPreviewActive ? draftPreviewPayload.moduleLibrary : previewModuleLibrary;
  const previewPlayerKey = isDraftPreviewActive
    ? `draft|${draftPreviewPayload.packages.map(p => p.id).join('|')}`
    : previewPackages.map(p => p.id).join('|');

  return (
    <div className="p-6 space-y-6">
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-gray-900">Agent Training</h1>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openAgentPreview}
              disabled={loadingLibrary || isAgentPreviewOpen}
              className="inline-flex items-center gap-2 rounded-lg border border-oe-primary bg-white px-4 py-2 text-sm font-semibold text-oe-primary hover:bg-oe-light disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Eye className="h-4 w-4 shrink-0" aria-hidden />
              Preview as agent
            </button>
            <button
              type="button"
              onClick={saveLibraryToServer}
              disabled={loadingLibrary || savingLibrary}
              className="rounded border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {savingLibrary ? 'Saving...' : 'Save Library'}
            </button>
          </div>
        </div>
        <p className="mt-2 text-gray-600">
          Build training packages by assembling modules from a shared library, then edit module content in one place.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900">Show agent portal training</p>
            <p className="mt-1 text-sm text-gray-600">
              When off, agents do not see the Training tab in the agent portal. You can still build and assign packages
              here.
            </p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-2 shrink-0">
            <span className="text-sm text-gray-700">{agentPortalTrainingEnabled ? 'On' : 'Off'}</span>
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              checked={agentPortalTrainingEnabled}
              disabled={portalToggleLoading || portalToggleSaving}
              onChange={e => {
                void persistAgentPortalTrainingEnabled(e.target.checked);
              }}
            />
          </label>
        </div>
        {isSysAdmin && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900">Organization library (SysAdmin)</p>
              <p className="mt-1 text-sm text-gray-600">
                Default view lists only packages assigned to the current tenant. Enable this to load every package in the
                shared library for cross-tenant assignment and editing.
              </p>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 shrink-0">
              <span className="text-sm text-gray-700">Show all packages</span>
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                checked={fullOrgLibrary}
                onChange={e => {
                  setFullOrgLibrary(e.target.checked);
                }}
              />
            </label>
          </div>
        )}
        {loadingLibrary && (
          <p className="mt-2 text-sm text-gray-500">Loading training library from server...</p>
        )}
        {!loadingLibrary && saveMessage && (
          <p className="mt-2 text-sm text-gray-600">{saveMessage}</p>
        )}
      </div>

      {isAgentPreviewOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="agent-training-preview-title"
          className="fixed inset-0 z-[130] flex min-h-0 flex-col bg-white"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-2 sm:px-5">
            <h2 id="agent-training-preview-title" className="text-base font-semibold text-gray-900">
              Agent training preview
            </h2>
            <button
              type="button"
              onClick={closeAgentPreview}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-300 px-2.5 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
              Exit preview
            </button>
          </div>

          {!previewLoading && !previewError && (
            <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-4 py-1.5 sm:px-5">
              <p className="text-xs leading-snug text-gray-600">
                <span className="font-medium text-gray-800">Published library.</span> Save to refresh preview with
                unpublished edits.
                {isDraftPreviewActive && (
                  <span className="text-amber-900">
                    {' '}
                    Unassigned packages — assign to this tenant so agents see them in the portal.
                  </span>
                )}
                {!previewHasAgentProfile && (
                  <span className="text-amber-900">
                    {' '}
                    Progress not saved (no agent profile) — sign in as an agent to test completions.
                  </span>
                )}
              </p>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {previewLoading && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16" role="status">
                <Loader2 className="h-10 w-10 animate-spin text-oe-primary" aria-hidden />
                <p className="text-sm text-gray-600">Loading agent view…</p>
              </div>
            )}
            {!previewLoading && previewError && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-12">
                <p className="text-center text-sm text-red-700">{previewError}</p>
                <button
                  type="button"
                  onClick={() => void loadAgentPreviewContent()}
                  className="rounded-lg border border-oe-primary bg-oe-primary px-4 py-2 text-sm font-semibold text-white hover:bg-oe-dark"
                >
                  Retry
                </button>
              </div>
            )}
            {!previewLoading && !previewError && (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-2 sm:px-6">
                {previewPlayerPackages.length === 0 ? (
                  <p className="flex flex-1 items-center justify-center py-8 text-center text-sm text-gray-600">
                    No training packages are assigned to this tenant, or all are archived. Select a package, use Assign
                    to tenants, save the library, then try preview again.
                  </p>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <TrainingPlayer2Panel
                      key={previewPlayerKey}
                      packages={previewPlayerPackages}
                      moduleLibrary={previewPlayerModules}
                      initialPackageId=""
                      initialTabId="curriculum"
                      onUpdateModule={handlePreviewUpdateModule}
                      onModuleCompleted={
                        previewHasAgentProfile && !isDraftPreviewActive ? onPreviewModuleCompleted : undefined
                      }
                      onCompleteLibraryQuiz={
                        previewHasAgentProfile && !isDraftPreviewActive ? onPreviewCompleteLibraryQuiz : undefined
                      }
                      certificateGallery={isDraftPreviewActive ? [] : previewCertificateGallery}
                      agentProgress={isDraftPreviewActive ? null : previewAgentProgress}
                      showColumbusCallout
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!isAgentPreviewOpen && (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <PackageListPanel
          packages={filteredPackages}
          packageAssignmentCounts={packageAssignmentCounts}
          selectedPackageId={selectedPackageId}
          packageSearch={packageSearch}
          statusFilter={statusFilter}
          onPackageSearchChange={setPackageSearch}
          onStatusFilterChange={setStatusFilter}
          onSelectPackage={setSelectedPackageId}
          onAddPackage={addPackage}
        />

        <PackageBuilderPanel
          selectedPackage={selectedPackage}
          assignedTenantCount={selectedPackage ? (packageAssignmentCounts[selectedPackage.id] || 0) : 0}
          resolvedModules={resolvedModules}
          onUpdatePackageField={updatePackageField}
          onToggleRequired={toggleAssignmentRequired}
          onRemoveModule={removeModuleAssignment}
          onMoveModule={moveModuleAssignment}
          onEditModule={setActiveModuleId}
          onOpenAssignTenants={openAssignModal}
        />

        <ModuleLibraryPanel
          modules={filteredLibraryModules}
          moduleSearch={moduleSearch}
          activeModuleId={activeModuleId}
          selectedPackageModuleIds={selectedPackageModuleIds}
          hasSelectedPackage={Boolean(selectedPackage)}
          selectedPackageName={selectedPackage?.title || ''}
          onModuleSearchChange={setModuleSearch}
          onAddToPackage={addModuleToPackage}
          onEditModule={setActiveModuleId}
          onOpenNewModuleModal={openNewModuleModal}
          showArchivedModules={showArchivedModules}
          onShowArchivedModulesChange={setShowArchivedModules}
          moduleArchiveFilter={moduleArchiveFilter}
          onModuleArchiveFilterChange={setModuleArchiveFilter}
          canArchiveModules={canManageModuleLifecycle}
          onRequestArchiveModule={requestArchiveModule}
          onRequestPermanentDeleteModule={requestPermanentDeleteModule}
        />

        <div className="xl:col-span-12">
          <TrainingEditorPlayerSplitPane
            leftPane={
              <ModuleEditorPanel
                module={activeModule}
                onChangeModule={updateActiveModule}
                onOpenRawJsonEditor={() => {
                  document.getElementById('training-module-raw-json-editor')?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                  });
                }}
              />
            }
            rightPane={
              <TrainingPlayer2Panel
                packages={packages}
                moduleLibrary={moduleLibrary}
                initialPackageId={selectedPackageId}
                editorLinkedModuleId={activeModuleId}
                onUpdateModule={updateModuleById}
              />
            }
          />
        </div>
        </div>
      )}

      {archiveDialogModuleId && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="archive-module-dialog-title"
          onClick={event => {
            if (event.target === event.currentTarget) {
              closeArchiveDialog();
            }
          }}
        >
          <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white shadow-xl">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3 id="archive-module-dialog-title" className="text-lg font-semibold text-gray-900">
                Archive module?
              </h3>
              <p className="mt-2 text-sm text-gray-700">
                You are about to archive{' '}
                <span className="font-semibold text-gray-900">{archiveDialogModuleTitle}</span>.
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm text-gray-700">
              <p>
                Archived modules are hidden from the module library and{' '}
                <span className="font-medium text-gray-900">cannot be assigned to packages</span>.
              </p>
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-950">
                This module will be{' '}
                <span className="font-semibold">removed from every training package</span> that currently
                includes it. Those packages will no longer reference this module.
              </p>
              {archiveDialogAffectedPackages.length > 0 ? (
                <div>
                  <p className="mb-2 font-medium text-gray-900">Packages that include this module:</p>
                  <ul className="list-disc space-y-1 pl-5 text-gray-800">
                    {archiveDialogAffectedPackages.map(pkg => (
                      <li key={pkg.id}>{pkg.title || pkg.id}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="text-gray-600">No packages currently include this module.</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
              <button
                type="button"
                onClick={closeArchiveDialog}
                disabled={archiveModuleSubmitting}
                className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmArchiveModule()}
                disabled={archiveModuleSubmitting}
                className="rounded border border-red-600 bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {archiveModuleSubmitting ? 'Archiving…' : 'Archive module'}
              </button>
            </div>
          </div>
        </div>
      )}

      {permanentDeleteDialogModuleId && (
        <div
          className="fixed inset-0 z-[125] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="permanent-delete-module-dialog-title"
          onClick={event => {
            if (event.target === event.currentTarget) {
              closePermanentDeleteDialog();
            }
          }}
        >
          <div className="w-full max-w-lg rounded-lg border border-gray-200 bg-white shadow-xl">
            <div className="border-b border-gray-200 px-5 py-4">
              <h3
                id="permanent-delete-module-dialog-title"
                className="text-lg font-semibold text-gray-900"
              >
                Delete module permanently?
              </h3>
              <p className="mt-2 text-sm text-gray-700">
                This will remove{' '}
                <span className="font-semibold text-gray-900">{permanentDeleteDialogModuleTitle}</span> from
                the training library JSON. This cannot be undone.
              </p>
            </div>
            <div className="space-y-3 px-5 py-4 text-sm text-gray-700">
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-950">
                Any package references to this module are removed. Other modules are not affected.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-gray-200 px-5 py-4">
              <button
                type="button"
                onClick={closePermanentDeleteDialog}
                disabled={permanentDeleteSubmitting}
                className="rounded border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmPermanentDeleteModule()}
                disabled={permanentDeleteSubmitting}
                className="rounded border border-red-900 bg-red-900 px-4 py-2 text-sm font-semibold text-white hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {permanentDeleteSubmitting ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isNewModuleModalOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">New module</h3>
                <p className="mt-1 text-sm text-gray-600">
                  Paste strict JSON or a JavaScript object literal (single quotes and + string concat are OK).
                  Validation runs as you type; use Save Library to persist.
                </p>
              </div>
              <button
                type="button"
                onClick={closeNewModuleModal}
                className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 px-5 py-4">
              <textarea
                value={importModuleJsonText}
                onChange={event => setImportModuleJsonText(event.target.value)}
                placeholder="Paste JSON or a JavaScript object literal (single quotes and string concat OK)."
                rows={14}
                className="w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs"
                spellCheck={false}
              />

              {importPasteValidation && (
                <div
                  className={`rounded-md border px-3 py-2 text-sm ${
                    importPasteValidation.ok
                      ? 'border-green-200 bg-green-50 text-green-900'
                      : 'border-red-200 bg-red-50 text-red-800'
                  }`}
                >
                  {importPasteValidation.ok ? (
                    <p>
                      Valid module (parsed as{' '}
                      {importPasteValidation.parseMethod === 'json' ? 'JSON' : 'JavaScript'}).
                    </p>
                  ) : (
                    <p className="whitespace-pre-wrap">
                      {'error' in importPasteValidation ? importPasteValidation.error : ''}
                    </p>
                  )}
                </div>
              )}

              {selectedPackageId && (
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={addImportedModuleToPackage}
                    onChange={event => setAddImportedModuleToPackage(event.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                  />
                  Also add this module to the selected package (at end of order)
                </label>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => runImportPasteValidation(importModuleJsonText)}
                  className="rounded border border-gray-400 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
                >
                  Validate
                </button>
                <button
                  type="button"
                  onClick={importModuleFromJson}
                  className="rounded border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
                >
                  Import module
                </button>
                <button
                  type="button"
                  onClick={createBlankModule}
                  className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Create blank module instead
                </button>
                <button
                  type="button"
                  onClick={closeNewModuleModal}
                  className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAssignModalOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Assign Package To Tenants</h3>
                <p className="mt-1 text-sm text-gray-600">{assignmentPackageTitle}</p>
              </div>
              <button
                type="button"
                onClick={closeAssignModal}
                className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 px-5 py-4">
              {!loadingAssignments && (
                <input
                  value={assignmentSearch}
                  onChange={event => setAssignmentSearch(event.target.value)}
                  placeholder="Search tenants..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              )}

              {loadingAssignments ? (
                <div
                  className="flex min-h-[280px] flex-col items-center justify-center gap-4 rounded-md border border-gray-100 bg-gray-50/80 py-12"
                  role="status"
                  aria-live="polite"
                  aria-busy="true"
                >
                  <Loader2 className="h-10 w-10 animate-spin text-oe-primary" aria-hidden />
                  <p className="text-sm font-medium text-gray-600">Loading tenants…</p>
                  <p className="max-w-xs text-center text-xs text-gray-500">
                    Fetching assignments and your accessible tenant list.
                  </p>
                </div>
              ) : (
                <div className="max-h-[340px] space-y-2 overflow-y-auto rounded-md border border-gray-200 p-3">
                  {filteredAssignmentTenants.map(tenant => (
                    <label
                      key={tenant.TenantId}
                      className="flex items-center justify-between gap-3 rounded border border-gray-100 px-3 py-2 hover:bg-gray-50"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">{tenant.Name}</p>
                        <p className="truncate text-xs text-gray-500">{tenant.TenantId}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={selectedAssignmentTenantIds.includes(tenant.TenantId)}
                        onChange={() => toggleTenantSelection(tenant.TenantId)}
                        className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                      />
                    </label>
                  ))}
                  {filteredAssignmentTenants.length === 0 && (
                    <p className="text-sm text-gray-500">No tenants found.</p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-200 px-5 py-4">
              <p className="text-xs text-gray-600">
                {selectedAssignmentTenantIds.length} tenant(s) selected
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeAssignModal}
                  disabled={savingAssignments}
                  className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveTenantAssignments}
                  disabled={loadingAssignments || savingAssignments}
                  className="inline-flex items-center gap-2 rounded border border-oe-primary bg-oe-primary px-3 py-1.5 text-sm font-semibold text-white hover:bg-oe-dark disabled:opacity-60"
                >
                  {savingAssignments ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Saving…
                    </>
                  ) : (
                    'Save'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <TrainingModuleLibraryRawJsonEditor
        activeModuleId={activeModuleId}
        moduleLibrary={moduleLibrary}
        packages={packages}
        disabled={loadingLibrary}
        savingLibrary={savingLibrary}
        onUpsertModule={module => {
          setModuleLibrary(previous => {
            const index = previous.findIndex(m => m.id === module.id);
            if (index >= 0) {
              const next = [...previous];
              next[index] = module;
              return next;
            }
            return [...previous, module];
          });
        }}
        onReplaceModuleLibrary={setModuleLibrary}
        onPersist={saveLibraryToServer}
      />
    </div>
  );
};

export default TenantAgentTraining;
