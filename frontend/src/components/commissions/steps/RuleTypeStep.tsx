// src/components/commissions/steps/RuleTypeStep.tsx
import {
    ShowChart as ChartIcon,
    Layers as LayersIcon,
    AttachMoney as MoneyIcon,
    Percent as PercentIcon,
    Person as PersonIcon
} from '@mui/icons-material';
import {
    Autocomplete,
    Box,
    Card,
    CardContent,
    Chip,
    CircularProgress,
    FormControl,
    FormHelperText,
    Grid,
    InputLabel,
    MenuItem,
    Select,
    TextField,
    Typography
} from '@mui/material';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { apiService } from '../../../services/api.service';
import { RuleCreationFormData } from '../RuleCreationWizard';
import { COMMISSION_TIER_LEVELS } from '../../../constants/form-options';

// Get current user info
const getCurrentUser = () => {
  const storedRoles = localStorage.getItem('roles');
  const roles = storedRoles ? JSON.parse(storedRoles) : [];
  const currentRole = localStorage.getItem('currentRole') || roles[0] || null;
  const tenantId = localStorage.getItem('currentTenantId') || localStorage.getItem('tenantId');
  const userId = localStorage.getItem('userId');
  return { roles, currentRole, tenantId, userId };
};

interface Tenant {
  TenantId: string;
  Name: string;
  Status: string;
}

interface Group {
  GroupId: string;
  Name: string;
  Status: string;
}


interface RuleTypeStepProps {
  compact?: boolean;
}

