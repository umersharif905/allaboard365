// frontend/src/pages/groups/GroupSetupTab.tsx
import {
  AccountBalance as AccountBalanceIcon,
  Assignment as AssignmentIcon,
  CheckCircle as CheckCircleIcon,
  CreditCard as CreditCardIcon,
  Link as LinkIcon,
  People as PeopleIcon,
  Refresh as RefreshIcon,
  Rule as RuleIcon
} from '@mui/icons-material';
import {
  Alert,
  AlertTitle,
  alpha,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  LinearProgress,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useBranding } from '../../contexts/BrandingContext';
import { useGroupSetupStatus } from '../../hooks/useGroupSetupStatus';
import { apiService } from '../../services/api.service';
import { GroupsService } from '../../services/groups.service';
import NewGroupFormCertificationSignModal from '../../components/groups/NewGroupFormCertificationSignModal';

interface GroupSetupTabProps {
  groupId: string;
  groupName: string;
  groupData?: Group | null; // Pass from parent to avoid re-fetching in useGroupSetupStatus
  onTabChange: (tabIndex: number) => void;
  setupStatus?: string; // Pass SetupStatus from parent
  getTabIndexForStep?: (stepId: string) => number; // Function to get correct tab index for a step
  isActive?: boolean; // Whether this tab is currently active
  /** When true (Agent/TenantAdmin/SysAdmin/GroupAdmin), show shortcut to Users tab for onboarding */
  onboardingIncomplete?: boolean;
  onGoToUsersForOnboarding?: () => void;
  /** Opens the group edit modal (e.g. for "Complete business info" / EIN step) */
  onEditGroup?: () => void;
}

interface Group {
  GroupId?: string;
  SetupStatus?: string;
  [key: string]: unknown;
}

