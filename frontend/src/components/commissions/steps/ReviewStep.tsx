// src/components/commissions/steps/ReviewStep.tsx
import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  Chip,
  Paper,
  Grid,
  TextField,
} from '@mui/material';
import { CheckCircle as CheckIcon } from '@mui/icons-material';
import { format } from 'date-fns';
import { RuleCreationFormData } from '../RuleCreationWizard';

interface ReviewStepProps {
  isEditMode?: boolean;
}

export const ReviewStep: React.FC<ReviewStepProps> = ({ isEditMode = false }) => {
  const { control, getValues, watch } = useFormContext<RuleCreationFormData>();
  const formData = getValues();
  const commissionTypeType = watch('type');

  const formatCommissionDisplay = (): string => {
    if (formData.commissionType === 'Percentage') {
      return `${((formData.rate || 0) * 100).toFixed(2)}%`;
    }
    if (formData.commissionType === 'Flat') {
      return `$${(formData.amount || 0).toFixed(2)}`;
    }
    if (formData.commissionType === 'Tiered' && formData.tiers) {
      return `${formData.tiers.length} tier${formData.tiers.length === 1 ? '' : 's'}`;
    }
    return '—';
  };

  const formatDateDisplay = (date: Date | null | undefined): string => {
    if (!date) return '—';
    return format(new Date(date), 'MMM d, yyyy');
  };

  return (
    <Box>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        Review
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Confirm settings, then {isEditMode ? 'save' : 'create'} the rule.
      </Typography>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={12}>
          <Controller
            name="ruleName"
            control={control}
            rules={{ required: 'Rule name is required' }}
            render={({ field, fieldState }) => (
              <TextField
                {...field}
                fullWidth
                size="small"
                label="Rule name"
                required
                error={!!fieldState.error}
                helperText={fieldState.error?.message}
              />
            )}
          />
        </Grid>
        <Grid size={12}>
          <Controller
            name="description"
            control={control}
            render={({ field }) => (
              <TextField
                {...field}
                fullWidth
                size="small"
                multiline
                minRows={2}
                label="Description (optional)"
                placeholder="Internal note about this rule"
              />
            )}
          />
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="caption" color="primary" fontWeight={600}>
              Product
            </Typography>
            <List dense disablePadding>
              <ListItem disablePadding sx={{ py: 0.25 }}>
                <ListItemText
                  primary={formData.productName || '—'}
                  secondary={formData.productType || undefined}
                  primaryTypographyProps={{ variant: 'body2' }}
                  secondaryTypographyProps={{ variant: 'caption' }}
                />
              </ListItem>
            </List>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="caption" color="primary" fontWeight={600}>
              Rule
            </Typography>
            <List dense disablePadding>
              <ListItem disablePadding sx={{ py: 0.25 }}>
                <ListItemText
                  primary="Scope"
                  secondary={formData.entityType || '—'}
                  primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                  secondaryTypographyProps={{ variant: 'body2' }}
                />
              </ListItem>
              <ListItem disablePadding sx={{ py: 0.25 }}>
                <ListItemText
                  primary="Type"
                  secondary={formData.commissionType || '—'}
                  primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                  secondaryTypographyProps={{ variant: 'body2' }}
                />
              </ListItem>
            </List>
          </Paper>
        </Grid>

        <Grid size={12}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="caption" color="primary" fontWeight={600}>
              Commission
            </Typography>
            <Typography variant="h6" color="secondary.main" sx={{ mt: 0.5 }}>
              {formatCommissionDisplay()}
            </Typography>
            {formData.commissionType === 'Tiered' && formData.tiers && formData.tiers.length > 0 && (
              <List dense sx={{ mt: 1 }}>
                {formData.tiers.map((tier, index) => {
                  let displayValue: string;
                  if (commissionTypeType === 'flatrate') {
                    const baseAmount =
                      tier.flatAmount !== undefined && tier.flatAmount !== null ? tier.flatAmount : null;
                    const productTierAmounts = tier.productTiers
                      ? (['EE', 'ES', 'EC', 'EF'] as const)
                          .map((pt) => {
                            const amt = tier.productTiers?.[pt]?.flatAmount;
                            return amt !== undefined && amt !== null ? `${pt}: $${amt.toFixed(2)}` : null;
                          })
                          .filter(Boolean)
                      : [];
                    if (baseAmount !== null && baseAmount >= 0) {
                      displayValue = `$${baseAmount.toFixed(2)}`;
                    } else if (productTierAmounts.length > 0) {
                      displayValue = productTierAmounts.join(', ');
                    } else {
                      displayValue = '—';
                    }
                  } else {
                    displayValue =
                      tier.rate !== undefined && tier.rate !== null
                        ? `${(tier.rate * 100).toFixed(2)}%`
                        : '—';
                  }
                  return (
                    <ListItem key={index} disablePadding sx={{ py: 0 }}>
                      <ListItemText
                        primary={`${tier.name} (L${tier.level})`}
                        secondary={displayValue}
                        primaryTypographyProps={{ variant: 'body2' }}
                        secondaryTypographyProps={{ variant: 'caption' }}
                      />
                    </ListItem>
                  );
                })}
              </List>
            )}
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="caption" color="primary" fontWeight={600}>
              Dates
            </Typography>
            <List dense disablePadding>
              <ListItem disablePadding sx={{ py: 0.25 }}>
                <ListItemText
                  primary="Effective"
                  secondary={formatDateDisplay(formData.effectiveDate)}
                  primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                  secondaryTypographyProps={{ variant: 'body2' }}
                />
              </ListItem>
              <ListItem disablePadding sx={{ py: 0.25 }}>
                <ListItemText
                  primary="Ends"
                  secondary={
                    formData.terminationDate ? formatDateDisplay(formData.terminationDate) : 'No end date'
                  }
                  primaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                  secondaryTypographyProps={{ variant: 'body2' }}
                />
              </ListItem>
            </List>
          </Paper>
        </Grid>

        <Grid size={{ xs: 12, md: 6 }}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="caption" color="primary" fontWeight={600}>
              Flags
            </Typography>
            <Box sx={{ mt: 0.5, display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              <Chip
                icon={<CheckIcon />}
                label="Renewable"
                size="small"
                color={formData.renewable ? 'success' : 'default'}
                variant={formData.renewable ? 'filled' : 'outlined'}
              />
              <Chip
                icon={<CheckIcon />}
                label="Bonus"
                size="small"
                color={formData.bonusEligible ? 'success' : 'default'}
                variant={formData.bonusEligible ? 'filled' : 'outlined'}
              />
            </Box>
          </Paper>
        </Grid>

        {formData.notes && (
          <Grid size={12}>
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Typography variant="caption" color="primary" fontWeight={600}>
                Notes
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5 }}>
                {formData.notes}
              </Typography>
            </Paper>
          </Grid>
        )}
      </Grid>
    </Box>
  );
};