export const RuleTypeStep: React.FC<RuleTypeStepProps> = ({ compact = false }) => {
  const { control, watch, setValue } = useFormContext<RuleCreationFormData>();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [tenantError, setTenantError] = useState<string | null>(null);
  const fetchTenantsAbortControllerRef = useRef<AbortController | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupError, setGroupError] = useState<string | null>(null);
  const fetchGroupsAbortControllerRef = useRef<AbortController | null>(null);
  const [agentLevelOptions, setAgentLevelOptions] = useState<Array<{ value: number; label: string }>>([]);
  const [loadingAgentLevels, setLoadingAgentLevels] = useState(false);
  
  const selectedEntityType = watch('entityType');
  const selectedCommissionType = watch('commissionType');
  const selectedTenantId = watch('tenantId');
  const currentTierLevel = watch('tierLevel');
  const isLocked = false;
  
  // Memoize currentUser to prevent infinite loops
  const currentUser = useMemo(() => getCurrentUser(), []);
  const isSysAdmin = useMemo(() => currentUser.currentRole === 'SysAdmin', []);

  // Fetch tenants when component mounts (only for SysAdmin)
  useEffect(() => {
    if (isSysAdmin) {
      fetchTenants();
    }
    
    // Cleanup: abort request if component unmounts
    return () => {
      if (fetchTenantsAbortControllerRef.current) {
        fetchTenantsAbortControllerRef.current.abort();
      }
    };
  }, [isSysAdmin]);

  // Fetch groups when entity type is Split
  useEffect(() => {
    if (selectedEntityType === 'Split') {
      if (isSysAdmin) {
        if (selectedTenantId) {
          fetchGroups(selectedTenantId);
        } else {
          setGroups([]);
          setValue('groupId', '', { shouldDirty: false });
        }
      } else {
        fetchGroups();
      }
    } else {
      setGroups([]);
      setValue('groupId', '', { shouldDirty: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEntityType, selectedTenantId, isSysAdmin]);

  useEffect(() => {
    const fetchAgentLevels = async () => {
      const targetTenantId = isSysAdmin ? selectedTenantId : currentUser.tenantId;
      if (!targetTenantId) {
        setAgentLevelOptions([]);
        return;
      }
      try {
        setLoadingAgentLevels(true);
        const query = isSysAdmin ? `?tenantId=${targetTenantId}` : '';
        const response: any = await apiService.get(`/api/tenant-admin/commission-levels${query}`);
        if (response?.success && Array.isArray(response.data)) {
          const options = response.data
            .filter((level: any) => level?.IsActive !== false)
            .map((level: any) => ({
              value: Number(level.SortOrder),
              label: `${level.DisplayName || `Level ${level.SortOrder}`} (Level ${level.SortOrder})`
            }))
            .filter((level: any) => Number.isFinite(level.value))
            .sort((a: any, b: any) => a.value - b.value);
          setAgentLevelOptions(options);
        } else {
          setAgentLevelOptions([]);
        }
      } catch {
        setAgentLevelOptions([]);
      } finally {
        setLoadingAgentLevels(false);
      }
    };

    fetchAgentLevels();
  }, [isSysAdmin, selectedTenantId, currentUser.tenantId]);

  const fetchGroups = async (tenantId?: string) => {
    if (fetchGroupsAbortControllerRef.current) {
      fetchGroupsAbortControllerRef.current.abort();
    }
    const abortController = new AbortController();
    fetchGroupsAbortControllerRef.current = abortController;
    try {
      setLoadingGroups(true);
      setGroupError(null);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => { if (!abortController.signal.aborted) reject(new Error('Request timeout')); }, 8000);
      });
      const apiUrl = tenantId ? `/api/groups?tenantId=${tenantId}` : `/api/groups`;
      const response: any = await Promise.race([apiService.get(apiUrl), timeoutPromise]);
      if (abortController.signal.aborted) return;
      if (response?.success && Array.isArray(response.data)) {
        const activeGroups = response.data.filter((g: any) => g.Status === 'Active' || g.status === 'Active');
        setGroups(activeGroups);
        setGroupError(null);
      } else {
        setGroups([]);
        setGroupError('Unexpected response format from server');
      }
    } catch (error: any) {
      if (abortController.signal.aborted) return;
      setGroupError(error?.message === 'Request timeout' ? 'Unable to load groups.' : `Failed to load groups: ${error?.message || 'Unknown error'}`);
      setGroups([]);
    } finally {
      if (!abortController.signal.aborted) setLoadingGroups(false);
    }
  };

  const fetchTenants = async () => {
    // Cancel any existing request
    if (fetchTenantsAbortControllerRef.current) {
      fetchTenantsAbortControllerRef.current.abort();
    }
    
    // Create new abort controller for cleanup tracking
    const abortController = new AbortController();
    fetchTenantsAbortControllerRef.current = abortController;
    
    try {
      setLoadingTenants(true);
      setTenantError(null);
      
      // Create a timeout promise that rejects after 8 seconds
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          if (!abortController.signal.aborted) {
            reject(new Error('Request timeout'));
          }
        }, 8000);
      });
      
      // Use lightweight mode for dropdown - just TenantId, Name, Status
      // This is much faster than the full detailed query
      // Race between the API call and timeout
      const response: any = await Promise.race([
        apiService.get('/api/tenants?lightweight=true'),
        timeoutPromise
      ]);
      
      // Check if request was aborted (component unmounted)
      if (abortController.signal.aborted) {
        return;
      }
      
      // Handle the response structure based on backend pattern
      if (response && response.success && Array.isArray(response.data)) {
        // Filter only active tenants
        const activeTenants = response.data.filter((t: any) => 
          t.Status === 'Active' || t.status === 'Active'
        );
        setTenants(activeTenants);
        setTenantError(null);
      } else if (response && response.success && response.tenants && Array.isArray(response.tenants)) {
        // Alternative response structure
        const activeTenants = response.tenants.filter((t: any) => 
          t.Status === 'Active' || t.status === 'Active'
        );
        setTenants(activeTenants);
        setTenantError(null);
      } else {
        setTenants([]);
        setTenantError('Unexpected response format from server');
      }
    } catch (error: any) {
      // Don't process errors if request was aborted (component unmounted)
      if (abortController.signal.aborted) {
        return;
      }
      
      // Silently handle timeout or network errors - don't spam console
      // The error state will be shown in the UI instead
      const isTimeout = error?.message === 'Request timeout' || 
                       error?.code === 'NETWORK_ERROR' || 
                       error?.message?.includes('timeout');
      
      if (isTimeout) {
        setTenantError('Unable to load tenants. The backend may be unavailable. You can still proceed and select a tenant later.');
      } else {
        setTenantError('Failed to load tenants. Please try again later.');
      }
      setTenants([]);
    } finally {
      // Only update loading state if component is still mounted
      if (!abortController.signal.aborted) {
        setLoadingTenants(false);
      }
    }
  };

  // Entity type options
  const entityTypes = [
    {
      value: 'Tier' as const,
      label: 'Agent Level Based',
      description: 'Multi-level commission structure by agent level hierarchy',
      icon: <LayersIcon color="primary" />,
    },
    {
      value: 'Split' as const,
      label: 'Split Commission',
      description: 'Commission split between primary agent and multiple other agents',
      icon: <PersonIcon color="primary" />,
    },
  ];

  // Commission type options
  const commissionTypes = [
    {
      value: 'Tiered' as const,
      label: 'Tiered Structure',
      description: 'Different rates based on volume or performance',
      icon: <ChartIcon />,
    },
    {
      value: 'Percentage' as const,
      label: 'Percentage',
      description: 'Commission calculated as percentage of premium',
      icon: <PercentIcon />,
    },
    {
      value: 'Flat' as const,
      label: 'Flat Amount',
      description: 'Fixed dollar amount per enrollment',
      icon: <MoneyIcon />,
    },
    {
      value: 'Split' as const,
      label: 'Split Commission',
      description: 'Commission split between primary agent and multiple other agents',
      icon: <PersonIcon />,
    },
  ];

  // Agent levels for agent-level-based commission (tenant scoped, with legacy fallback).
  const tierLevels = agentLevelOptions.length > 0
    ? agentLevelOptions
    : COMMISSION_TIER_LEVELS.map(tier => ({
      value: tier.level,
      label: `${tier.name} (Level ${tier.level})`
    }));

  // Set tierLevel to 0 when Tier entity type is selected
  useEffect(() => {
    if (selectedEntityType !== 'Tier') return;
    const hasCurrent = tierLevels.some((l) => Number(l.value) === Number(currentTierLevel));
    if (currentTierLevel === undefined || currentTierLevel === null || !hasCurrent) {
      setValue('tierLevel', tierLevels[0]?.value ?? 0);
    }
  }, [selectedEntityType, currentTierLevel, setValue, tierLevels]);

  // Auto-set commissionType when entityType changes
  useEffect(() => {
    if (selectedEntityType === 'Split' && selectedCommissionType !== 'Split') {
      // Split Commission Scope can only use Split Type
      setValue('commissionType', 'Split');
    } else if (selectedEntityType === 'Tier' && selectedCommissionType === 'Split') {
      // Agent Level Based can use Tiered, Percentage, or Flat — not Split
      setValue('commissionType', 'Tiered');
    } else if (selectedEntityType !== 'Split' && selectedCommissionType === 'Split') {
      // Reset to Tiered if entityType is not Split
      setValue('commissionType', 'Tiered');
    } else if (selectedEntityType !== 'Tier' && selectedCommissionType === 'Tiered') {
      // Reset to Tiered default for compatible entity types
      setValue('commissionType', 'Tiered');
    }
  }, [selectedEntityType, selectedCommissionType, setValue]);


  return (
    <Box>
      {!compact && (
        <>
          <Typography variant="h6" gutterBottom>
            Configure Rule Type
          </Typography>
          <Typography variant="body2" color="textSecondary" gutterBottom>
            Define the basic properties and structure of your commission rule
          </Typography>
        </>
      )}

      <Grid container spacing={3} sx={{ mt: 1 }}>
        {/* Tenant Selection - Show for SysAdmin */}
        {isSysAdmin && (
          <Grid size={12}>
            <Controller
              name="tenantId"
              control={control}
              render={({ field, fieldState }) => (
                <>
                  <Autocomplete
                    {...field}
                    options={tenants}
                    getOptionLabel={(option) => option.Name || ''}
                    loading={loadingTenants}
                    disabled={loadingTenants || isLocked}
                    value={tenants.find(t => t.TenantId === field.value) || null}
                    onChange={(_, newValue) => {
                      field.onChange(newValue?.TenantId || '');
                    }}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Select Tenant"
                        error={!!fieldState.error || !!tenantError}
                        helperText={
                          fieldState.error?.message || 
                          tenantError || 
                          'Type to search for a tenant'
                        }
                        required
                        InputProps={{
                          ...params.InputProps,
                          endAdornment: (
                            <>
                              {loadingTenants ? <CircularProgress color="inherit" size={20} /> : null}
                              {params.InputProps.endAdornment}
                            </>
                          ),
                        }}
                      />
                    )}
                    renderOption={(props, option) => (
                      <Box component="li" {...props}>
                        <Box>
                          <Typography variant="body1">{option.Name}</Typography>
                          <Typography variant="caption" color="textSecondary">
                            ID: {option.TenantId}
                          </Typography>
                        </Box>
                      </Box>
                    )}
                    noOptionsText={
                      loadingTenants 
                        ? "Loading tenants..." 
                        : tenantError 
                        ? tenantError 
                        : "No tenants found"
                    }
                    isOptionEqualToValue={(option, value) => option.TenantId === value.TenantId}
                  />
                  {tenantError && !loadingTenants && (
                    <FormHelperText error sx={{ mt: 1 }}>
                      {tenantError}
                    </FormHelperText>
                  )}
                </>
              )}
            />
          </Grid>
        )}

        {/* Scope Selection */}
        <Grid size={12}>
          <Typography variant="subtitle2" gutterBottom>
            Scope
          </Typography>
          <Controller
            name="entityType"
            control={control}
            render={({ field, fieldState }) => (
              <>
                <Grid container spacing={2}>
                  {entityTypes.map((type) => (
                    <Grid size={{ xs: 12, sm: 6, md: compact ? 4 : 4 }} key={type.value}>
                      <Card
                        sx={{
                          cursor: isLocked ? 'not-allowed' : 'pointer',
                          border: selectedEntityType === type.value ? 2 : 1,
                          borderColor: selectedEntityType === type.value 
                            ? 'primary.main' 
                            : 'divider',
                          transition: 'all 0.2s',
                          opacity: isLocked ? 0.6 : 1,
                          '&:hover': {
                            borderColor: isLocked ? 'divider' : 'primary.main',
                            boxShadow: isLocked ? 0 : 2,
                          },
                        }}
                        onClick={() => {
                          if (!isLocked) field.onChange(type.value);
                        }}
                      >
                        <CardContent sx={{ py: compact ? 1 : 2, '&:last-child': { pb: compact ? 1 : 2 } }}>
                          <Box display="flex" alignItems="center" gap={1}>
                            {type.icon}
                            <Typography variant={compact ? 'body2' : 'subtitle1'} fontWeight="bold">
                              {type.label}
                            </Typography>
                          </Box>
                          {!compact && (
                            <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5 }}>
                              {type.description}
                            </Typography>
                          )}
                        </CardContent>
                      </Card>
                    </Grid>
                  ))}
                </Grid>
                {fieldState.error && (
                  <FormHelperText error>
                    {fieldState.error.message}
                  </FormHelperText>
                )}
              </>
            )}
          />
        </Grid>

        {/* Type Selection */}
        <Grid size={12}>
          <Typography variant="subtitle2" gutterBottom>
            Type
          </Typography>
          <Controller
            name="commissionType"
            control={control}
            render={({ field, fieldState }) => (
              <>
                <Grid container spacing={2}>
                  {commissionTypes.map((type) => {
                    // Define which commission types are allowed for each entity type
                    let isDisabled = false;
                    
                    if (selectedEntityType === 'Tier') {
                      // Tier-Based can use Percentage, Flat (single tier), or Tiered Structure — not Split
                      isDisabled = type.value === 'Split';
                    } else if (selectedEntityType === 'Split') {
                      // Split Commission Scope can only use Split Type
                      isDisabled = type.value !== 'Split';
                    } else if (selectedEntityType === 'Agent' || selectedEntityType === 'Agency') {
                      // Agent and Agency can only use Percentage or Flat Amount
                      isDisabled = type.value !== 'Percentage' && type.value !== 'Flat';
                    }
                    
                    return (
                      <Grid size={{ xs: 12, sm: 6, md: compact ? 4 : 4 }} key={type.value}>
                        <Card
                          sx={{
                            cursor: (isDisabled || isLocked) ? 'not-allowed' : 'pointer',
                            border: selectedCommissionType === type.value ? 2 : 1,
                            borderColor: selectedCommissionType === type.value 
                              ? 'primary.main' 
                              : 'divider',
                            transition: 'all 0.2s',
                            opacity: (isDisabled || isLocked) ? 0.5 : 1,
                            backgroundColor: (isDisabled || isLocked) ? 'action.disabledBackground' : 'background.paper',
                            '&:hover': {
                              borderColor: (isDisabled || isLocked) ? 'divider' : 'primary.main',
                              boxShadow: (isDisabled || isLocked) ? 0 : 2,
                            },
                          }}
                          onClick={() => {
                            if (!isDisabled && !isLocked) {
                              field.onChange(type.value);
                            }
                          }}
                        >
                        <CardContent>
                          <Box display="flex" alignItems="center" gap={1} mb={1}>
                            {type.icon}
                            <Typography variant="subtitle1" fontWeight="bold">
                              {type.label}
                            </Typography>
                          </Box>
                          <Typography variant="body2" color="textSecondary">
                            {type.description}
                          </Typography>
                        </CardContent>
                        {isDisabled && (
                          <Box sx={{ p: 1, bgcolor: 'warning.light', textAlign: 'center' }}>
                            <Typography variant="caption" color="warning.dark">
                              {selectedEntityType === 'Tier' && 'Not available for Agent Level Based (use Percentage, Flat, or Tiered Structure)'}
                              {selectedEntityType === 'Split' && 'Not available for Split Commission entity type'}
                            </Typography>
                          </Box>
                        )}
                      </Card>
                    </Grid>
                    );
                  })}
                </Grid>
                {fieldState.error && (
                  <FormHelperText error>
                    {fieldState.error.message}
                  </FormHelperText>
                )}
              </>
            )}
          />
        </Grid>

        {/* Tier Level Selection - Only for single-tier rules (Percentage or Flat). Shown directly under Type. Hidden when Tiered Structure is selected. */}
        {selectedEntityType === 'Tier' && selectedCommissionType !== 'Tiered' && (
          <Grid size={12}>
            <Typography variant="subtitle2" gutterBottom>
              Agent Level
            </Typography>
            <Typography variant="body2" color="textSecondary" sx={{ mb: 1 }}>
              Which agent level receives this commission (e.g. selling agent level, then upline levels).
            </Typography>
            <Controller
              name="tierLevel"
              control={control}
              defaultValue={0}
              render={({ field, fieldState }) => (
                <FormControl fullWidth error={!!fieldState.error} sx={{ maxWidth: 400 }}>
                  <InputLabel>Agent Level</InputLabel>
                  <Select
                    {...field}
                    value={field.value ?? 0}
                    label="Agent Level"
                    disabled={isLocked || loadingAgentLevels || (isSysAdmin && !selectedTenantId)}
                  >
                    {tierLevels.map((level) => (
                      <MenuItem key={level.value} value={level.value}>
                        {level.label}
                      </MenuItem>
                    ))}
                  </Select>
                  <FormHelperText>
                    {fieldState.error?.message
                      || (isSysAdmin && !selectedTenantId
                        ? 'Select a tenant first to load agent levels'
                        : loadingAgentLevels
                          ? 'Loading agent levels...'
                          : 'Select the agent level for this commission rule')}
                  </FormHelperText>
                </FormControl>
              )}
            />
          </Grid>
        )}

        {/* Group Selection - Required for Split rules */}
        {selectedEntityType === 'Split' && (
          <Grid size={12}>
            <Controller
              name="groupId"
              control={control}
              render={({ field, fieldState }) => (
                <>
                  <Typography variant="subtitle2" gutterBottom>
                    Group (required)
                  </Typography>
                  <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mb: 1 }}>
                    
                  </Typography>
                  <Autocomplete
                    options={groups}
                    getOptionLabel={(option) => option.Name || ''}
                    loading={loadingGroups}
                    disabled={loadingGroups || (isSysAdmin && !selectedTenantId) || isLocked}
                    value={groups.find(g => g.GroupId === field.value) || null}
                    onChange={(_, newValue) => {
                      field.onChange(newValue?.GroupId || '');
                    }}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Select Group"
                        error={!!fieldState.error || !!groupError}
                        helperText={
                          fieldState.error?.message ||
                          groupError ||
                          (isSysAdmin && !selectedTenantId ? 'Please select a tenant first' : 'Type to search for a group')
                        }
                        required
                        InputProps={{
                          ...params.InputProps,
                          endAdornment: (
                            <>
                              {loadingGroups ? <CircularProgress color="inherit" size={20} /> : null}
                              {params.InputProps.endAdornment}
                            </>
                          ),
                        }}
                      />
                    )}
                    renderOption={(props, option) => (
                      <Box component="li" {...props} key={`group-${option.GroupId}`}>
                        <Box>
                          <Typography variant="body1">{option.Name}</Typography>
                          <Typography variant="caption" color="textSecondary">
                            ID: {option.GroupId}
                          </Typography>
                        </Box>
                      </Box>
                    )}
                    noOptionsText={
                      isSysAdmin && !selectedTenantId
                        ? 'Please select a tenant first'
                        : loadingGroups
                        ? 'Loading groups...'
                        : groupError
                        ? groupError
                        : 'No groups found'
                    }
                    isOptionEqualToValue={(option, value) => option.GroupId === value.GroupId}
                  />
                </>
              )}
            />
          </Grid>
        )}

        {/* Current Selections Summary */}
        {(selectedEntityType || selectedCommissionType) && (
          <Grid size={12}>
            <Box sx={{ mt: 2, p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
              <Typography variant="subtitle2" gutterBottom>
                Current Selections:
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {selectedEntityType && (
                  <Chip 
                    label={`Entity: ${selectedEntityType === 'Tier' ? 'Agent Level Based' : selectedEntityType}`} 
                    size="small" 
                    color="secondary" 
                  />
                )}
                {selectedEntityType === 'Tier' && selectedCommissionType !== 'Tiered' && currentTierLevel !== undefined && (
                  <Chip 
                    label={`Agent Level: ${tierLevels.find(l => l.value === currentTierLevel)?.label || 'Agent (Level 0)'}`} 
                    size="small" 
                    color="secondary" 
                  />
                )}
                {selectedCommissionType && (
                  <Chip 
                    label={`Type: ${selectedCommissionType}`} 
                    size="small" 
                    color="secondary" 
                  />
                )}
              </Box>
            </Box>
          </Grid>
        )}
      </Grid>
    </Box>
  );
};