const GroupSetupTab: React.FC<GroupSetupTabProps> = ({ groupId, groupName, groupData: parentGroupData, onTabChange, setupStatus: parentSetupStatus, getTabIndexForStep, isActive = true, onboardingIncomplete, onGoToUsersForOnboarding, onEditGroup }) => {
  const theme = useTheme();
  const { user } = useAuth();
  const { colors } = useBranding();
  
  // Check if user has access to onboarding features (affects tab indices)
  const hasOnboardingAccess = user?.roles?.some((role: string) => 
    ['Agent', 'TenantAdmin', 'SysAdmin', 'GroupAdmin'].includes(role)
  ) || false;
  
  const { 
    data: setupStatus = { 
      isSetupComplete: false, 
      steps: [], 
      completionPercentage: 0 
    },
    isLoading,
    isError,
    error,
    refetch,
    isSetupStepsError,
    isAsaError,
    setupStepsFetchError,
    asaFetchError,
  } = useGroupSetupStatus(groupId, parentGroupData, hasOnboardingAccess);

  // Combined "Complete Business Info & Sign" modal: missing info + signature status + sign/edit
  const [showBusinessInfoCertifyModal, setShowBusinessInfoCertifyModal] = useState(false);
  const [businessInfoCertifyGroup, setBusinessInfoCertifyGroup] = useState<{ TaxIdNumber?: string } | null>(null);
  const [businessInfoCertifyCertification, setBusinessInfoCertifyCertification] = useState<{
    agentSignedAt: string | null;
    agentHasSignature: boolean;
    groupAdminSignedAt: string | null;
    groupAdminHasSignature: boolean;
    signaturesRequired?: boolean;
  } | null>(null);
  const [businessInfoCertifyLoading, setBusinessInfoCertifyLoading] = useState(false);
  const [signModalRole, setSignModalRole] = useState<'agent' | 'group-admin' | null>(null);
  const [signSubmitting, setSignSubmitting] = useState(false);
  const roles = (user?.roles || []) as string[];
  const canSignAsAgent = roles.some((r) => ['SysAdmin', 'TenantAdmin', 'Agent'].includes(r));
  const canSignAsGroupAdmin = roles.some((r) => ['SysAdmin', 'TenantAdmin', 'GroupAdmin'].includes(r));

  const loadBusinessInfoCertifyModal = useCallback(async () => {
    if (!groupId) return;
    setBusinessInfoCertifyLoading(true);
    setBusinessInfoCertifyGroup(null);
    setBusinessInfoCertifyCertification(null);
    try {
      const [groupRes, certRes] = await Promise.all([
        GroupsService.getGroupById(groupId),
        apiService.get<{ success: boolean; data?: { agentSignedAt: string | null; agentHasSignature: boolean; groupAdminSignedAt: string | null; groupAdminHasSignature: boolean; signaturesRequired?: boolean } }>(`/api/groups/${groupId}/new-group-form/certification`)
      ]);
      const groupData = (groupRes as any)?.data ?? (groupRes as any);
      setBusinessInfoCertifyGroup(groupData ?? null);
      if (certRes?.success && certRes?.data) setBusinessInfoCertifyCertification(certRes.data);
      else setBusinessInfoCertifyCertification(null);
    } catch {
      setBusinessInfoCertifyGroup(null);
      setBusinessInfoCertifyCertification(null);
    } finally {
      setBusinessInfoCertifyLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    if (showBusinessInfoCertifyModal && groupId) loadBusinessInfoCertifyModal();
  }, [showBusinessInfoCertifyModal, groupId, loadBusinessInfoCertifyModal]);

  const handleCertificationSign = useCallback(async (signatureData: string) => {
    if (!groupId || !signModalRole) return;
    setSignSubmitting(true);
    try {
      const path = signModalRole === 'agent'
        ? `/api/groups/${groupId}/new-group-form/certification/agent`
        : `/api/groups/${groupId}/new-group-form/certification/group-admin`;
      await apiService.post(path, { signatureData });
      await loadBusinessInfoCertifyModal();
      setSignModalRole(null);
      refetch();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message || (err as Error)?.message || 'Failed to save signature';
      alert(msg);
    } finally {
      setSignSubmitting(false);
    }
  }, [groupId, signModalRole, loadBusinessInfoCertifyModal, refetch]);

  const formatCertDate = (iso: string | null) => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
    } catch {
      return iso;
    }
  };

  // Show skeleton while loading OR when we have no steps data — but not when a fetch failed (would spin forever)
  const hasStepsData = setupStatus.steps && setupStatus.steps.length > 0;
  const fetchFailed = isError || isSetupStepsError || isAsaError;
  const showSkeleton = !fetchFailed && (isLoading || !hasStepsData);

  const getStepIcon = (iconName: string, completed: boolean, stepNumber?: number, isNextStep?: boolean, canDoStep?: boolean) => {
    // For required steps, show step number
    if (stepNumber && stepNumber <= 3) {
      return (
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            backgroundColor: completed 
              ? 'var(--oe-success)' 
              : isNextStep 
                ? 'var(--oe-warning)'
                : canDoStep 
                  ? 'var(--oe-primary)'
                  : 'var(--color-text-secondary)',
            color: 'white',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: '1.2rem',
            opacity: canDoStep ? 1 : 0.6
          }}
        >
          {completed ? '✓' : stepNumber}
        </Box>
      );
    }

    // For optional steps, show icons
    const iconProps = {
      sx: { 
        fontSize: '1.5rem',
        color: completed 
          ? 'var(--oe-success)' 
          : isNextStep 
            ? 'var(--oe-warning)'
            : 'var(--color-text-secondary)',
        opacity: canDoStep ? 1 : 0.6
      }
    };

    switch (iconName) {
      case 'FileSignature':
        return <AssignmentIcon {...iconProps} />;
      case 'CreditCard':
        return <CreditCardIcon {...iconProps} />;
      case 'People':
        return <PeopleIcon {...iconProps} />;
      case 'Link':
        return <LinkIcon {...iconProps} />;
      case 'AccountBalance':
        return <AccountBalanceIcon {...iconProps} />;
      case 'Rule':
        return <RuleIcon {...iconProps} />;
      default:
        return <CheckCircleIcon {...iconProps} />;
    }
  };

  const getStepColor = (completed: boolean, required: boolean, isNextStep: boolean, canDoStep: boolean) => {
    if (completed) return 'success';
    if (isNextStep) return 'warning';
    if (required && canDoStep) return 'error';
    return 'default';
  };

  const getStepBorderColor = (completed: boolean, required: boolean, isNextStep: boolean, canDoStep: boolean) => {
    if (completed) return 'var(--oe-success)';
    if (isNextStep) return 'var(--oe-warning)';
    if (required && canDoStep) return 'var(--oe-error)';
    return 'var(--color-border)';
  };

  // Skeleton loading component for setup steps - matches real card design
  const SkeletonStepCard = () => (
    <Grid size={{ xs: 12, md: 6, lg: 4 }}>
      <Card
        sx={{
          height: '100%',
          border: '2px solid rgba(0,0,0,0.1)',
          borderRadius: 2,
          opacity: 0.7,
        }}
      >
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={2}>
            {/* Step Header */}
            <Stack direction="row" alignItems="center" spacing={2}>
              <Box sx={{ 
                width: 40, 
                height: 40, 
                borderRadius: '50%', 
                backgroundColor: 'rgba(0,0,0,0.1)', 
                animation: 'pulse 1.5s ease-in-out infinite'
              }} />
              <Box sx={{ flex: 1 }}>
                <Stack direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ 
                    width: 120, 
                    height: 24, 
                    backgroundColor: 'rgba(0,0,0,0.1)', 
                    borderRadius: 1,
                    animation: 'pulse 1.5s ease-in-out infinite'
                  }} />
                  <Box sx={{ 
                    width: 16, 
                    height: 24, 
                    backgroundColor: 'rgba(0,0,0,0.1)', 
                    borderRadius: 1,
                    animation: 'pulse 1.5s ease-in-out infinite'
                  }} />
                </Stack>
              </Box>
            </Stack>
            
            {/* Step Description */}
            <Box sx={{ 
              width: '100%', 
              height: 16, 
              backgroundColor: 'rgba(0,0,0,0.1)', 
              borderRadius: 1,
              animation: 'pulse 1.5s ease-in-out infinite'
            }} />
            <Box sx={{ 
              width: '80%', 
              height: 16, 
              backgroundColor: 'rgba(0,0,0,0.1)', 
              borderRadius: 1,
              animation: 'pulse 1.5s ease-in-out infinite'
            }} />
            
            {/* Step Button */}
            <Box sx={{ 
              width: 100, 
              height: 36, 
              backgroundColor: 'rgba(0,0,0,0.1)', 
              borderRadius: 1,
              mt: 2,
              animation: 'pulse 1.5s ease-in-out infinite'
            }} />
          </Stack>
        </CardContent>
      </Card>
    </Grid>
  );

  if (showSkeleton) {
    return (
      <Box sx={{ p: 3 }}>
        {/* Header */}
        <Box sx={{ mb: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Typography variant="h4" sx={{ fontWeight: 700 }}>
              Group Setup
            </Typography>
            <Box sx={{ 
              width: 80, 
              height: 20, 
              backgroundColor: 'rgba(0,0,0,0.1)', 
              borderRadius: 1,
              animation: 'pulse 1.5s ease-in-out infinite'
            }} />
          </Box>
          
          {/* Progress Bar Skeleton */}
          <Box sx={{ 
            width: '100%', 
            height: 8, 
            backgroundColor: 'rgba(0,0,0,0.1)', 
            borderRadius: 4,
            animation: 'pulse 1.5s ease-in-out infinite'
          }} />
        </Box>
        
        {/* Required Steps Skeleton */}
        <Typography variant="h6" sx={{ mb: 3, color: 'var(--oe-error)', fontWeight: 'bold' }}>
          Required Steps
        </Typography>
        <Grid container spacing={3}>
          <SkeletonStepCard />
          <SkeletonStepCard />
          <SkeletonStepCard />
        </Grid>
        
        {/* Additional Steps Skeleton */}
        <Box sx={{ mt: 6 }}>
          <Typography variant="h6" sx={{ mb: 3, color: 'var(--oe-warning)', fontWeight: 'bold' }}>
            Additional Steps (Recommended)
          </Typography>
          <Grid container spacing={3}>
            <SkeletonStepCard />
            <SkeletonStepCard />
          </Grid>
        </Box>
        
        <style>
          {`
            @keyframes pulse {
              0%, 100% { opacity: 0.4; }
              50% { opacity: 0.8; }
            }
          `}
        </style>
      </Box>
    );
  }

  if (fetchFailed) {
    const primaryMessage =
      error instanceof Error ? error.message : error != null && String(error) !== '' ? String(error) : 'Failed to load setup status';
    const hasApiDetail = !!(setupStepsFetchError || asaFetchError);
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle>Could not load group setup</AlertTitle>
          {setupStepsFetchError && (
            <Typography variant="body2" component="div" sx={{ mt: 0.5, fontFamily: 'monospace', fontSize: '0.8rem' }}>
              <strong>Setup steps API:</strong> {setupStepsFetchError}
            </Typography>
          )}
          {asaFetchError && (
            <Typography variant="body2" component="div" sx={{ mt: 1, fontFamily: 'monospace', fontSize: '0.8rem' }}>
              <strong>ASA status API:</strong> {asaFetchError}
            </Typography>
          )}
          {!hasApiDetail && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              {primaryMessage}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            Check the browser Network tab for <code>/api/groups/…/setup-steps</code> and <code>/asa-status</code>, or ask an admin to review server logs.
          </Typography>
        </Alert>
        <Button
          variant="contained"
          startIcon={<RefreshIcon />}
          onClick={() => refetch()}
          sx={{ textTransform: 'none', bgcolor: 'var(--oe-primary)', '&:hover': { bgcolor: 'var(--oe-primary-dark)' } }}
        >
          Retry
        </Button>
      </Box>
    );
  }


  return (
    <Box sx={{ p: 3 }}>
      {/* Onboarding shortcut - Agent/TenantAdmin/SysAdmin/GroupAdmin - prominent CTA */}
      {onboardingIncomplete && onGoToUsersForOnboarding && (
        <Card
          sx={{
            mb: 3,
            borderRadius: 2,
            border: '2px solid',
            borderColor: 'var(--oe-warning)',
            bgcolor: alpha(theme.palette.warning.main, 0.08),
            overflow: 'hidden',
          }}
        >
          <CardContent sx={{ p: 3 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={2}>
              <Stack direction="row" alignItems="center" spacing={2}>
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: 2,
                    bgcolor: alpha(theme.palette.warning.main, 0.2),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <PeopleIcon sx={{ fontSize: 28, color: 'var(--oe-warning)' }} />
                </Box>
                <Box>
                  <Typography variant="h6" sx={{ fontWeight: 700, color: theme.palette.text.primary }}>
                    Complete group onboarding
                  </Typography>
                  <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                    Send the onboarding link to the primary contact or mark as complete from the Users tab.
                  </Typography>
                </Box>
              </Stack>
              <Button
                variant="contained"
                size="medium"
                onClick={onGoToUsersForOnboarding}
                sx={{
                  textTransform: 'none',
                  fontWeight: 700,
                  px: 3,
                  py: 1.5,
                  bgcolor: 'var(--oe-primary)',
                  '&:hover': { bgcolor: 'var(--oe-primary-dark)' },
                }}
              >
                Go to Users
              </Button>
            </Stack>
          </CardContent>
        </Card>
      )}

      {/* Header */}
      <Box sx={{ mb: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Group Setup
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshIcon />}
              onClick={() => refetch()}
              disabled={isLoading}
              sx={{
                minWidth: 'auto',
                px: 2,
                py: 0.5,
                fontSize: '0.875rem',
                textTransform: 'none',
                borderColor: theme.palette.grey[400],
                color: theme.palette.text.secondary,
                '&:hover': {
                borderColor: 'var(--oe-primary)',
                color: 'var(--oe-primary)',
                backgroundColor: alpha(colors.primary, 0.04)
                }
              }}
            >
              Refresh
            </Button>
            <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontWeight: 600 }}>
              {setupStatus.completionPercentage}% Complete
            </Typography>
          </Box>
        </Box>
        
        {/* Progress Bar */}
        <LinearProgress
          variant="determinate"
          value={setupStatus.completionPercentage}
          sx={{
            height: 8,
            borderRadius: 4,
            backgroundColor: alpha(colors.primary, 0.1),
            '& .MuiLinearProgress-bar': {
              backgroundColor: setupStatus.isSetupComplete 
                ? theme.palette.success.main 
                : 'var(--oe-primary)',
              borderRadius: 4,
            }
          }}
        />

        {/* Status Alert */}
        {setupStatus.isSetupComplete && (
          <Alert severity="success" sx={{ mb: 3 }}>
            <AlertTitle>Setup Complete! 🎉</AlertTitle>
            Your group is fully configured and ready for enrollment.
          </Alert>
        )}
      </Box>

      {/* Required Steps */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 3, color: theme.palette.text.primary }}>
          Required Steps
        </Typography>
        
        {/* Loading Indicator */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 4 }}>
            <CircularProgress size={40} />
            <Typography variant="body1" sx={{ ml: 2, color: theme.palette.text.secondary }}>
              Loading setup status...
            </Typography>
          </Box>
        )}
        
        {/* Steps Grid */}
        {!isLoading && (
          <Grid container spacing={3}>
            {setupStatus.steps.filter(step => step.required).map((step, index) => {
            // Step number is the position in the required steps array (1-based)
            const stepNumber = index + 1;
            const isNextStep = (setupStatus as any)?.nextStep?.id === step.id;
            const canDoStep = true; // All steps can be started in any order

            return (
              <Grid size={{ xs: 12, md: 6, lg: 4 }} key={step.id}>
                <Card
                  sx={{
                    height: '100%',
                    border: `2px solid ${getStepBorderColor(step.completed, step.required, isNextStep, canDoStep)}`,
                    borderRadius: 2,
                    transition: 'all 0.3s ease',
                    opacity: canDoStep ? 1 : 0.6,
                    '&:hover': canDoStep ? {
                      transform: 'translateY(-2px)',
                      boxShadow: theme.shadows[4],
                    } : {},
                    cursor: canDoStep ? 'pointer' : 'not-allowed',
                  }}
                  onClick={() => {
                    if (canDoStep) {
                      if (step.id === 'businessInfo') {
                        setShowBusinessInfoCertifyModal(true);
                        return;
                      }
                      const targetTab = getTabIndexForStep ? getTabIndexForStep(step.id) : step.tabIndex;
                      console.log(`🔍 Card click - Navigating to step "${step.id}" → tab index ${targetTab}`);
                      onTabChange(targetTab);
                    }
                  }}
                >
                  <CardContent sx={{ p: 3 }}>
                    <Stack spacing={2}>
                      {/* Step Header */}
                      <Stack direction="row" alignItems="center" spacing={2}>
                        {getStepIcon(step.icon, step.completed, stepNumber, isNextStep, canDoStep)}
                        <Box sx={{ flex: 1 }}>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <Typography variant="h6" sx={{ fontWeight: 600 }}>
                              {step.title}
                            </Typography>
                            {!step.completed && step.required && (
                              <Typography 
                                variant="h6" 
                                sx={{ 
                                  color: 'var(--oe-error)', 
                                  fontWeight: 700,
                                  fontSize: '1.2rem'
                                }}
                              >
                                *
                              </Typography>
                            )}
                          </Stack>
                          <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            {step.description}
                          </Typography>
                        </Box>
                      </Stack>

                      {/* Step Status */}
                      <Box>
                        <Chip
                          label={step.completed ? 'Completed' : isNextStep ? 'Next Step' : 'Pending'}
                          color={getStepColor(step.completed, step.required, isNextStep, canDoStep) as any}
                          variant={step.completed ? 'filled' : 'outlined'}
                          size="small"
                        />
                      </Box>

                      {/* Action Buttons */}
                      <Button
                        variant={step.completed ? 'outlined' : 'contained'}
                        fullWidth
                        disabled={!canDoStep}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (canDoStep) {
                            if (step.id === 'businessInfo') {
                              setShowBusinessInfoCertifyModal(true);
                              return;
                            }
                            const targetTab = getTabIndexForStep ? getTabIndexForStep(step.id) : step.tabIndex;
                            console.log(`🔍 Navigating to step "${step.id}" → tab index ${targetTab}`);
                            onTabChange(targetTab);
                          }
                        }}
                          sx={{
                            textTransform: 'none',
                            fontWeight: 600,
                            borderRadius: 2,
                            py: 1.5,
                            opacity: canDoStep ? 1 : 0.5,
                            ...(step.completed ? {
                              borderColor: 'var(--oe-primary)',
                              color: 'var(--oe-primary)',
                              '&:hover': {
                                borderColor: 'var(--oe-primary-dark)',
                                color: 'var(--oe-primary-dark)',
                                backgroundColor: alpha(colors.primary, 0.04)
                              }
                            } : {
                              bgcolor: 'var(--oe-primary)',
                              '&:hover': {
                                bgcolor: 'var(--oe-primary-dark)',
                              }
                            }),
                          }}
                        >
                          {step.completed ? 'Review' : 'Begin Setup'}
                        </Button>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>
        )}
      </Box>

      {/* Additional Optional Steps */}
      <Box sx={{ mb: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 3, color: theme.palette.text.primary }}>
          Additional Steps (Recommended)
        </Typography>
        
        {/* Loading Indicator */}
        {isLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 4 }}>
            <CircularProgress size={40} />
            <Typography variant="body1" sx={{ ml: 2, color: theme.palette.text.secondary }}>
              Loading optional steps...
            </Typography>
          </Box>
        )}
        
        {/* Optional Steps Grid */}
        {!isLoading && (
          <Grid container spacing={3}>
            {setupStatus.steps.filter(step => !step.required).map((step, index) => {
          const isNextStep = (setupStatus as any)?.nextStep?.id === step.id;
          const canDoStep = true; // Optional steps are always available
            
            return (
              <Grid size={{ xs: 12, md: 6, lg: 4 }} key={step.id}>
                <Card
                  sx={{
                    height: '100%',
                    border: `2px solid ${getStepBorderColor(step.completed, step.required, isNextStep, canDoStep)}`,
                    borderRadius: 2,
                    transition: 'all 0.3s ease',
                    '&:hover': {
                      transform: 'translateY(-2px)',
                      boxShadow: theme.shadows[4],
                    },
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    const targetTab = getTabIndexForStep ? getTabIndexForStep(step.id) : step.tabIndex;
                    console.log(`🔍 Optional step card click - Navigating to step "${step.id}" → tab index ${targetTab}`);
                    onTabChange(targetTab);
                  }}
                >
                  <CardContent sx={{ p: 3 }}>
                    <Stack spacing={2}>
                      {/* Step Header */}
                      <Stack direction="row" alignItems="center" spacing={2}>
                        {getStepIcon(step.icon, step.completed, undefined, isNextStep, true)}
                        <Box sx={{ flex: 1 }}>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <Typography variant="h6" sx={{ fontWeight: 600 }}>
                              {step.title}
                            </Typography>
                            <Chip
                              label="Recommended"
                              size="small"
                              color="info"
                              variant="outlined"
                            />
                          </Stack>
                          <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            {step.description}
                          </Typography>
                        </Box>
                      </Stack>

                      {/* Step Status */}
                      <Box>
                        <Chip
                          label={step.completed ? 'Completed' : isNextStep ? 'Next Step' : 'Pending'}
                          color={getStepColor(step.completed, step.required, isNextStep, canDoStep) as any}
                          variant={step.completed ? 'filled' : 'outlined'}
                          size="small"
                        />
                      </Box>

                      {/* Action Buttons */}
                      <Button
                        variant={step.completed ? 'outlined' : 'contained'}
                        fullWidth
                        onClick={(e) => {
                          e.stopPropagation();
                          const targetTab = getTabIndexForStep ? getTabIndexForStep(step.id) : step.tabIndex;
                          console.log(`🔍 Navigating to step "${step.id}" → tab index ${targetTab}`);
                          onTabChange(targetTab);
                        }}
                        sx={{
                          textTransform: 'none',
                          fontWeight: 600,
                          borderRadius: 2,
                          py: 1.5,
                          ...(step.completed ? {
                            borderColor: 'var(--oe-primary)',
                            color: 'var(--oe-primary)',
                            '&:hover': {
                              borderColor: 'var(--oe-primary-dark)',
                              color: 'var(--oe-primary-dark)',
                              backgroundColor: alpha(colors.primary, 0.04)
                            }
                          } : {
                            bgcolor: 'var(--oe-primary)',
                            '&:hover': {
                              bgcolor: 'var(--oe-primary-dark)',
                            }
                          }),
                        }}
                      >
                        {step.completed ? 'Review' : 'Begin Setup'}
                      </Button>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            );
          })}
        </Grid>
        )}
      </Box>

      {/* Combined Complete Business Info & Sign modal */}
      <Dialog open={showBusinessInfoCertifyModal} onClose={() => setShowBusinessInfoCertifyModal(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Complete Business Info &amp; Sign</DialogTitle>
        <DialogContent>
          {businessInfoCertifyLoading ? (
            <Box sx={{ py: 3, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress />
            </Box>
          ) : (
            <Stack spacing={2} sx={{ pt: 1 }}>
              <Box>
                <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>Required group info</Typography>
                <Stack spacing={0.5} sx={{ mb: 1 }}>
                  {(() => {
                    const g = businessInfoCertifyGroup as Record<string, unknown> | null;
                    const val = (k: string) => g?.[k] ?? g?.[k.charAt(0).toLowerCase() + k.slice(1)];
                    const has = (v: unknown) => v != null && String(v).trim() !== '';
                    const items = [
                      { key: 'ein', label: 'EIN (Tax ID)', done: has(val('TaxIdNumber')) },
                      { key: 'primaryContact', label: 'Primary contact name', done: has(val('PrimaryContact')) },
                      { key: 'contactEmail', label: 'Primary contact email', done: has(val('ContactEmail')) },
                      { key: 'contactPhone', label: 'Primary contact phone', done: has(val('ContactPhone')) },
                      { key: 'address', label: 'Address', done: has(val('Address')) },
                    ];
                    return items.map((item) => (
                      <FormControlLabel
                        key={item.key}
                        control={<Checkbox checked={item.done} disabled size="small" sx={{ py: 0 }} />}
                        label={<Typography variant="body2" color={item.done ? 'text.primary' : 'text.secondary'}>{item.label}</Typography>}
                        sx={{ m: 0, alignItems: 'flex-start' }}
                      />
                    ));
                  })()}
                </Stack>
                {onEditGroup && (
                  <Button size="small" variant="outlined" onClick={() => { onEditGroup(); setShowBusinessInfoCertifyModal(false); }} sx={{ textTransform: 'none' }}>
                    Edit business info
                  </Button>
                )}
              </Box>
              <Box>
                {businessInfoCertifyCertification?.signaturesRequired === false ? (
                  <Typography variant="body2" color="text.secondary">
                    Signatures not required for this group (no vendor form is configured with signature fields).
                  </Typography>
                ) : (
                  <>
                    <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>Signatures</Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                      One signature is reused for all vendor forms that require it (one sign covers every vendor).
                    </Typography>
                    <Stack spacing={1.5}>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, p: 1.5, bgcolor: alpha(theme.palette.background.paper, 0.5), borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                        <Typography variant="body2">Agent</Typography>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          {businessInfoCertifyCertification?.agentHasSignature ? (
                            <Typography variant="body2" color="success.main">Signed {formatCertDate(businessInfoCertifyCertification.agentSignedAt) ?? ''}</Typography>
                          ) : (
                            <Typography variant="body2" color="text.secondary">Not signed</Typography>
                          )}
                          {canSignAsAgent && (
                            <Button size="small" variant="outlined" onClick={() => setSignModalRole('agent')}>
                              {businessInfoCertifyCertification?.agentHasSignature ? 'Re-sign' : 'Sign'}
                            </Button>
                          )}
                        </Stack>
                      </Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1, p: 1.5, bgcolor: alpha(theme.palette.background.paper, 0.5), borderRadius: 1, border: '1px solid', borderColor: 'divider' }}>
                        <Typography variant="body2">Group Admin</Typography>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          {businessInfoCertifyCertification?.groupAdminHasSignature ? (
                            <Typography variant="body2" color="success.main">Signed {formatCertDate(businessInfoCertifyCertification.groupAdminSignedAt) ?? ''}</Typography>
                          ) : (
                            <Typography variant="body2" color="text.secondary">Not signed</Typography>
                          )}
                          {canSignAsGroupAdmin && (
                            <Button size="small" variant="outlined" onClick={() => setSignModalRole('group-admin')}>
                              {businessInfoCertifyCertification?.groupAdminHasSignature ? 'Re-sign' : 'Sign'}
                            </Button>
                          )}
                        </Stack>
                      </Box>
                    </Stack>
                  </>
                )}
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Box sx={{ flex: 1 }} />
          <Button variant="outlined" onClick={() => setShowBusinessInfoCertifyModal(false)} sx={{ textTransform: 'none' }}>Close</Button>
          <Button variant="contained" onClick={() => { setShowBusinessInfoCertifyModal(false); const tab = getTabIndexForStep?.('businessInfo'); if (typeof tab === 'number') onTabChange(tab); }} sx={{ textTransform: 'none', bgcolor: 'var(--oe-primary)', '&:hover': { bgcolor: 'var(--oe-primary-dark)' } }}>
            Edit Group Info
          </Button>
        </DialogActions>
      </Dialog>

      {signModalRole && (
        <NewGroupFormCertificationSignModal
          title={signModalRole === 'agent' ? 'Agent Signature' : 'Group Admin Signature'}
          onConfirm={handleCertificationSign}
          onClose={() => setSignModalRole(null)}
          loading={signSubmitting}
        />
      )}

    </Box>
  );
};

export default GroupSetupTab;
