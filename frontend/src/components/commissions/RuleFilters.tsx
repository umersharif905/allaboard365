// src/components/commissions/RuleFilters.tsx
import React, { useState } from 'react';
import {
  Box,
  Grid,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Button,
  Chip,
  Typography,
  Collapse,
  IconButton,
} from '@mui/material';
import {
  FilterList as FilterIcon,
  Clear as ClearIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDateFns } from '@mui/x-date-pickers/AdapterDateFns';

interface RuleFiltersProps {
  onFilterChange: (filters: any) => void;
  productId?: string;
}

// Mock products data
const mockProducts = [
  { productId: 'prod-1', productName: 'Medicare Advantage' },
  { productId: 'prod-2', productName: 'Life Insurance' },
  { productId: 'prod-3', productName: 'Disability Insurance' },
  { productId: 'prod-4', productName: 'Dental Insurance' },
];

export const RuleFilters: React.FC<RuleFiltersProps> = ({
  onFilterChange,
  productId,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [filters, setFilters] = useState({
    productId: productId || '',
    status: '',
    entityType: '',
    commissionType: '',
    effectiveDate: null as Date | null,
    terminationDate: null as Date | null,
    search: '',
  });

  // Mock products hook
  const products = mockProducts;

  // Handle filter changes
  const handleFilterChange = (field: string, value: any) => {
    const newFilters = { ...filters, [field]: value };
    setFilters(newFilters);
    onFilterChange(newFilters);
  };

  // Clear all filters
  const handleClearFilters = () => {
    const clearedFilters = {
      productId: productId || '',
      status: '',
      entityType: '',
      commissionType: '',
      effectiveDate: null,
      terminationDate: null,
      search: '',
    };
    setFilters(clearedFilters);
    onFilterChange(clearedFilters);
  };

  // Count active filters
  const activeFilterCount = Object.values(filters).filter(
    (value) => value && value !== ''
  ).length;

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <FilterIcon color="action" />
          <Typography variant="h6">Filters</Typography>
          {activeFilterCount > 0 && (
            <Chip
              label={activeFilterCount}
              size="small"
              color="primary"
            />
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <IconButton
            onClick={() => setExpanded(!expanded)}
            size="small"
          >
            {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
          <Button
            variant="outlined"
            size="small"
            onClick={handleClearFilters}
            startIcon={<ClearIcon />}
            disabled={activeFilterCount === 0}
          >
            Clear All
          </Button>
        </Box>
      </Box>

      <Collapse in={expanded}>
        <Grid container spacing={3}>
          <Grid size="grow">
            <TextField
              fullWidth
              label="Search Rules"
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
              placeholder="Search by rule name..."
              size="small"
            />
          </Grid>
          <Grid size="auto">
            <Button
              variant="contained"
              startIcon={<FilterIcon />}
              onClick={() => {
                // Apply filters (already applied on change)
                setExpanded(false);
              }}
            >
              Apply Filters
            </Button>
          </Grid>
        </Grid>

        <Grid container spacing={3} sx={{ mt: 1 }}>
          <Grid size={{ xs: 12, md: 4 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Product</InputLabel>
              <Select
                value={filters.productId}
                onChange={(e) => handleFilterChange('productId', e.target.value)}
                label="Product"
              >
                <MenuItem value="">All Products</MenuItem>
                {products.map((product) => (
                  <MenuItem key={product.productId} value={product.productId}>
                    {product.productName}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Status</InputLabel>
              <Select
                value={filters.status}
                onChange={(e) => handleFilterChange('status', e.target.value)}
                label="Status"
              >
                <MenuItem value="">All Statuses</MenuItem>
                <MenuItem value="Active">Active</MenuItem>
                <MenuItem value="Inactive">Inactive</MenuItem>
                <MenuItem value="Pending">Pending</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Entity Type</InputLabel>
              <Select
                value={filters.entityType}
                onChange={(e) => handleFilterChange('entityType', e.target.value)}
                label="Entity Type"
              >
                <MenuItem value="">All Types</MenuItem>
                <MenuItem value="Agent">Agent</MenuItem>
                <MenuItem value="Agency">Agency</MenuItem>
                <MenuItem value="Tier">Tier</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <FormControl fullWidth size="small">
              <InputLabel>Commission Type</InputLabel>
              <Select
                value={filters.commissionType}
                onChange={(e) => handleFilterChange('commissionType', e.target.value)}
                label="Commission Type"
              >
                <MenuItem value="">All Types</MenuItem>
                <MenuItem value="Percentage">Percentage</MenuItem>
                <MenuItem value="Flat">Flat Amount</MenuItem>
                <MenuItem value="Tiered">Tiered</MenuItem>
              </Select>
            </FormControl>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <LocalizationProvider dateAdapter={AdapterDateFns}>
              <DatePicker
                label="Effective Date From"
                value={filters.effectiveDate}
                onChange={(date) => handleFilterChange('effectiveDate', date)}
                slotProps={{
                  textField: {
                    fullWidth: true,
                    size: 'small'
                  }
                }}
              />
            </LocalizationProvider>
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <LocalizationProvider dateAdapter={AdapterDateFns}>
              <DatePicker
                label="Effective Date To"
                value={filters.terminationDate}
                onChange={(date) => handleFilterChange('terminationDate', date)}
                slotProps={{
                  textField: {
                    fullWidth: true,
                    size: 'small'
                  }
                }}
              />
            </LocalizationProvider>
          </Grid>
        </Grid>
      </Collapse>

      {/* Active Filters Display */}
      {activeFilterCount > 0 && (
        <Box sx={{ mt: 2, display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" color="textSecondary" sx={{ mr: 1 }}>
            Active Filters:
          </Typography>
          {filters.search && (
            <Chip
              label={`Search: ${filters.search}`}
              size="small"
              onDelete={() => handleFilterChange('search', '')}
            />
          )}
          {filters.productId && (
            <Chip
              label={`Product: ${products.find(p => p.productId === filters.productId)?.productName}`}
              size="small"
              onDelete={() => handleFilterChange('productId', '')}
            />
          )}
          {filters.status && (
            <Chip
              label={`Status: ${filters.status}`}
              size="small"
              onDelete={() => handleFilterChange('status', '')}
            />
          )}
          {filters.entityType && (
            <Chip
              label={`Entity: ${filters.entityType}`}
              size="small"
              onDelete={() => handleFilterChange('entityType', '')}
            />
          )}
          {filters.commissionType && (
            <Chip
              label={`Type: ${filters.commissionType}`}
              size="small"
              onDelete={() => handleFilterChange('commissionType', '')}
            />
          )}
          {filters.effectiveDate && (
            <Chip
              label={`From: ${filters.effectiveDate.toLocaleDateString()}`}
              size="small"
              onDelete={() => handleFilterChange('effectiveDate', null)}
            />
          )}
          {filters.terminationDate && (
            <Chip
              label={`To: ${filters.terminationDate.toLocaleDateString()}`}
              size="small"
              onDelete={() => handleFilterChange('terminationDate', null)}
            />
          )}
        </Box>
      )}
    </Box>
  );
};