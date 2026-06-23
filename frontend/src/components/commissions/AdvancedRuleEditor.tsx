// src/components/commissions/AdvancedRuleEditor.tsx
import React, { useState } from 'react';
import {
  Box,
  Grid,
  TextField,
  Button,
  Typography,
  Tabs,
  Tab,
  Paper,
  Alert,
  FormControlLabel,
  Switch,
  IconButton,
  Tooltip,
  Divider,
} from '@mui/material';
import {
  Save as SaveIcon,
  Cancel as CancelIcon,
  Code as CodeIcon,
  Description as DescriptionIcon,
  Schedule as ScheduleIcon,
  Map as MapIcon,
  EmojiEvents as BonusIcon,
  ContentCopy as CopyIcon,
  RestartAlt as ResetIcon,
} from '@mui/icons-material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';
import Editor from '@monaco-editor/react';

interface AdvancedRuleEditorProps {
  rule: any;
  onSave: (rule: any) => void;
  onCancel: () => void;
}

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

const TabPanel: React.FC<TabPanelProps> = ({ children, value, index, ...other }) => {
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`rule-tabpanel-${index}`}
      aria-labelledby={`rule-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
};

// Simple TierRateBuilder component
const TierRateBuilder: React.FC<{
  tiers: any[];
  onChange: (tiers: any[]) => void;
}> = ({ tiers, onChange }) => {
  const addTier = () => {
    onChange([...tiers, { level: tiers.length, name: `Tier ${tiers.length + 1}`, rate: 0 }]);
  };

  const removeTier = (index: number) => {
    onChange(tiers.filter((_, i) => i !== index));
  };

  const updateTier = (index: number, field: string, value: any) => {
    const newTiers = [...tiers];
    newTiers[index] = { ...newTiers[index], [field]: value };
    onChange(newTiers);
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Tier Configuration
      </Typography>
      {tiers.map((tier, index) => (
        <Box key={index} sx={{ mb: 2, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
          <Grid container spacing={2} alignItems="center">
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                fullWidth
                label="Tier Name"
                value={tier.name}
                onChange={(e) => updateTier(index, 'name', e.target.value)}
                size="small"
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <TextField
                fullWidth
                label="Rate"
                type="number"
                value={tier.rate * 100}
                onChange={(e) => updateTier(index, 'rate', parseFloat(e.target.value) / 100)}
                size="small"
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <Button
                variant="outlined"
                color="error"
                onClick={() => removeTier(index)}
                size="small"
              >
                Remove
              </Button>
            </Grid>
          </Grid>
        </Box>
      ))}
      <Button variant="outlined" onClick={addTier}>
        Add Tier
      </Button>
    </Box>
  );
};

export const AdvancedRuleEditor: React.FC<AdvancedRuleEditorProps> = ({
  rule,
  onSave,
  onCancel,
}) => {
  const [activeTab, setActiveTab] = useState(0);
  const [editedRule, setEditedRule] = useState({ ...rule });
  const [jsonError, setJsonError] = useState('');

  const handleSave = () => {
    // Validate JSON if editing raw
    if (activeTab === 4) {
      try {
        JSON.parse(JSON.stringify(editedRule.jsonConfig));
      } catch (error) {
        setJsonError('Invalid JSON configuration');
        return;
      }
    }
    onSave(editedRule);
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  const updateJsonConfig = (path: string, value: any) => {
    const newJsonConfig = { ...editedRule.jsonConfig };
    const keys = path.split('.');
    let current = newJsonConfig;
    
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) {
        current[keys[i]] = {};
      }
      current = current[keys[i]];
    }
    
    current[keys[keys.length - 1]] = value;
    setEditedRule({ ...editedRule, jsonConfig: newJsonConfig });
  };

  return (
    <Box sx={{ width: '100%' }}>
      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={activeTab} onChange={handleTabChange}>
          <Tab icon={<DescriptionIcon />} label="Basic" />
          <Tab icon={<ScheduleIcon />} label="Schedule" />
          <Tab icon={<MapIcon />} label="State Overrides" />
          <Tab icon={<BonusIcon />} label="Bonuses" />
          <Tab icon={<CodeIcon />} label="JSON Editor" />
        </Tabs>
      </Box>

      {/* Basic Tab */}
      <TabPanel value={activeTab} index={0}>
        <Grid container spacing={3}>
          <Grid size={12}>
            <TextField
              fullWidth
              label="Rule Name"
              value={editedRule.ruleName}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditedRule({ ...editedRule, ruleName: e.target.value })}
            />
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <LocalizationProvider dateAdapter={AdapterDateFns}>
              <DatePicker
                label="Effective Date"
                value={new Date(editedRule.effectiveDate)}
                onChange={(date: Date | null) => date && setEditedRule({ ...editedRule, effectiveDate: date.toISOString() })}
                slotProps={{
                  textField: {
                    fullWidth: true,
                    size: 'small'
                  }
                }}
              />
            </LocalizationProvider>
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <LocalizationProvider dateAdapter={AdapterDateFns}>
              <DatePicker
                label="Termination Date"
                value={editedRule.terminationDate ? new Date(editedRule.terminationDate) : null}
                onChange={(date: Date | null) => setEditedRule({ ...editedRule, terminationDate: date?.toISOString() || null })}
                slotProps={{
                  textField: {
                    fullWidth: true,
                    size: 'small'
                  }
                }}
              />
            </LocalizationProvider>
          </Grid>
          <Grid size={12}>
            <FormControlLabel
              control={
                <Switch
                  checked={editedRule.jsonConfig?.renewable || false}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateJsonConfig('renewable', e.target.checked)}
                />
              }
              label="Renewable Commission"
            />
          </Grid>
          {editedRule.commissionType === 'Tiered' && (
            <Grid size={12}>
              <TierRateBuilder
                tiers={editedRule.jsonConfig?.tiers || []}
                onChange={(tiers) => updateJsonConfig('tiers', tiers)}
              />
            </Grid>
          )}
        </Grid>
      </TabPanel>

      {/* Schedule Tab */}
      <TabPanel value={activeTab} index={1}>
        <Typography variant="h6" gutterBottom>
          Yearly Commission Schedule
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          Define different commission rates for each year of the policy
        </Alert>
        <Grid container spacing={3}>
          <Grid size={12}>
            <TextField
              fullWidth
              label="Year 1 Rate"
              type="number"
              placeholder="Enter rate for first year"
              size="small"
            />
          </Grid>
          <Grid size={12}>
            <TextField
              fullWidth
              label="Year 2 Rate"
              type="number"
              placeholder="Enter rate for second year"
              size="small"
            />
          </Grid>
          <Grid size={12}>
            <TextField
              fullWidth
              label="Year 3+ Rate"
              type="number"
              placeholder="Enter rate for subsequent years"
              size="small"
            />
          </Grid>
        </Grid>
      </TabPanel>

      {/* State Overrides Tab */}
      <TabPanel value={activeTab} index={2}>
        <Typography variant="h6" gutterBottom>
          State-Specific Overrides
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          Set different commission rates for specific states
        </Alert>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, md: 6 }}>
            <TextField
              fullWidth
              label="State"
              placeholder="Select state"
              size="small"
            />
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            <TextField
              fullWidth
              label="Override Rate"
              type="number"
              placeholder="Enter override rate"
              size="small"
            />
          </Grid>
        </Grid>
      </TabPanel>

      {/* Bonuses Tab */}
      <TabPanel value={activeTab} index={3}>
        <Typography variant="h6" gutterBottom>
          Bonus Configuration
        </Typography>
        <Grid container spacing={3}>
          <Grid size={12}>
            <FormControlLabel
              control={
                <Switch
                  checked={editedRule.jsonConfig?.bonusEligible || false}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateJsonConfig('bonusEligible', e.target.checked)}
                />
              }
              label="Eligible for Bonuses"
            />
          </Grid>
          {editedRule.jsonConfig?.bonusEligible && (
            <>
              <Grid size={{ xs: 12, md: 6 }}>
                <TextField
                  fullWidth
                  label="Bonus Threshold"
                  type="number"
                  placeholder="Enter minimum volume for bonus"
                  size="small"
                />
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                <TextField
                  fullWidth
                  label="Bonus Rate"
                  type="number"
                  placeholder="Enter bonus rate"
                  size="small"
                />
              </Grid>
            </>
          )}
        </Grid>
      </TabPanel>

      {/* JSON Editor Tab */}
      <TabPanel value={activeTab} index={4}>
        <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
          <Typography variant="h6">JSON Configuration</Typography>
          <Box>
            <Tooltip title="Copy JSON">
              <IconButton
                onClick={() => navigator.clipboard.writeText(JSON.stringify(editedRule.jsonConfig, null, 2))}
              >
                <CopyIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Reset to Original">
              <IconButton
                onClick={() => setEditedRule({ ...rule })}
              >
                <ResetIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        {jsonError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {jsonError}
          </Alert>
        )}
        <Paper variant="outlined" sx={{ height: 400 }}>
          <Editor
            height="100%"
            defaultLanguage="json"
            value={JSON.stringify(editedRule.jsonConfig, null, 2)}
            onChange={(value: string | undefined) => {
              try {
                const parsed = JSON.parse(value || '{}');
                setEditedRule({ ...editedRule, jsonConfig: parsed });
                setJsonError('');
              } catch (error) {
                setJsonError('Invalid JSON format');
              }
            }}
            theme="vs-light"
            options={{
              minimap: { enabled: false },
              fontSize: 14,
            }}
          />
        </Paper>
      </TabPanel>

      {/* Actions */}
      <Divider sx={{ mt: 3, mb: 2 }} />
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button
          variant="outlined"
          onClick={onCancel}
          startIcon={<CancelIcon />}
        >
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          startIcon={<SaveIcon />}
        >
          Save Changes
        </Button>
      </Box>
    </Box>
  );
};