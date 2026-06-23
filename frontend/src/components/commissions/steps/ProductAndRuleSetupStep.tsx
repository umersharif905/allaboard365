// Combined wizard step: product selection + rule type (compact).
import React from 'react';
import { Box, Divider, Typography } from '@mui/material';
import { ProductSelectionStep } from './ProductSelectionStep';
import { RuleTypeStep } from './RuleTypeStep';

export const ProductAndRuleSetupStep: React.FC = () => {
  return (
    <Box>
      <ProductSelectionStep compact />
      <Divider sx={{ my: 3 }} />
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        Scope & type
      </Typography>
      <RuleTypeStep compact />
    </Box>
  );
};
