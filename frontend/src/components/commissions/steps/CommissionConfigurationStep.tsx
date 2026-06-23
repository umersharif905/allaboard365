// src/components/commissions/steps/CommissionConfigurationStep.tsx
import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useFormContext, Controller, useFieldArray, useWatch } from 'react-hook-form';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  Button,
  IconButton,
  Grid,
  Card,
  CardContent,
  Alert,
  Tooltip,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormHelperText,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  DragIndicator as DragIcon,
  Info as InfoIcon,
} from '@mui/icons-material';
import { RuleCreationFormData } from '../RuleCreationWizard';
import {
  COMMISSION_NESTED_DIALOG_Z,
  commissionDialogSlotProps,
} from '../commissionDialogZIndex';
import { apiService } from '../../../services/api.service';
import { COMMISSION_TIER_LEVELS } from '../../../constants/form-options';
import { useProductCommissionPoolCaps } from '../../../hooks/useProductCommissionPoolCaps';
import {
  buildSimpleFlatWarnings,
  buildSimplePercentageWarnings,
  buildTieredCommissionPoolWarnings,
  FAMILY_TIER_CODES,
  getGlobalMaxCommissionPool,
  toMoneyNumber,
} from '../../../utils/productCommissionPoolCaps';

const ALL_PRODUCTS_GUID = '00000000-0000-0000-0000-000000000000';

interface Agent {
  AgentId: string;
  FirstName: string;
  LastName: string;
  Email: string;
}

interface TierLevelOption {
  level: number;
  name: string;
}

interface CommissionConfigurationStepProps {
  isEditMode?: boolean;
  /**
   * When true, do NOT auto-populate tiers with every tenant tier level on open.
   * Used by mass-update flows where the admin should only add the specific tier(s) they want to modify.
   * Also changes the "Reset" button to clear the tiers array entirely instead of blanking values.
   */
  skipAutoInit?: boolean;
  /** Hides verbose inline help; details behind info icon (hover/click). */
  compactMode?: boolean;
  /** Render Select menus inside parent dialog (fixes z-index with portaled modals). */
  inModal?: boolean;
}

