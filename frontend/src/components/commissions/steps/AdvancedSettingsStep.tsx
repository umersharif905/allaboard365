// src/components/commissions/steps/AdvancedSettingsStep.tsx
import React from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import {
  Box,
  Typography,
  Grid,
  TextField,
  FormControlLabel,
  Switch,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Alert,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon,
  CalendarToday as CalendarIcon,
  Notes as NotesIcon,
  Lock as LockIcon,
} from '@mui/icons-material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import { RuleCreationFormData } from '../RuleCreationWizard';

export const AdvancedSettingsStep: React.FC = () => {
  const { control, watch } = useFormContext<RuleCreationFormData>();
  
  const renewable = watch('renewable');
  const bonusEligible = watch('bonusEligible');
  const effectiveDate = watch('effectiveDate');
  const locked = watch('locked');

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        Dates
      </Typography>

      <Grid container spacing={3} sx={{ mt: 1 }}>
        {/* Date Settings */}
        <Grid size={12}>
          <Box sx={{ p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
            <Box display="flex" alignItems="center" gap={1} mb={2}>
              <CalendarIcon color="primary" />
              <Typography variant="subtitle1" fontWeight="bold">
                Effective dates
              </Typography>
            </Box>
            
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                <Controller
                  name="effectiveDate"
                  control={control}
                  render={({ field, fieldState }) => (
                    <LocalizationProvider dateAdapter={AdapterDateFns}>
                      <DatePicker
                        label="Effective Date"
                        value={field.value}
                        onChange={(date) => field.onChange(date)}
                        disabled={false}
                        slotProps={{
                          textField: {
                            fullWidth: true,
                            error: !!fieldState.error,
                            helperText: fieldState.error?.message || 'Start date',
                            required: true,
                          },
                        }}
                        minDate={new Date()}
                      />
                    </LocalizationProvider>
                  )}
                />
              </Grid>
              
              <Grid size={{ xs: 12, md: 6 }}>
                <Controller
                  name="terminationDate"
                  control={control}
                  render={({ field, fieldState }) => (
                    <LocalizationProvider dateAdapter={AdapterDateFns}>
                      <DatePicker
                        label="Termination Date (Optional)"
                        value={field.value}
                        onChange={(date) => field.onChange(date)}
                        slotProps={{
                          textField: {
                            fullWidth: true,
                            error: !!fieldState.error,
                            helperText: fieldState.error?.message || 'Leave blank for no end date',
                          },
                        }}
                        minDate={effectiveDate || new Date()}
                      />
                    </LocalizationProvider>
                  )}
                />
              </Grid>
            </Grid>
          </Box>
        </Grid>

        {/* Renewable Commission */}
        {/* <Grid size={{ xs: 12, md: 6 }}>
          <Controller
            name="renewable"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Switch
                    {...field}
                    checked={field.value}
                    color="primary"
                    disabled={locked}
                  />
                }
                label={
                  <Box display="flex" alignItems="center" gap={1}>
                    <RenewableIcon />
                    <Box>
                      <Typography variant="body1">Renewable Commission</Typography>
                      <Typography variant="caption" color="textSecondary">
                        Commission paid on policy renewals
                      </Typography>
                    </Box>
                  </Box>
                }
              />
            )}
          />
        </Grid> */}

        {/* Bonus Eligible */}
        {/* <Grid size={{ xs: 12, md: 6 }}>
          <Controller
            name="bonusEligible"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Switch
                    {...field}
                    checked={field.value}
                    color="primary"
                    disabled={locked}
                  />
                }
                label={
                  <Box display="flex" alignItems="center" gap={1}>
                    <BonusIcon />
                    <Box>
                      <Typography variant="body1">Bonus Eligible</Typography>
                      <Typography variant="caption" color="textSecondary">
                        Eligible for performance bonuses
                      </Typography>
                    </Box>
                  </Box>
                }
              />
            )}
          />
        </Grid> */}

        {/* Optional Advanced Configurations */}
        {/* <Grid size={12}>
          <Typography variant="subtitle2" gutterBottom sx={{ mt: 2 }}>
            Optional Configurations
          </Typography>
          
          {/* Yearly Schedule Accordion */}
          {/* <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box display="flex" alignItems="center" gap={1}>
                <ScheduleIcon />
                <Typography>Yearly Rate Schedule</Typography>
                <Chip label="Optional" size="small" />
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Alert severity="info" sx={{ mb: 2 }}>
                <Typography variant="body2">
                  Configure different commission rates for each policy year. 
                  Leave empty to use the same rate for all years.
                </Typography>
              </Alert>
              <Typography variant="body2" color="textSecondary">
                Feature available in future release (coming soon)
              </Typography>
            </AccordionDetails>
          </Accordion> */}

          {/* State Overrides Accordion */}
          {/* <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Box display="flex" alignItems="center" gap={1}>
                <MapIcon />
                <Typography>State-Specific Overrides</Typography>
                <Chip label="Optional" size="small" />
              </Box>
            </AccordionSummary>
            <AccordionDetails>
              <Alert severity="info" sx={{ mb: 2 }}>
                <Typography variant="body2">
                  Set different commission rates for specific states due to 
                  regulatory requirements or market conditions.
                </Typography>
              </Alert>
              <Typography variant="body2" color="textSecondary">
                Feature available in future release (coming soon)
              </Typography>
            </AccordionDetails>
          </Accordion> */}

          {/* Bonus Thresholds Accordion */}
          {/* {bonusEligible && (
            <Accordion>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Box display="flex" alignItems="center" gap={1}>
                  <BonusIcon />
                  <Typography>Bonus Thresholds</Typography>
                  <Chip label="Optional" size="small" />
                </Box>
              </AccordionSummary>
              <AccordionDetails>
                <Alert severity="info" sx={{ mb: 2 }}>
                  <Typography variant="body2">
                    Define performance thresholds that trigger bonus payments.
                  </Typography>
                </Alert>
                <Typography variant="body2" color="textSecondary">
                  Feature available in next release
                </Typography>
              </AccordionDetails>
            </Accordion>
          )} */}
        {/* </Grid> */}

        <Grid size={12}>
          <Accordion defaultExpanded={false}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle2">More options</Typography>
              <Chip label="Optional" size="small" sx={{ ml: 1 }} />
            </AccordionSummary>
            <AccordionDetails>
              <Grid container spacing={2}>
        {/* Notes */}
        <Grid size={12}>
          <Box display="flex" alignItems="center" gap={1} mb={1}>
            <NotesIcon />
            <Typography variant="subtitle2">Additional Notes</Typography>
          </Box>
          <Controller
            name="notes"
            control={control}
            render={({ field, fieldState }) => (
              <TextField
                {...field}
                fullWidth
                multiline
                rows={3}
                placeholder="Add any special instructions, exceptions, or notes about this commission rule..."
                error={!!fieldState.error}
                helperText={fieldState.error?.message}
                disabled={false}
              />
            )}
          />
        </Grid>

        {/* Lock Rule */}
        <Grid size={12}>
          <Box sx={{ p: 2, bgcolor: 'warning.light', borderRadius: 1, border: '1px solid', borderColor: 'warning.main' }}>
            <Box display="flex" alignItems="center" gap={1} mb={1}>
              <LockIcon color="warning" />
              <Typography variant="subtitle1" fontWeight="bold">
                Lock Rule
              </Typography>
            </Box>
            <Typography variant="body2" color="textSecondary" sx={{ mb: 2 }}>
              A locked rule is active for commission calculations. You can still edit fields below; use Unlock in the rules list only when the system allows unlocking.
            </Typography>
            <Controller
              name="locked"
              control={control}
              render={({ field }) => (
                <FormControlLabel
                  control={
                    <Switch
                      checked={field.value || false}
                      onChange={(e) => {
                        // Only allow setting to true, not false if already locked
                        if (!locked || e.target.checked) {
                          field.onChange(e.target.checked);
                        }
                      }}
                      disabled={locked === true} // Disable if already locked
                      color="warning"
                    />
                  }
                  label={locked ? "Rule is locked (cannot be unlocked)" : "Lock this rule (cannot be undone)"}
                />
              )}
            />
            {locked && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                <Typography variant="body2">
                  <strong>Note:</strong> This rule is locked. The lock switch cannot be turned off here; use Unlock from the commission rules menu when permitted.
                </Typography>
              </Alert>
            )}
          </Box>
        </Grid>

              </Grid>
            </AccordionDetails>
          </Accordion>
        </Grid>

        {/* Summary of renewable settings */}
        {/* {renewable && (
          <Grid size={12}>
            <Alert severity="success">
              <Typography variant="body2">
                <strong>Renewable Commission Enabled:</strong> Commission will be paid on policy renewals 
                at the configured rate until the termination date (if set).
              </Typography>
            </Alert>
          </Grid>
        )} */}
      </Grid>
    </Box>
  );
};