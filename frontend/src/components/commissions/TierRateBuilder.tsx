// src/components/commissions/TierRateBuilder.tsx
import React from 'react';
import {
  Box,
  Grid,
  Typography,
  TextField,
  IconButton,
  Button,
  Card,
  CardContent,
  Slider,
  Chip,
  Alert,
  InputAdornment,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Warning as WarningIcon,
} from '@mui/icons-material';

interface Tier {
  level: number;
  name: string;
  rate?: number;
  flatAmount?: number;
  minVolume?: number;
  maxVolume?: number;
}

interface TierRateBuilderProps {
  tiers: Tier[];
  onChange: (tiers: Tier[]) => void;
  validationRules?: any[];
  type?: 'percentage' | 'flat' | 'volume';
}

const defaultTiers = [
  { level: 0, name: 'Agent', rate: 0.05 },
  { level: 1, name: 'GA', rate: 0.02 },
  { level: 2, name: 'MGA', rate: 0.01 },
  { level: 3, name: 'FMO', rate: 0.005 },
  { level: 4, name: 'IMO', rate: 0.0025 },
  { level: 5, name: 'NMO', rate: 0.001 },
];

export const TierRateBuilder: React.FC<TierRateBuilderProps> = ({
  tiers,
  onChange,
  type = 'percentage',
}) => {
  // Add tier
  const handleAddTier = () => {
    const newTier: Tier = {
      level: tiers.length,
      name: `Tier ${tiers.length + 1}`,
      rate: type === 'percentage' ? 0 : undefined,
      flatAmount: type === 'flat' ? 0 : undefined,
      minVolume: type === 'volume' ? 0 : undefined,
      maxVolume: type === 'volume' ? 100 : undefined,
    };
    onChange([...tiers, newTier]);
  };

  // Remove tier
  const handleRemoveTier = (index: number) => {
    const newTiers = tiers.filter((_, i) => i !== index);
    // Reindex levels
    const reindexed = newTiers.map((tier, i) => ({ ...tier, level: i }));
    onChange(reindexed);
  };

  // Update tier
  const handleUpdateTier = (index: number, updates: Partial<Tier>) => {
    const newTiers = [...tiers];
    newTiers[index] = { ...newTiers[index], ...updates };
    onChange(newTiers);
  };

  // Calculate total commission
  const totalCommission = tiers.reduce((sum, tier) => sum + (tier.rate || 0), 0);
  const isOverLimit = totalCommission > 0.25; // 25% limit

  // Use default tiers if empty
  const handleUseTemplate = () => {
    onChange(defaultTiers);
  };

  return (
    <Box>
      <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="h6">Tier Configuration</Typography>
        {tiers.length === 0 && (
          <Button
            variant="outlined"
            size="small"
            onClick={handleUseTemplate}
          >
            Use Standard Template
          </Button>
        )}
      </Box>

      {isOverLimit && (
        <Alert severity="warning" sx={{ mb: 2 }} icon={<WarningIcon />}>
          Total commission rate ({(totalCommission * 100).toFixed(2)}%) exceeds maximum allowed 25%
        </Alert>
      )}

      <Grid container spacing={2}>
        {tiers.map((tier, index) => (
          <Grid size={12} key={index}>
            <Card variant="outlined">
              <CardContent>
                <Grid container spacing={2} alignItems="center">
                  <Grid size={{ xs: 12, md: 3 }}>
                    <TextField
                      fullWidth
                      label="Tier Name"
                      value={tier.name}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateTier(index, { name: e.target.value })}
                      size="small"
                    />
                  </Grid>
                  
                  {type === 'percentage' && (
                    <>
                      <Grid size={{ xs: 12, md: 6 }}>
                        <Typography gutterBottom>
                          Rate: {((tier.rate || 0) * 100).toFixed(2)}%
                        </Typography>
                        <Slider
                          value={(tier.rate || 0) * 100}
                          onChange={(_: any, value: any) => handleUpdateTier(index, { rate: (value as number) / 100 })}
                          min={0}
                          max={10}
                          step={0.01}
                          marks={[
                            { value: 0, label: '0%' },
                            { value: 5, label: '5%' },
                            { value: 10, label: '10%' },
                          ]}
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 2 }}>
                        <TextField
                          fullWidth
                          type="number"
                          value={(tier.rate || 0) * 100}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateTier(index, { rate: parseFloat(e.target.value) / 100 })}
                          size="small"
                          InputProps={{
                            endAdornment: <InputAdornment position="end">%</InputAdornment>,
                          }}
                          inputProps={{ min: 0, max: 100, step: 0.01 }}
                        />
                      </Grid>
                    </>
                  )}

                  {type === 'flat' && (
                    <Grid size={{ xs: 12, md: 8 }}>
                      <TextField
                        fullWidth
                        label="Flat Amount"
                        type="number"
                        value={tier.flatAmount || 0}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateTier(index, { flatAmount: parseFloat(e.target.value) })}
                        size="small"
                        InputProps={{
                          startAdornment: <InputAdornment position="start">$</InputAdornment>,
                        }}
                        inputProps={{ min: 0, step: 0.01 }}
                      />
                    </Grid>
                  )}

                  {type === 'volume' && (
                    <>
                      <Grid size={{ xs: 12, md: 3 }}>
                        <TextField
                          fullWidth
                          label="Min Volume"
                          type="number"
                          value={tier.minVolume || 0}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateTier(index, { minVolume: parseInt(e.target.value) })}
                          size="small"
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 3 }}>
                        <TextField
                          fullWidth
                          label="Max Volume"
                          type="number"
                          value={tier.maxVolume || 0}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateTier(index, { maxVolume: parseInt(e.target.value) })}
                          size="small"
                        />
                      </Grid>
                      <Grid size={{ xs: 12, md: 2 }}>
                        <TextField
                          fullWidth
                          label="Rate"
                          type="number"
                          value={(tier.rate || 0) * 100}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleUpdateTier(index, { rate: parseFloat(e.target.value) / 100 })}
                          size="small"
                          InputProps={{
                            endAdornment: <InputAdornment position="end">%</InputAdornment>,
                          }}
                        />
                      </Grid>
                    </>
                  )}

                  <Grid size={{ xs: 12, md: 1 }}>
                    <IconButton
                      color="error"
                      onClick={() => handleRemoveTier(index)}
                      disabled={tiers.length === 1}
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Grid>
                </Grid>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button
          variant="outlined"
          startIcon={<AddIcon />}
          onClick={handleAddTier}
        >
          Add Tier
        </Button>
        
        {type === 'percentage' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" color="textSecondary">
              Total Commission:
            </Typography>
            <Chip
              label={`${(totalCommission * 100).toFixed(2)}%`}
              color={isOverLimit ? 'error' : 'success'}
              size="small"
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};