export const CommissionConfigurationStep: React.FC<CommissionConfigurationStepProps> = ({
  isEditMode = false,
  skipAutoInit = false,
  compactMode = false,
  inModal = false,
}) => {
  const [tierHelpOpen, setTierHelpOpen] = useState(false);
  const selectMenuProps = inModal ? { slotProps: commissionDialogSlotProps(COMMISSION_NESTED_DIALOG_Z) } : undefined;
  const { control, watch, setValue, getValues } = useFormContext<RuleCreationFormData>();
  const productId = useWatch({ control, name: 'productId' }) ?? '';
  const watchedTiers =
    (useWatch({ control, name: 'tiers', defaultValue: [] }) ?? []) as NonNullable<
      RuleCreationFormData['tiers']
    >;
  const watchedRate = useWatch({ control, name: 'rate' });
  const watchedAmount = useWatch({ control, name: 'amount' });
  const commissionType = useWatch({ control, name: 'commissionType' });
  const commissionTypeType = useWatch({ control, name: 'type' });
  const selectedTenantId = useWatch({ control, name: 'tenantId' });
  const {
    caps: productCommissionCaps,
    isLoading: capsLoading,
    isFetched: capsFetched,
  } = useProductCommissionPoolCaps(productId);
  // Locked rules remain editable here; TenantAdmin/SysAdmin updates are allowed (see API).
  const isLocked = false;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [tenantTierLevels, setTenantTierLevels] = useState<TierLevelOption[]>([]);
  const [tenantLevelsResolved, setTenantLevelsResolved] = useState(false);
  const initialTierValuesRef = useRef<any[] | null>(null);
  const initializedRef = useRef(false);
  const [addTierModalOpen, setAddTierModalOpen] = useState(false);

  // Helper function to convert percentage string to decimal with proper rounding
  const percentageToDecimal = (percentageStr: string): number | undefined => {
    if (!percentageStr || percentageStr === '') return undefined;
    const numValue = parseFloat(percentageStr);
    if (isNaN(numValue)) return undefined;
    // Round to 4 decimal places to avoid floating point errors, then convert to decimal
    return Math.round(numValue * 10000) / 1000000;
  };

  // Helper function to convert decimal to percentage string with proper rounding
  const decimalToPercentage = (decimal: number): string => {
    if (decimal === undefined || decimal === null) return '';
    // Allow 0 to be displayed as "0"
    if (decimal === 0) return '0';
    // Round to 2 decimal places for display
    return (Math.round(decimal * 10000) / 100).toFixed(2).replace(/\.?0+$/, '');
  };
  
  const { fields, remove } = useFieldArray({
    control,
    name: 'tiers',
  });

  const { 
    fields: splitAgentFields, 
    append: appendSplitAgent, 
    remove: removeSplitAgent 
  } = useFieldArray({
    control,
    name: 'splitCommission.agents',
  });

  const availableTierLevels: TierLevelOption[] = useMemo(() => (
    tenantTierLevels.length > 0
      ? tenantTierLevels
      : tenantLevelsResolved
        ? COMMISSION_TIER_LEVELS.map((tier) => ({ level: tier.level, name: tier.name }))
        : []
  ), [tenantTierLevels, tenantLevelsResolved]);

  const globalMaxCommissionPool = useMemo(
    () => getGlobalMaxCommissionPool(productCommissionCaps),
    [productCommissionCaps]
  );

  const pidTrim = (productId || '').trim();

  const commissionPoolWarnings = useMemo(() => {
    const pid = pidTrim;
    if (!pid || pid.toLowerCase() === ALL_PRODUCTS_GUID.toLowerCase()) return [];
    const hasCaps = FAMILY_TIER_CODES.some((c) => productCommissionCaps[c] != null);
    if (!hasCaps) return [];

    if (commissionType === 'Percentage') {
      return buildSimplePercentageWarnings(productCommissionCaps, watchedRate);
    }
    if (commissionType === 'Flat') {
      return buildSimpleFlatWarnings(productCommissionCaps, watchedAmount);
    }
    if (commissionType === 'Tiered') {
      return buildTieredCommissionPoolWarnings(
        productCommissionCaps,
        commissionTypeType === 'percentage' ? 'percentage' : 'flatrate',
        watchedTiers
      );
    }
    return [];
  }, [
    pidTrim,
    productCommissionCaps,
    commissionType,
    commissionTypeType,
    watchedRate,
    watchedAmount,
    watchedTiers,
  ]);

  const showPricingCapsGap =
    Boolean(pidTrim) &&
    pidTrim.toLowerCase() !== ALL_PRODUCTS_GUID.toLowerCase() &&
    commissionType === 'Tiered' &&
    capsFetched &&
    !capsLoading &&
    globalMaxCommissionPool == null;

  useEffect(() => {
    const fetchTenantTierLevels = async () => {
      setTenantLevelsResolved(false);
      try {
        const response: any = await apiService.get('/api/tenant-admin/commission-levels');
        if (response?.success && Array.isArray(response.data)) {
          const activeLevels = response.data
            .filter((level: any) => level?.IsActive !== false)
            .map((level: any) => ({
              level: Number(level.SortOrder),
              name: String(level.DisplayName || `Level ${level.SortOrder}`)
            }))
            .filter((level: TierLevelOption) => Number.isFinite(level.level))
            .sort((a: TierLevelOption, b: TierLevelOption) => a.level - b.level);
          setTenantTierLevels(activeLevels);
        } else {
          setTenantTierLevels([]);
        }
      } catch {
        setTenantTierLevels([]);
      } finally {
        setTenantLevelsResolved(true);
      }
    };

    fetchTenantTierLevels();
  }, [selectedTenantId]);

  // Initialize tiers if empty and commission type is Tiered
  useEffect(() => {
    if (skipAutoInit) return;
    if (commissionType === 'Tiered' && fields.length === 0 && !initializedRef.current && availableTierLevels.length > 0) {
      // Initialize using tenant-active tier levels (fallback to legacy set).
      const initialTiers = availableTierLevels.map(tier => ({
        level: tier.level,
        name: tier.name,
        ...(commissionTypeType === 'percentage' ? { rate: undefined } : { flatAmount: undefined }),
      }));
      // Set all tiers at once using setValue to avoid duplicates
      setValue('tiers', initialTiers);
      initializedRef.current = true;
    } else if (commissionType !== 'Tiered') {
      // Reset the ref when commission type changes away from Tiered
      initializedRef.current = false;
    }
  }, [commissionType, fields.length, setValue, commissionTypeType, availableTierLevels]);

  // When editing legacy tiered rules, reconcile any legacy-only levels (e.g. -1) to tenant-active levels.
  useEffect(() => {
    if (commissionType !== 'Tiered' || availableTierLevels.length === 0 || watchedTiers.length === 0) return;

    const allowedLevels = new Set(availableTierLevels.map((t) => Number(t.level)));
    const hasInvalidLevels = watchedTiers.some((tier: any) => !allowedLevels.has(Number(tier?.level)));
    if (!hasInvalidLevels) return;

    const watchedByLevel = new Map<number, any>();
    watchedTiers.forEach((tier: any) => {
      const level = Number(tier?.level);
      if (Number.isFinite(level) && !watchedByLevel.has(level)) {
        watchedByLevel.set(level, tier);
      }
    });

    const reconciledTiers = availableTierLevels.map((tierOption) => {
      const existing = watchedByLevel.get(Number(tierOption.level));
      if (existing) {
        return {
          ...existing,
          level: tierOption.level,
          name: tierOption.name
        };
      }
      return {
        level: tierOption.level,
        name: tierOption.name,
        ...(commissionTypeType === 'percentage' ? { rate: undefined } : { flatAmount: undefined })
      };
    });

    setValue('tiers', reconciledTiers);
  }, [commissionType, availableTierLevels, watchedTiers, commissionTypeType, setValue]);

  useEffect(() => {
    if (commissionType !== 'Tiered') return;
    if (watchedTiers.length === 0) return;
    if (!initialTierValuesRef.current) {
      initialTierValuesRef.current = JSON.parse(JSON.stringify(watchedTiers));
    }
  }, [commissionType, watchedTiers]);

  const resetTierValues = () => {
    if (isEditMode && initialTierValuesRef.current) {
      setValue('tiers', JSON.parse(JSON.stringify(initialTierValuesRef.current)));
      return;
    }
    if (skipAutoInit) {
      // Mass-update mode: full reset clears the tier list entirely.
      setValue('tiers', []);
      return;
    }
    const cleared = (getValues('tiers') || []).map((tier: any) => ({
      ...tier,
      rate: undefined,
      flatAmount: undefined,
      productTiers: {
        EE: { rate: undefined, flatAmount: undefined },
        ES: { rate: undefined, flatAmount: undefined },
        EC: { rate: undefined, flatAmount: undefined },
        EF: { rate: undefined, flatAmount: undefined }
      }
    }));
    setValue('tiers', cleared);
  };

  // Initialize split commission if empty and commission type is Split
  useEffect(() => {
    if (commissionType === 'Split' && !watch('splitCommission')) {
      setValue('splitCommission', {
        primaryAgentId: '',
        primaryAgentPercentage: 0,
        agents: [],
      });
    }
  }, [commissionType, setValue, watch]);

  // Fetch agents when tenant is selected and commission type is Split
  useEffect(() => {
    if (commissionType === 'Split' && selectedTenantId) {
      fetchAgents(selectedTenantId);
    } else {
      setAgents([]);
    }
  }, [commissionType, selectedTenantId]);

  const fetchAgents = async (tenantId: string) => {
    try {
      setLoadingAgents(true);
      const response: any = await apiService.get(`/api/tenant-admin/agents?tenantId=${tenantId}&status=Active&type=Agent`);
      if (response && response.success && Array.isArray(response.data)) {
        setAgents(response.data.map((a: any) => ({
          AgentId: a.AgentId || a.Id,
          FirstName: a.FirstName || a.Name?.split(' ')[0] || '',
          LastName: a.LastName || a.Name?.split(' ').slice(1).join(' ') || '',
          Email: a.Email || '',
        })));
      }
    } catch (error) {
      console.error('Error fetching agents:', error);
      setAgents([]);
    } finally {
      setLoadingAgents(false);
    }
  };

  const renderPercentageConfiguration = () => (
    <Box>
      <Typography variant="h6" gutterBottom>
        Set Commission Rate
      </Typography>
      <Typography variant="body2" color="textSecondary" gutterBottom>
        Enter the percentage rate for this commission rule
      </Typography>
      
      <Controller
        name="rate"
        control={control}
        render={({ field, fieldState }) => {
          // Handle 0 explicitly - don't treat it as falsy
          const displayValue = field.value !== undefined && field.value !== null 
            ? decimalToPercentage(field.value) 
            : '';

          return (
            <TextField
              type="text"
              label="Commission Rate"
              fullWidth
              error={!!fieldState.error}
              helperText={fieldState.error?.message || 'Enter rate as a percentage (e.g., 5 for 5% or 0 for 0%)'}
              disabled={isLocked}
              InputProps={{
                endAdornment: <InputAdornment position="end">%</InputAdornment>,
              }}
              value={displayValue}
              onChange={(e) => {
                if (isLocked) return;
                const inputValue = e.target.value;
                if (!/^\d*\.?\d*$/.test(inputValue)) return;
                if (inputValue === '') {
                  field.onChange(undefined);
                } else {
                  field.onChange(percentageToDecimal(inputValue));
                }
              }}
              onBlur={() => {
                // Always round if value exists (including 0)
                if (field.value !== undefined && field.value !== null) {
                  // Round to 4 decimal places to avoid floating point errors
                  field.onChange(Math.round(field.value * 10000) / 10000);
                }
              }}
            />
          );
        }}
      />
      
      <Alert severity="info" sx={{ mt: 2 }}>
        <Typography variant="body2">
          This rate will be applied to the premium amount for each enrollment
        </Typography>
      </Alert>
    </Box>
  );

  const renderFlatAmountConfiguration = () => (
    <Box>
      <Typography variant="h6" gutterBottom>
        Set Commission Amount
      </Typography>
      <Typography variant="body2" color="textSecondary" gutterBottom>
        Enter the fixed dollar amount for this commission rule
      </Typography>
      
      <Controller
        name="amount"
        control={control}
        render={({ field, fieldState }) => (
          <TextField
            {...field}
            type="number"
            label="Commission Amount"
            fullWidth
            error={!!fieldState.error}
            helperText={fieldState.error?.message || 'Enter a fixed dollar amount per enrollment'}
            disabled={isLocked}
            InputProps={{
              startAdornment: <InputAdornment position="start">$</InputAdornment>,
            }}
            inputProps={{
              min: 0,
              step: 0.01,
            }}
            onChange={(e) => {
              if (isLocked) return;
              const value = parseFloat(e.target.value);
              field.onChange(isNaN(value) ? 0 : value);
            }}
          />
        )}
      />
      
      <Alert severity="info" sx={{ mt: 2 }}>
        <Typography variant="body2">
          This fixed amount will be paid for each successful enrollment
        </Typography>
      </Alert>
    </Box>
  );

  const renderTieredConfiguration = () => {
    // Calculate total based on type
    const totalRate = commissionTypeType === 'percentage'
      ? watchedTiers.reduce((sum: number, row: any) => {
          const rate = row?.rate;
          return sum + (rate !== undefined && rate !== null ? Number(rate) : 0);
        }, 0)
      : 0;

    const totalFlatAmount =
      commissionTypeType === 'flatrate'
        ? (() => {
            let maxTierAmount = 0;
            watchedTiers.forEach((tier: any) => {
              const baseAmount = toMoneyNumber(tier?.flatAmount);
              const productTiers = tier?.productTiers;
              let effectiveAmount = baseAmount ?? 0;
              if (productTiers && effectiveAmount === 0) {
                const ptAmounts = (['EE', 'ES', 'EC', 'EF'] as const)
                  .map((pt) => toMoneyNumber(productTiers[pt]?.flatAmount))
                  .filter((a): a is number => a != null && a > 0);
                if (ptAmounts.length > 0) {
                  effectiveAmount = Math.max(...ptAmounts);
                }
              }
              if (effectiveAmount > maxTierAmount) maxTierAmount = effectiveAmount;
            });
            return maxTierAmount;
          })()
        : 0;

    return (
      <Box>
        {/* Type Selector - flatrate or percentage */}
        <Box mb={3}>
          <Controller
            name="type"
            control={control}
            defaultValue="flatrate"
            render={({ field, fieldState }) => (
              <FormControl fullWidth error={!!fieldState.error}>
                <InputLabel>Commission Type for Tiers</InputLabel>
                <Select
                  {...field}
                  label="Commission Type for Tiers"
                  value={field.value || 'flatrate'}
                  disabled={isLocked}
                
                  MenuProps={selectMenuProps}
                >
                  <MenuItem value="percentage">Percentage</MenuItem>
                  <MenuItem value="flatrate">Flat Rate</MenuItem>
                </Select>
                <FormHelperText>
                  {fieldState.error?.message || (compactMode ? '' : 'Select whether tiers use percentage or flat rate')}
                </FormHelperText>
              </FormControl>
            )}
          />
        </Box>

        {capsLoading &&
          pidTrim &&
          pidTrim.toLowerCase() !== ALL_PRODUCTS_GUID.toLowerCase() && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Loading product pricing caps…
            </Typography>
          )}

        {showPricingCapsGap && commissionTypeType === 'flatrate' && !compactMode && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <Typography variant="body2">
              Could not read VendorCommission pools from this product&apos;s pricing (no EE–EF pricing rows, dates not
              effective yet, or the product request failed). Amount checks are unavailable until pricing loads.
            </Typography>
          </Alert>
        )}

        {commissionTypeType === 'flatrate' &&
          globalMaxCommissionPool != null &&
          pidTrim &&
          pidTrim.toLowerCase() !== ALL_PRODUCTS_GUID.toLowerCase() &&
          !compactMode && (
            <Alert severity="info" sx={{ mb: 2 }}>
              <Typography variant="body2" fontWeight={600}>
                Largest VendorCommission pool (this product, latest pricing wave — max over EE–EF age bands): $
                {globalMaxCommissionPool.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                EE / ES / EC / EF can each have a different cap; we warn when an amount exceeds the smallest pool for
                that family tier, and again if it exceeds the largest.
              </Typography>
            </Alert>
          )}

        {commissionPoolWarnings.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <Typography variant="subtitle2" component="div" gutterBottom fontWeight={600}>
              Commission vs product VendorCommission pool
            </Typography>
            {commissionPoolWarnings.map((msg, i) => (
              <Typography key={i} variant="body2" component="div" sx={{ mt: i > 0 ? 1 : 0 }}>
                {msg}
              </Typography>
            ))}
          </Alert>
        )}

        <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
          <Box>
            <Typography variant="h6">
              Configure Tier {commissionTypeType === 'percentage' ? 'Rates' : 'Amounts'}
            </Typography>
            {!compactMode && (
              <Typography variant="body2" color="textSecondary">
                Define commission {commissionTypeType === 'percentage' ? 'rates' : 'amounts'} for each tier in the hierarchy
              </Typography>
            )}
          </Box>
          <Tooltip title="Add a new tier level">
            <Box display="flex" alignItems="center" gap={1}>
              <Button
                variant="text"
                size="small"
                disabled={isLocked}
                onClick={resetTierValues}
              >
                Reset
              </Button>
              <Button
                startIcon={<AddIcon />}
                disabled={isLocked || availableTierLevels.filter(t => !watchedTiers.some((w: any) => Number(w?.level) === t.level)).length === 0}
                onClick={() => setAddTierModalOpen(true)}
                variant="outlined"
                size="small"
              >
                Add Tier
              </Button>
            </Box>
          </Tooltip>
        </Box>

        {fields.length === 0 ? (
          compactMode ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
              No tiers yet — click <b>Add Tier</b>.
            </Typography>
          ) : (
            <Alert severity="warning">
              No tiers configured. Click "Add Tier" to create tier levels.
            </Alert>
          )
        ) : (
          <>
            <Grid container spacing={2}>
              {fields.map((field, index) => (
                <Grid size={12} key={field.id}>
                  <Card variant="outlined">
                    <CardContent>
                      {/* Main Tier Configuration Row */}
                      <Box display="flex" alignItems="center" gap={2} mb={2}>
                        <Tooltip title="Drag to reorder">
                          <IconButton size="small" sx={{ cursor: 'move' }}>
                            <DragIcon />
                          </IconButton>
                        </Tooltip>
                        
                        <Typography variant="subtitle2" sx={{ minWidth: 80 }}>
                          Level {watch(`tiers.${index}.level`) ?? index}
                        </Typography>
                        
                        <Controller
                          name={`tiers.${index}.name`}
                          control={control}
                          render={({ field, fieldState }) => {
                            const currentTier = watch(`tiers.${index}`);
                            const currentLevel = currentTier?.level;
                            
                            return (
                              <FormControl 
                                fullWidth 
                                size="small" 
                                error={!!fieldState.error}
                                sx={{ flex: 1 }}
                              >
                                <InputLabel>Tier Name</InputLabel>
                                <Select
                                  {...field}
                                  label="Tier Name"
                                  value={currentLevel ?? ''}
                                  disabled={isLocked}
                                  MenuProps={selectMenuProps}
                                  onChange={(e) => {
                                    if (isLocked) return;
                                    const selectedLevel = Number(e.target.value);
                                    const selectedTier = availableTierLevels.find((t) => t.level === selectedLevel);
                                    if (selectedTier) {
                                      // Update both name and level
                                      field.onChange(selectedTier.name);
                                      setValue(`tiers.${index}.level`, selectedTier.level);
                                    }
                                  }}
                                >
                                  {availableTierLevels.map((option) => {
                                    // Check if this tier level is already used by another tier in the list.
                                    const isUsed = watchedTiers.some((f: any, idx: number) => 
                                      idx !== index && Number(f?.level) === Number(option.level)
                                    );
                                    return (
                                      <MenuItem 
                                        key={option.level} 
                                        value={option.level}
                                        disabled={isUsed}
                                      >
                                        {option.name} (Level {option.level})
                                      </MenuItem>
                                    );
                                  })}
                                </Select>
                                {fieldState.error && (
                                  <FormHelperText>{fieldState.error.message}</FormHelperText>
                                )}
                              </FormControl>
                            );
                          }}
                        />
                        
                        {commissionTypeType === 'percentage' ? (
                        <Controller
                          name={`tiers.${index}.rate`}
                          control={control}
                          render={({ field, fieldState }) => {
                            // Handle 0 explicitly - don't treat it as falsy
                            const displayValue = field.value !== undefined && field.value !== null 
                              ? decimalToPercentage(field.value) 
                              : '';

                            return (
                              <TextField
                                type="text"
                                label="Base Rate"
                                size="small"
                                sx={{ width: 150 }}
                                error={!!fieldState.error}
                                helperText={fieldState.error?.message}
                                disabled={isLocked}
                                InputProps={{
                                  endAdornment: <InputAdornment position="end">%</InputAdornment>,
                                }}
                                value={displayValue}
                                onChange={(e) => {
                                  if (isLocked) return;
                                  const input = e.target.value;
                                  if (!/^\d*\.?\d*$/.test(input)) return;
                                  if (input === '') {
                                    field.onChange(undefined);
                                  } else {
                                    field.onChange(percentageToDecimal(input));
                                    // Base rate takes precedence; clear product-tier overrides for this tier row.
                                    setValue(`tiers.${index}.productTiers.EE.rate` as any, undefined);
                                    setValue(`tiers.${index}.productTiers.ES.rate` as any, undefined);
                                    setValue(`tiers.${index}.productTiers.EC.rate` as any, undefined);
                                    setValue(`tiers.${index}.productTiers.EF.rate` as any, undefined);
                                  }
                                }}
                                onBlur={() => {
                                  // Only round if value exists (don't auto-fill empty fields)
                                  if (field.value !== undefined && field.value !== null) {
                                    // Round to 4 decimal places to avoid floating point errors
                                    field.onChange(Math.round(field.value * 10000) / 10000);
                                  }
                                }}
                              />
                            );
                          }}
                        />
                        ) : (
                          <Controller
                            name={`tiers.${index}.flatAmount`}
                            control={control}
                            render={({ field, fieldState }) => (
                              <TextField
                                type="number"
                                label="Base Flat Amount"
                                size="small"
                                sx={{ width: 180 }}
                                error={!!fieldState.error}
                                helperText={fieldState.error?.message}
                                disabled={isLocked}
                                InputProps={{
                                  startAdornment: <InputAdornment position="start">$</InputAdornment>,
                                }}
                                inputProps={{
                                  min: 0,
                                  step: 0.01,
                                }}
                                value={field.value ?? ''}
                                onWheel={(e) => {
                                  e.currentTarget.blur();
                                }}
                                onChange={(e) => {
                                  if (isLocked) return;
                                  const input = e.target.value;
                                  if (input === '') {
                                    field.onChange(undefined);
                                  } else {
                                    const value = parseFloat(input);
                                    field.onChange(isNaN(value) ? undefined : value);
                                    // Sync family-tier flat amounts to match base in the UI.
                                    if (!isNaN(value)) {
                                      for (const fam of ['EE', 'ES', 'EC', 'EF'] as const) {
                                        setValue(`tiers.${index}.productTiers.${fam}.flatAmount` as any, value);
                                      }
                                    } else {
                                      for (const fam of ['EE', 'ES', 'EC', 'EF'] as const) {
                                        setValue(`tiers.${index}.productTiers.${fam}.flatAmount` as any, undefined);
                                      }
                                    }
                                  }
                                }}
                              />
                            )}
                          />
                        )}
                        
                        <Tooltip title="Remove this tier">
                          <IconButton
                            size="small"
                            color="error"
                            onClick={() => {
                              if (!isLocked) remove(index);
                            }}
                            disabled={(!skipAutoInit && fields.length <= 1) || isLocked}
                          >
                            <DeleteIcon />
                          </IconButton>
                        </Tooltip>
                      </Box>

                      {/* Product Tier Configuration Section */}
                      {commissionTypeType === 'flatrate' && (
                        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                          <Grid container spacing={2}>
                            {(['EE', 'ES', 'EC', 'EF'] as const).map((tier) => (
                              <Grid size={3} key={tier}>
                                <Controller
                                  name={`tiers.${index}.productTiers.${tier}.flatAmount` as any}
                                  control={control}
                                  render={({ field, fieldState }) => (
                                    <TextField
                                      type="number"
                                      label={`${tier} Amount`}
                                      size="small"
                                      fullWidth
                                      error={!!fieldState.error}
                                      helperText={fieldState.error?.message}
                                      disabled={isLocked}
                                      InputProps={{
                                        startAdornment: <InputAdornment position="start">$</InputAdornment>,
                                      }}
                                      inputProps={{
                                        min: 0,
                                        step: 0.01,
                                      }}
                                      value={field.value ?? ''}
                                      onWheel={(e) => {
                                        e.currentTarget.blur();
                                      }}
                                      onChange={(e) => {
                                        if (isLocked) return;
                                        const value = parseFloat(e.target.value);
                                        field.onChange(isNaN(value) ? undefined : value);
                                        if (!isNaN(value)) {
                                          // Product-tier override entered; clear base tier amount.
                                          setValue(`tiers.${index}.flatAmount`, undefined);
                                        }
                                      }}
                                      placeholder="Base amount"
                                    />
                                  )}
                                />
                              </Grid>
                            ))}
                          </Grid>
                        </Box>
                      )}
                      {commissionTypeType === 'percentage' && (
                        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                          <Typography variant="caption" color="textSecondary" fontWeight="medium" sx={{ mb: 1, display: 'block' }}>
                            Product Tier Rates (Optional)
                          </Typography>
                          <Typography variant="caption" color="textSecondary" sx={{ mb: 2, display: 'block' }}>
                            Configure individual rates for each product tier. Leave empty to use the base rate above.
                          </Typography>
                          <Grid container spacing={2}>
                            {(['EE', 'ES', 'EC', 'EF'] as const).map((tier) => (
                              <Grid size={3} key={tier}>
                                <Controller
                                  name={`tiers.${index}.productTiers.${tier}.rate` as any}
                                  control={control}
                                  render={({ field, fieldState }) => {
                                    const fieldValue = typeof field.value === 'number' ? field.value : undefined;
                                    // Handle 0 explicitly - don't treat it as falsy
                                    const displayValue = fieldValue !== undefined && fieldValue !== null 
                                      ? decimalToPercentage(fieldValue) 
                                      : '';
                                    return (
                                      <TextField
                                        type="text"
                                        label={`${tier} Rate`}
                                        size="small"
                                        fullWidth
                                        error={!!fieldState.error}
                                        helperText={fieldState.error?.message}
                                        disabled={isLocked}
                                        InputProps={{
                                          endAdornment: <InputAdornment position="end">%</InputAdornment>,
                                        }}
                                        value={displayValue}
                                        onChange={(e) => {
                                          if (isLocked) return;
                                          const input = e.target.value;
                                          if (!/^\d*\.?\d*$/.test(input)) return;
                                          if (input === '') {
                                            field.onChange(undefined);
                                          } else {
                                            field.onChange(percentageToDecimal(input));
                                            // Product-tier override entered; clear base tier rate.
                                            setValue(`tiers.${index}.rate`, undefined);
                                          }
                                        }}
                                        onBlur={() => {
                                          if (isLocked) return;
                                          if (typeof field.value === 'number') {
                                            // Round to 4 decimal places to avoid floating point errors
                                            field.onChange(Math.round(field.value * 10000) / 10000);
                                          }
                                        }}
                                        placeholder="Base rate"
                                      />
                                    );
                                  }}
                                />
                              </Grid>
                            ))}
                          </Grid>
                        </Box>
                      )}
                    </CardContent>
                  </Card>
                </Grid>
              ))}
            </Grid>

            {/* Total Commission Display - Based on type */}
            <Box sx={{ mt: 2 }}>
              {commissionTypeType === 'percentage' ? (
                totalRate > 1 ? (
                  <Alert 
                    severity="error"
                    sx={{ 
                      '& .MuiAlert-message': {
                        width: '100%',
                      }
                    }}
                  >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <Typography variant="body1">
                        Total commission rate ({(totalRate * 100).toFixed(2)}%) exceeds 100%
                      </Typography>
                      <Typography variant="h6" fontWeight="bold">
                        {(totalRate * 100).toFixed(2)}%
                      </Typography>
                    </Box>
                  </Alert>
                ) : totalRate < 1 && totalRate > 0 ? (
                <Alert 
                  severity="warning"
                  sx={{ 
                    '& .MuiAlert-message': {
                      width: '100%',
                    }
                  }}
                >
                  <Box>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
                      <Typography variant="body1">
                        Total Base Rate:
                      </Typography>
                      <Typography variant="h6" fontWeight="bold">
                        {(totalRate * 100).toFixed(2)}%
                      </Typography>
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      Company retains: {((1 - totalRate) * 100).toFixed(2)}%
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      Unallocated commission will be retained by the company
                    </Typography>
                  </Box>
                </Alert>
                ) : totalRate === 1 ? (
                <Alert 
                  severity="success"
                  sx={{ 
                    '& .MuiAlert-message': {
                      width: '100%',
                    }
                  }}
                >
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <Typography variant="body1">
                      Total Base Rate:
                    </Typography>
                    <Typography variant="h6" fontWeight="bold">
                      {(totalRate * 100).toFixed(2)}%
                    </Typography>
                  </Box>
                  <Typography variant="caption" color="text.secondary">
                    ✓ Perfect! All commission allocated
                  </Typography>
                </Alert>
                ) : (
                  <Box sx={{ 
                    p: 2, 
                    bgcolor: 'grey.50', 
                    borderRadius: 1,
                  }}>
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 1 }}>
                      <Typography variant="h6" color="text.secondary">
                        Total Base Rate:
                      </Typography>
                      <Typography 
                        variant="h5" 
                        fontWeight="bold"
                        color="text.primary"
                      >
                        0.00%
                      </Typography>
                    </Box>
                  </Box>
                )
              ) : compactMode ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, textAlign: 'right' }}>
                  Total: ${totalFlatAmount.toFixed(2)}
                </Typography>
              ) : (
                <Alert severity="info">
                  <Typography variant="body1">
                    Total Flat Amount: ${totalFlatAmount.toFixed(2)}
                  </Typography>
                </Alert>
              )}
            </Box>
          </>
        )}

        {compactMode ? (
          <Box sx={{ mt: 1.5 }}>
            <Box display="flex" alignItems="center" gap={0.5}>
              <Typography variant="caption" color="text.secondary">
                Tier hierarchy help
              </Typography>
              <Tooltip title="How tiered commissions work (click to expand)">
                <IconButton
                  size="small"
                  aria-label="Tier hierarchy help"
                  onClick={() => setTierHelpOpen((o) => !o)}
                  sx={{ p: 0.25 }}
                >
                  <InfoIcon fontSize="small" color="info" />
                </IconButton>
              </Tooltip>
            </Box>
            {tierHelpOpen && (
              <Box sx={{ mt: 1, pl: 1, borderLeft: '2px solid', borderColor: 'info.light' }}>
                <Typography variant="caption" display="block">
                  Level 0 = direct seller; higher levels = upline.
                </Typography>
                <Typography variant="caption" display="block">
                  Each level gets its configured {commissionTypeType === 'percentage' ? 'rate' : 'amount'} on a sale.
                </Typography>
                {commissionTypeType === 'percentage' && (
                  <Typography variant="caption" color="error.main" display="block">
                    Tier rates should not exceed 100% combined.
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        ) : (
          <Alert severity="info" sx={{ mt: 2 }}>
            <Box display="flex" alignItems="flex-start" gap={1}>
              <InfoIcon fontSize="small" />
              <Box>
                <Typography variant="body2" fontWeight="bold">
                  How Tiered Commissions Work:
                </Typography>
                <Typography variant="body2">
                  • Level 0 is the direct seller (e.g., Agent)
                </Typography>
                <Typography variant="body2">
                  • Higher levels represent upline positions in the hierarchy
                </Typography>
                <Typography variant="body2">
                  • Each level receives their configured {commissionTypeType === 'percentage' ? 'rate' : 'amount'} when a sale is made
                </Typography>
                {commissionTypeType === 'percentage' && (
                  <Typography variant="body2" color="error">
                    • Total of all tiers should not exceed 100%
                  </Typography>
                )}
              </Box>
            </Box>
          </Alert>
        )}
      </Box>
    );
  };

  const renderSplitConfiguration = () => {
    const primaryAgentPercentage = watch('splitCommission.primaryAgentPercentage') || 0;
    const additionalAgentsPercentage = splitAgentFields.reduce((sum, _, index) => {
      const percentage = watch(`splitCommission.agents.${index}.percentage`) || 0;
      return sum + percentage;
    }, 0);
    const totalPercentage = primaryAgentPercentage + additionalAgentsPercentage;

    return (
      <Box>
        <Typography variant="h6" gutterBottom>
          Configure Split Commission
        </Typography>
        <Typography variant="body2" color="textSecondary" gutterBottom>
          Define how commission is split between the primary agent and other agents
        </Typography>

        {/* Primary Agent Selection and Percentage */}
        <Box mb={3}>
          <Grid container spacing={2}>
            <Grid size={6}>
              <Controller
                name="splitCommission.primaryAgentId"
                control={control}
                render={({ field, fieldState }) => (
                  <FormControl fullWidth error={!!fieldState.error}>
                    <InputLabel>Primary Agent</InputLabel>
                    <Select
                      {...field}
                      label="Primary Agent"
                      disabled={loadingAgents || !selectedTenantId}
                      value={field.value || ''}
                    >
                      {agents.map((agent) => (
                        <MenuItem key={agent.AgentId} value={agent.AgentId}>
                          {agent.FirstName} {agent.LastName} {agent.Email ? `(${agent.Email})` : ''}
                        </MenuItem>
                      ))}
                    </Select>
                    <FormHelperText>
                      {fieldState.error?.message || 'Select the primary agent for this split commission'}
                    </FormHelperText>
                  </FormControl>
                )}
              />
            </Grid>
            <Grid size={6}>
              <Controller
                name="splitCommission.primaryAgentPercentage"
                control={control}
                render={({ field, fieldState }) => {
                  // Handle 0 explicitly - don't treat it as falsy
                  const displayValue = field.value !== undefined && field.value !== null 
                    ? decimalToPercentage(field.value) 
                    : '';
                  return (
                    <TextField
                      type="text"
                      label="Primary Agent Percentage"
                      fullWidth
                      error={!!fieldState.error}
                      helperText={fieldState.error?.message || 'Enter the percentage for the primary agent (0 is allowed)'}
                      InputProps={{
                        endAdornment: <InputAdornment position="end">%</InputAdornment>,
                      }}
                      value={displayValue}
                      onChange={(e) => {
                        const input = e.target.value;
                        if (!/^\d*\.?\d*$/.test(input)) return;
                        if (input === '') {
                          field.onChange(undefined);
                        } else {
                          field.onChange(percentageToDecimal(input));
                        }
                      }}
                      onBlur={() => {
                        // Always round if value exists (including 0)
                        if (field.value !== undefined && field.value !== null) {
                          // Round to 4 decimal places to avoid floating point errors
                          field.onChange(Math.round(field.value * 10000) / 10000);
                        }
                      }}
                    />
                  );
                }}
              />
            </Grid>
          </Grid>
        </Box>

        {/* Split Agents */}
        <Box mb={2}>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={2}>
            <Typography variant="subtitle1">Additional Agents</Typography>
            <Button
              startIcon={<AddIcon />}
              onClick={() => {
                appendSplitAgent({ agentId: '', percentage: 0 });
              }}
              variant="outlined"
              size="small"
              disabled={loadingAgents || !selectedTenantId}
            >
              Add Agent
            </Button>
          </Box>

          {splitAgentFields.map((field, index) => (
            <Card key={field.id} variant="outlined" sx={{ mb: 2 }}>
              <CardContent>
                <Grid container spacing={2} alignItems="center">
                  <Grid size={5}>
                    <Controller
                      name={`splitCommission.agents.${index}.agentId`}
                      control={control}
                      render={({ field, fieldState }) => (
                        <FormControl fullWidth error={!!fieldState.error}>
                          <InputLabel>Agent</InputLabel>
                          <Select
                            {...field}
                            label="Agent"
                            disabled={loadingAgents || !selectedTenantId}
                            value={field.value || ''}
                          >
                            {agents.map((a) => (
                              <MenuItem key={a.AgentId} value={a.AgentId}>
                                {a.FirstName} {a.LastName}
                              </MenuItem>
                            ))}
                          </Select>
                          <FormHelperText>{fieldState.error?.message}</FormHelperText>
                        </FormControl>
                      )}
                    />
                  </Grid>
                  <Grid size={4}>
                    <Controller
                      name={`splitCommission.agents.${index}.percentage`}
                      control={control}
                      render={({ field, fieldState }) => {
                        // Handle 0 explicitly - don't treat it as falsy
                        const displayValue = field.value !== undefined && field.value !== null 
                          ? decimalToPercentage(field.value) 
                          : '';
                        return (
                          <TextField
                            type="text"
                            label="Percentage"
                            fullWidth
                            error={!!fieldState.error}
                            helperText={fieldState.error?.message}
                            InputProps={{
                              endAdornment: <InputAdornment position="end">%</InputAdornment>,
                            }}
                            value={displayValue}
                            onChange={(e) => {
                              const input = e.target.value;
                              if (!/^\d*\.?\d*$/.test(input)) return;
                              if (input === '') {
                                field.onChange(undefined);
                              } else {
                                field.onChange(percentageToDecimal(input));
                              }
                            }}
                            onBlur={() => {
                              // Always round if value exists (including 0)
                              if (field.value !== undefined && field.value !== null) {
                                // Round to 4 decimal places to avoid floating point errors
                                field.onChange(Math.round(field.value * 10000) / 10000);
                              }
                            }}
                          />
                        );
                      }}
                    />
                  </Grid>
                  <Grid size={3}>
                    <IconButton
                      color="error"
                      onClick={() => removeSplitAgent(index)}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Grid>
                </Grid>
              </CardContent>
            </Card>
          ))}
        </Box>

        {/* Total Percentage Display */}
        <Alert severity={totalPercentage > 1 ? 'error' : totalPercentage === 1 ? 'success' : 'warning'}>
          <Typography variant="body1" fontWeight={totalPercentage === 1 ? 'bold' : 'normal'}>
            Total Split: {(totalPercentage * 100).toFixed(2)}%
            {totalPercentage > 1 && ' (Exceeds 100%)'}
            {totalPercentage < 1 && totalPercentage > 0 && ` (${((1 - totalPercentage) * 100).toFixed(2)}% unallocated)`}
            {totalPercentage === 0 && ' (No percentages configured)'}
            {totalPercentage === 1 && ' ✓ Total equals 100%'}
          </Typography>
          {totalPercentage !== 1 && (
            <Typography variant="body2" sx={{ mt: 1, fontWeight: 'bold' }}>
              ⚠️ Total must equal exactly 100% to create this rule
            </Typography>
          )}
          {primaryAgentPercentage > 0 && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              Primary Agent: {(primaryAgentPercentage * 100).toFixed(2)}%
            </Typography>
          )}
          {additionalAgentsPercentage > 0 && (
            <Typography variant="body2" sx={{ mt: 0.5 }}>
              Additional Agents: {(additionalAgentsPercentage * 100).toFixed(2)}%
            </Typography>
          )}
        </Alert>
      </Box>
    );
  };

  const unusedTierLevels = availableTierLevels.filter(
    t => !watchedTiers.some((w: any) => Number(w?.level) === t.level)
  );

  const handleAddTierFromModal = (tierOption: TierLevelOption) => {
    const newTier = {
      level: tierOption.level,
      name: tierOption.name,
      ...(commissionTypeType === 'percentage' ? { rate: undefined } : { flatAmount: undefined }),
    };
    const updated = [...(getValues('tiers') || []), newTier].sort(
      (a: any, b: any) => Number(a.level) - Number(b.level)
    );
    setValue('tiers', updated);
    setAddTierModalOpen(false);
  };

  return (
    <Box>
      {commissionType !== 'Tiered' && commissionPoolWarnings.length > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <Typography variant="subtitle2" component="div" gutterBottom fontWeight={600}>
            Commission vs product VendorCommission pool
          </Typography>
          {commissionPoolWarnings.map((msg, i) => (
            <Typography key={i} variant="body2" component="div" sx={{ mt: i > 0 ? 1 : 0 }}>
              {msg}
            </Typography>
          ))}
        </Alert>
      )}
      {commissionType === 'Percentage' && renderPercentageConfiguration()}
      {commissionType === 'Flat' && renderFlatAmountConfiguration()}
      {commissionType === 'Tiered' && renderTieredConfiguration()}
      {commissionType === 'Split' && renderSplitConfiguration()}

      <Dialog
        open={addTierModalOpen}
        onClose={() => setAddTierModalOpen(false)}
        maxWidth="xs"
        fullWidth
        slotProps={commissionDialogSlotProps(COMMISSION_NESTED_DIALOG_Z)}
        sx={{ zIndex: COMMISSION_NESTED_DIALOG_Z }}
      >
        <DialogTitle>Add Tier Level</DialogTitle>
        <DialogContent>
          {unusedTierLevels.length === 0 ? (
            <Typography color="textSecondary" sx={{ py: 2 }}>All available tier levels are already added.</Typography>
          ) : (
            <List>
              {unusedTierLevels
                .sort((a, b) => a.level - b.level)
                .map((tier) => (
                  <ListItemButton key={tier.level} onClick={() => handleAddTierFromModal(tier)}>
                    <ListItemText
                      primary={tier.name}
                      secondary={`Level ${tier.level}`}
                    />
                  </ListItemButton>
                ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddTierModalOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};