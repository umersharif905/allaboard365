// frontend/src/components/census/CensusImportPreview.tsx
import {
  CheckCircle as CheckCircleIcon,
  Delete as DeleteIcon,
  Error as ErrorIcon,
  ExpandMore as ExpandMoreIcon,
  People as PeopleIcon,
  Person as PersonIcon,
} from '@mui/icons-material';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  AlertTitle,
  alpha,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import React, { useState } from 'react';
import { CreateMemberData } from '../../types/member.types';
import { DEFAULT_JOB_POSITIONS } from '../../constants/jobPositions';

// Types
interface ParsedHousehold {
  primaryMember: CreateMemberData & { locationId?: string; locationName?: string };
  dependents: Array<CreateMemberData & { locationId?: string; locationName?: string }>;
}

interface ParsedCensusData {
  households: ParsedHousehold[];
  warnings?: string[];
  statistics: {
    totalMembers: number;
    households: number;
    primaryMembers: number;
    dependents: number;
  };
}

interface Location {
  LocationId: string;
  Name?: string;
  Address: string;
  City: string;
  State: string;
  IsPrimary?: boolean;
}

interface CensusImportPreviewProps {
  open: boolean;
  onClose: () => void;
  parsedData: ParsedCensusData | null;
  locations: Location[];
  onConfirm: (households: ParsedHousehold[]) => void;
  loading?: boolean;
  onCancel?: () => void; // Optional cancel handler for AI processing
}

const CensusImportPreview: React.FC<CensusImportPreviewProps> = ({
  open,
  onClose,
  parsedData,
  locations,
  onConfirm,
  loading = false,
  onCancel,
}) => {
  const theme = useTheme();
  const [households, setHouseholds] = useState<ParsedHousehold[]>([]);
  const [expandedHousehold, setExpandedHousehold] = useState<number | false>(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [householdToDelete, setHouseholdToDelete] = useState<number | null>(null);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [selectedHouseholds, setSelectedHouseholds] = useState<Set<number>>(new Set());
  
  // Filter locations to only show Active ones (if Status field exists)
  const activeLocations = React.useMemo(() => {
    return locations.filter(loc => !('Status' in loc) || (loc as any).Status === 'Active');
  }, [locations]);
  
  // Get primary location
  const primaryLocation = React.useMemo(() => {
    return activeLocations.find(loc => loc.IsPrimary) || activeLocations[0];
  }, [activeLocations]);

  // Validate date format (YYYY-MM-DD)
  const isValidDate = (dateStr: string): boolean => {
    if (!dateStr || dateStr.trim() === '') return true; // Empty is valid (optional field)
    const trimmed = dateStr.trim();
    // Check for YYYY-MM-DD format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(trimmed)) return false;
    // Validate the date is actually valid (not like 2021-13-45)
    // Use UTC to avoid timezone issues that could cause date shifts
    const [year, month, day] = trimmed.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    // Check that the date is valid and matches the input
    return date.getUTCFullYear() === year && 
           date.getUTCMonth() + 1 === month && 
           date.getUTCDate() === day &&
           !isNaN(date.getTime());
  };

  // Detect errors for a household - returns array of error messages
  const getHouseholdErrors = React.useCallback((household: ParsedHousehold): string[] => {
    const errors: string[] = [];
    
    // Check primary member
    const primary = household.primaryMember;
    if (!primary.firstName) {
      errors.push('Missing first name');
    }
    if (!primary.lastName) {
      errors.push('Missing last name');
    }
    if (!primary.email) {
      errors.push('Missing email');
    }
    if (primary.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(primary.email)) {
      errors.push('Invalid email format');
    }
    if (primary.dateOfBirth && !isValidDate(primary.dateOfBirth)) {
      errors.push(`Invalid date of birth: ${primary.dateOfBirth}`);
    }
    
    // Check dependents
    household.dependents.forEach((dep, idx) => {
      if (!dep.firstName) {
        errors.push(`Dependent ${idx + 1}: Missing first name`);
      }
      if (!dep.lastName) {
        errors.push(`Dependent ${idx + 1}: Missing last name`);
      }
      // Email is optional for spouses (system will generate default if missing)
      // Email validation only if provided
      if (dep.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dep.email)) {
        errors.push(`Dependent ${idx + 1}: Invalid email format`);
      }
      if (dep.dateOfBirth && !isValidDate(dep.dateOfBirth)) {
        errors.push(`Dependent ${idx + 1}: Invalid date of birth`);
      }
    });
    
    return errors;
  }, []);

  // Initialize households from parsedData when it changes
  React.useEffect(() => {
    if (parsedData && parsedData.households) {
      // Sort households: those with errors first
      const sorted = [...parsedData.households].sort((a, b) => {
        const aHasErrors = getHouseholdErrors(a).length > 0;
        const bHasErrors = getHouseholdErrors(b).length > 0;
        if (aHasErrors && !bHasErrors) return -1;
        if (!aHasErrors && bHasErrors) return 1;
        return 0;
      });
      setHouseholds(sorted);
      // Expand first household by default (which will be first error household if any)
      setExpandedHousehold(0);
    }
  }, [parsedData, getHouseholdErrors]);

  // Get all households with errors
  const householdsWithErrors = households.filter(h => getHouseholdErrors(h).length > 0);
  const hasErrors = householdsWithErrors.length > 0;

  // Match locationName to locationId if not already matched
  const matchLocation = (locationName?: string): string => {
    if (!locationName) return primaryLocation?.LocationId || '';
    
    // Try to find exact match (case-insensitive)
    const matched = activeLocations.find(loc => 
      (loc.Name || '').toLowerCase() === locationName.toLowerCase()
    );
    
    if (matched) {
      return matched.LocationId;
    }
    
    // Return primary location if no match
    return primaryLocation?.LocationId || '';
  };
  
  // Handle delete household - COMMENTED OUT: Individual delete button removed, only bulk delete in Edit mode
  // const handleDeleteClick = (householdIndex: number) => {
  //   setHouseholdToDelete(householdIndex);
  //   setDeleteConfirmOpen(true);
  // };
  

  const handleToggleEditMode = () => {
    setEditMode(!editMode);
    setSelectedHouseholds(new Set());
  };

  const handleToggleHouseholdSelection = (householdIndex: number) => {
    const newSelected = new Set(selectedHouseholds);
    if (newSelected.has(householdIndex)) {
      newSelected.delete(householdIndex);
    } else {
      newSelected.add(householdIndex);
    }
    setSelectedHouseholds(newSelected);
  };

  const handleSelectAll = () => {
    if (selectedHouseholds.size === households.length) {
      setSelectedHouseholds(new Set());
    } else {
      setSelectedHouseholds(new Set(households.map((_, index) => index)));
    }
  };

  const handleBulkDelete = () => {
    if (selectedHouseholds.size === 0) return;
    setDeleteConfirmOpen(true);
  };

  const handleDeleteConfirm = () => {
    // Check if this is a bulk delete or single delete
    if (selectedHouseholds.size > 0) {
      // Bulk delete
      const indicesToDelete = Array.from(selectedHouseholds).sort((a, b) => b - a);
      
      // Delete households in reverse order to maintain indices
      let newHouseholds = [...households];
      indicesToDelete.forEach(index => {
        newHouseholds = newHouseholds.filter((_, i) => i !== index);
      });
      setHouseholds(newHouseholds);
      
      // Reset edit mode
      setEditMode(false);
      setSelectedHouseholds(new Set());
      
      // Adjust expanded household if needed
      const maxDeletedIndex = Math.max(...indicesToDelete);
      if (typeof expandedHousehold === 'number') {
        if (indicesToDelete.includes(expandedHousehold)) {
          setExpandedHousehold(false);
        } else if (expandedHousehold > maxDeletedIndex) {
          // Adjust index based on how many were deleted before it
          const deletedBefore = indicesToDelete.filter(idx => idx < expandedHousehold).length;
          setExpandedHousehold(expandedHousehold - deletedBefore);
        }
      }
      
      // Close modal
      setDeleteConfirmOpen(false);
    } else if (householdToDelete !== null) {
      // Single delete
      const indexToDelete = householdToDelete;
      const newHouseholds = households.filter((_, index) => index !== indexToDelete);
      setHouseholds(newHouseholds);
      
      // Adjust expanded household if needed
      if (expandedHousehold === indexToDelete) {
        setExpandedHousehold(false);
      } else if (typeof expandedHousehold === 'number' && expandedHousehold > indexToDelete) {
        setExpandedHousehold(expandedHousehold - 1);
      }
      
      // Close modal
      setDeleteConfirmOpen(false);
      setHouseholdToDelete(null);
    }
  };
  
  const handleDeleteCancel = () => {
    setDeleteConfirmOpen(false);
    setHouseholdToDelete(null);
    // Don't clear selectedHouseholds here - user might want to try again
  };
  
  // Handle close with confirmation
  const handleCloseClick = () => {
    setCloseConfirmOpen(true);
  };
  
  const handleCloseConfirm = () => {
    setCloseConfirmOpen(false);
    onClose();
  };
  
  const handleCloseCancel = () => {
    setCloseConfirmOpen(false);
  };
  
  // Handle cancel during AI processing
  const handleCancelClick = () => {
    setCancelConfirmOpen(true);
  };
  
  const handleCancelConfirm = () => {
    setCancelConfirmOpen(false);
    if (onCancel) {
      onCancel();
    }
    onClose();
  };
  
  const handleCancelDialogCancel = () => {
    setCancelConfirmOpen(false);
  };

  // Handle location change for a member
  const handleLocationChange = (
    householdIndex: number,
    memberType: 'primary' | 'dependent',
    dependentIndex: number | null,
    locationId: string
  ) => {
    const newHouseholds = [...households];
    const household = newHouseholds[householdIndex];
    
    if (memberType === 'primary') {
      household.primaryMember.locationId = locationId;
      // Clear locationName if locationId is set
      if (locationId) {
        delete household.primaryMember.locationName;
      }
    } else if (dependentIndex !== null) {
      household.dependents[dependentIndex].locationId = locationId;
      // Clear locationName if locationId is set
      if (locationId) {
        delete household.dependents[dependentIndex].locationName;
      }
    }
    
    setHouseholds(newHouseholds);
  };

  // Handle field update for a member
  const handleFieldUpdate = (
    householdIndex: number,
    memberType: 'primary' | 'dependent',
    dependentIndex: number | null,
    field: 'firstName' | 'lastName' | 'email' | 'dateOfBirth' | 'gender' | 'jobPosition',
    value: string
  ) => {
    const newHouseholds = [...households];
    const household = newHouseholds[householdIndex];
    
    if (memberType === 'primary') {
      (household.primaryMember as any)[field] = value;
    } else if (dependentIndex !== null) {
      (household.dependents[dependentIndex] as any)[field] = value;
    }
    
    setHouseholds(newHouseholds);
  };

  // Handle confirm
  const handleConfirm = () => {
    // Ensure all locations are matched
    const householdsWithLocations = households.map(household => {
      const primary = { ...household.primaryMember };
      
      // Match primary member location if not already matched
      if (!primary.locationId && primary.locationName) {
        primary.locationId = matchLocation(primary.locationName);
      }
      // Default to primary location if no location specified
      if (!primary.locationId) {
        primary.locationId = primaryLocation?.LocationId || '';
      }
      
      const dependents = household.dependents.map(dependent => {
        const dep = { ...dependent };
        
        // Match dependent location if not already matched
        if (!dep.locationId && dep.locationName) {
          dep.locationId = matchLocation(dep.locationName);
        }
        // Default to primary member's location if no location specified
        if (!dep.locationId) {
          dep.locationId = primary.locationId;
        }
        
        // Note: If spouse email is missing, backend will generate default email (dependent-{userId}@noemail.com)
        // User can still override by entering an email in the UI field above
        
        return dep;
      });
      
      return {
        primaryMember: primary,
        dependents
      };
    });
    
    onConfirm(householdsWithLocations);
  };


  // Show loading state if parsing is in progress
  if (loading && !parsedData) {
    return (
      <Dialog
        open={open}
        onClose={loading ? undefined : onClose}
        maxWidth="md"
        fullWidth
        disableEscapeKeyDown={loading}
        PaperProps={{
          sx: {
            borderRadius: 2,
            boxShadow: theme.shadows[24],
          },
        }}
      >
        <DialogTitle>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Uploading & Extracting with Intelligent Parser
          </Typography>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={48} />
            <Typography variant="body1" sx={{ color: theme.palette.text.secondary }}>
              Uploading and extracting your census file with Intelligent Parser...
            </Typography>
            <Typography variant="body2" sx={{ color: theme.palette.text.secondary, textAlign: 'center' }}>
              This may take up to 5 minutes depending on file size. Please do not close this dialog.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 3 }}>
          <Button
            onClick={handleCancelClick}
            sx={{ textTransform: 'none' }}
            disabled={!loading}
          >
            Cancel
          </Button>
        </DialogActions>
        
        {/* Cancel Confirmation Dialog */}
        <Dialog
          open={cancelConfirmOpen}
          onClose={handleCancelDialogCancel}
          maxWidth="sm"
          fullWidth
        >
          <DialogTitle>Cancel Processing?</DialogTitle>
          <DialogContent>
            <Typography>
              Are you sure you want to cancel the AI processing? The parsing will be stopped and you'll need to start over.
            </Typography>
            <Box sx={{ mt: 2, p: 2, bgcolor: alpha(theme.palette.warning.main, 0.1), borderRadius: 1 }}>
              <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                This action cannot be undone. You'll need to upload and process the file again.
              </Typography>
            </Box>
          </DialogContent>
          <DialogActions>
            <Button onClick={handleCancelDialogCancel} sx={{ textTransform: 'none' }}>
              Continue Processing
            </Button>
            <Button
              onClick={handleCancelConfirm}
              color="error"
              variant="contained"
              sx={{ textTransform: 'none' }}
            >
              Cancel Processing
            </Button>
          </DialogActions>
        </Dialog>
      </Dialog>
    );
  }

  // Show error state if no data and not loading
  if (!parsedData && !loading) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onClose={handleCloseClick}
      maxWidth="lg"
      fullWidth
      disableEscapeKeyDown={false}
      // Prevent closing on backdrop click during import
      // The onClose handler will show a confirmation dialog instead
      PaperProps={{
        sx: {
          borderRadius: 2,
          boxShadow: theme.shadows[24],
          maxHeight: '95vh',
          height: '95vh',
        },
      }}
      // Prevent backdrop clicks from closing the dialog
      // We handle close through the confirmation dialog only
      BackdropProps={{
        onClick: (e) => {
          // Prevent backdrop click from closing - only allow explicit close button
          e.stopPropagation();
        },
        sx: {
          pointerEvents: 'auto', // Keep backdrop interactive but prevent default close behavior
        }
      }}
    >
      <DialogTitle>
        <Stack direction="row" spacing={2} alignItems="center">
          <CheckCircleIcon sx={{ color: '#10b981', fontSize: '1.5rem' }} />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Review Parsed Census Data
          </Typography>
        </Stack>
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', py: 1 }}>
        <Stack spacing={1.5} sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
          {/* Statistics */}
          <Paper
            sx={{
              p: 1.5,
              bgcolor: alpha('#1f8dbf', 0.05),
              border: `1px solid ${theme.palette.divider}`,
              flexShrink: 0,
            }}
          >
            <Stack direction="row" spacing={2} alignItems="center">
              <Box>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.7rem' }}>
                  Total Members
                </Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {households.reduce((sum, h) => sum + 1 + h.dependents.length, 0)}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.7rem' }}>
                  Households
                </Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {households.length}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.7rem' }}>
                  Primary Members
                </Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {households.length}
                </Typography>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.7rem' }}>
                  Dependents
                </Typography>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {households.reduce((sum, h) => sum + h.dependents.length, 0)}
                </Typography>
              </Box>
              {hasErrors && (
                <Box>
                  <Typography variant="caption" sx={{ color: theme.palette.error.main, fontSize: '0.7rem', fontWeight: 600 }}>
                    Errors
                  </Typography>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600, color: theme.palette.error.main }}>
                    {householdsWithErrors.length}
                  </Typography>
                </Box>
              )}
            </Stack>
          </Paper>


          {/* Edit Mode Toolbar */}
          {editMode && (
            <Paper
              sx={{
                p: 1.5,
                bgcolor: alpha(theme.palette.error.main, 0.1),
                border: `1px solid ${theme.palette.error.main}`,
                borderRadius: 1,
                mb: 1,
                flexShrink: 0,
              }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="space-between">
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Checkbox
                    checked={selectedHouseholds.size === households.length && households.length > 0}
                    indeterminate={selectedHouseholds.size > 0 && selectedHouseholds.size < households.length}
                    onChange={handleSelectAll}
                  />
                  <Typography variant="body2" sx={{ fontSize: '0.8rem' }}>
                    {selectedHouseholds.size > 0
                      ? `${selectedHouseholds.size} household(s) selected`
                      : 'Select households to delete'}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    onClick={handleToggleEditMode}
                    sx={{ fontSize: '0.75rem', py: 0.5 }}
                  >
                    Done
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    color="error"
                    startIcon={<DeleteIcon sx={{ fontSize: '1rem' }} />}
                    onClick={handleBulkDelete}
                    disabled={selectedHouseholds.size === 0}
                    sx={{ fontSize: '0.75rem', py: 0.5 }}
                  >
                    Delete Selected ({selectedHouseholds.size})
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          )}

          {/* Households List */}
          {parsedData && households.length > 0 ? (
            <Box
              sx={{
                flex: 1,
                overflow: 'auto',
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: 1,
                p: 1.5,
                minHeight: 0, // Allow flexbox to shrink below content size
              }}
            >
              {!editMode && (
                <Box sx={{ mb: 1, display: 'flex', justifyContent: 'flex-end' }}>
                  <Button
                    size="small"
                    onClick={handleToggleEditMode}
                    sx={{ fontSize: '0.75rem', py: 0.5 }}
                  >
                    Edit
                  </Button>
                </Box>
              )}
              <Stack spacing={1}>
                {households.map((household, householdIndex) => {
                  const errors = getHouseholdErrors(household);
                  const hasHouseholdErrors = errors.length > 0;
                  
                  return (
                  <Accordion
                    key={householdIndex}
                    expanded={expandedHousehold === householdIndex}
                    onChange={(_, isExpanded) => setExpandedHousehold(isExpanded ? householdIndex : false)}
                    sx={{
                      border: `2px solid ${hasHouseholdErrors ? theme.palette.error.main : theme.palette.divider}`,
                      bgcolor: hasHouseholdErrors ? alpha(theme.palette.error.main, 0.05) : 'transparent',
                      '&:before': { display: 'none' },
                    }}
                  >
                    <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ fontSize: '1rem' }} />} sx={{ py: 0.25, minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.5 } }}>
                      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: '100%' }}>
                        {editMode ? (
                          <Checkbox
                            checked={selectedHouseholds.has(householdIndex)}
                            onChange={(e) => {
                              e.stopPropagation();
                              handleToggleHouseholdSelection(householdIndex);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            size="small"
                          />
                        ) : (
                          hasHouseholdErrors ? (
                            <ErrorIcon sx={{ color: theme.palette.error.main, fontSize: '1.2rem' }} />
                          ) : (
                            <PeopleIcon sx={{ color: '#1f8dbf', fontSize: '1.2rem' }} />
                          )
                        )}
                        <Box sx={{ flex: 1 }}>
                          <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
                            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem', lineHeight: 1.2 }}>
                              {household.primaryMember.firstName || '(Missing Name)'} {household.primaryMember.lastName || ''}
                            </Typography>
                            {hasHouseholdErrors && !editMode && (
                              <Stack direction="row" spacing={0.25} flexWrap="wrap">
                                {errors.map((error, errorIndex) => (
                                  <Chip
                                    key={errorIndex}
                                    label={error}
                                    size="small"
                                    color="error"
                                    sx={{ height: 18, fontSize: '0.65rem', '& .MuiChip-label': { px: 0.75 } }}
                                  />
                                ))}
                              </Stack>
                            )}
                          </Stack>
                          <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontSize: '0.65rem', lineHeight: 1.2, mt: 0.25 }}>
                            {household.primaryMember.email || 'No email'} • {household.dependents.length} dependent(s)
                          </Typography>
                        </Box>
                        <Chip
                          label={`${household.dependents.length + 1} member(s)`}
                          size="small"
                          color={hasHouseholdErrors ? 'error' : 'primary'}
                          variant="outlined"
                          sx={{ height: 18, fontSize: '0.6rem', '& .MuiChip-label': { px: 0.75 } }}
                        />
                      </Stack>
                    </AccordionSummary>
                  <AccordionDetails sx={{ pt: 1.5, pb: 1.5 }}>
                    <Stack spacing={1.5}>
                      {/* Delete Button for Individual Household - COMMENTED OUT */}
                      {/* {!editMode && (
                        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: -0.5 }}>
                          <Button
                            size="small"
                            color="error"
                            startIcon={<DeleteIcon sx={{ fontSize: '1rem' }} />}
                            onClick={() => handleDeleteClick(householdIndex)}
                            sx={{ fontSize: '0.75rem', py: 0.5 }}
                          >
                            Delete Household
                          </Button>
                        </Box>
                      )} */}
                      
                      {/* Primary Member */}
                      <Paper
                        sx={{
                          p: 1.5,
                          bgcolor: alpha('#1f8dbf', 0.05),
                          border: `1px solid ${theme.palette.divider}`,
                        }}
                      >
                        <Stack spacing={1.5}>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <PersonIcon sx={{ color: '#1f8dbf', fontSize: '1rem' }} />
                            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: '0.8rem' }}>
                              Primary Member
                            </Typography>
                            <Chip label="Primary" size="small" color="primary" sx={{ height: 20, fontSize: '0.65rem' }} />
                          </Stack>
                          
                          {/* Editable Fields */}
                          <Stack spacing={1.5}>
                            <TextField
                              label="First Name *"
                              value={household.primaryMember.firstName || ''}
                              onChange={(e) => handleFieldUpdate(householdIndex, 'primary', null, 'firstName', e.target.value)}
                              error={!household.primaryMember.firstName}
                              fullWidth
                              size="small"
                              required
                              sx={{
                                '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                              }}
                            />
                            <TextField
                              label="Last Name *"
                              value={household.primaryMember.lastName || ''}
                              onChange={(e) => handleFieldUpdate(householdIndex, 'primary', null, 'lastName', e.target.value)}
                              error={!household.primaryMember.lastName}
                              fullWidth
                              size="small"
                              required
                              sx={{
                                '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                              }}
                            />
                            <TextField
                              label="Email *"
                              type="email"
                              value={household.primaryMember.email || ''}
                              onChange={(e) => handleFieldUpdate(householdIndex, 'primary', null, 'email', e.target.value)}
                              error={!household.primaryMember.email ? true : (household.primaryMember.email ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(household.primaryMember.email) : false)}
                              helperText={household.primaryMember.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(household.primaryMember.email) ? 'Invalid email format' : ''}
                              fullWidth
                              size="small"
                              required
                              sx={{
                                '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                              }}
                            />
                            <TextField
                              label="Date of Birth"
                              type="date"
                              value={household.primaryMember.dateOfBirth && isValidDate(household.primaryMember.dateOfBirth) ? household.primaryMember.dateOfBirth : ''}
                              onChange={(e) => handleFieldUpdate(householdIndex, 'primary', null, 'dateOfBirth', e.target.value)}
                              error={household.primaryMember.dateOfBirth ? !isValidDate(household.primaryMember.dateOfBirth) : false}
                              helperText={household.primaryMember.dateOfBirth && !isValidDate(household.primaryMember.dateOfBirth) ? `Invalid date format. Original: ${household.primaryMember.dateOfBirth}` : 'Format: YYYY-MM-DD'}
                              fullWidth
                              size="small"
                              InputLabelProps={{ shrink: true }}
                              sx={{
                                '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                              }}
                            />
                            {household.primaryMember.phoneNumber && (
                              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                Phone: {household.primaryMember.phoneNumber}
                              </Typography>
                            )}
                            <FormControl fullWidth size="small" sx={{ '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' }, '& .MuiInputLabel-root': { fontSize: '0.8rem' } }}>
                              <InputLabel>Gender</InputLabel>
                              <Select
                                value={household.primaryMember.gender || ''}
                                onChange={(e) => handleFieldUpdate(householdIndex, 'primary', null, 'gender', e.target.value)}
                                label="Gender"
                              >
                                <MenuItem value="Male" sx={{ fontSize: '0.8rem' }}>Male</MenuItem>
                                <MenuItem value="Female" sx={{ fontSize: '0.8rem' }}>Female</MenuItem>
                              </Select>
                            </FormControl>
                            <FormControl fullWidth size="small" sx={{ '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' }, '& .MuiInputLabel-root': { fontSize: '0.8rem' } }}>
                              <InputLabel>Job Position</InputLabel>
                              <Select
                                value={household.primaryMember.jobPosition || ''}
                                onChange={(e) => handleFieldUpdate(householdIndex, 'primary', null, 'jobPosition', e.target.value)}
                                label="Job Position"
                              >
                                <MenuItem value="" sx={{ fontSize: '0.8rem' }}>None</MenuItem>
                                {DEFAULT_JOB_POSITIONS.map((position) => (
                                  <MenuItem key={position.id} value={position.id} sx={{ fontSize: '0.8rem' }}>
                                    {position.label}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          </Stack>

                          {/* Location Selection */}
                          <FormControl fullWidth size="small" sx={{ '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' }, '& .MuiInputLabel-root': { fontSize: '0.8rem' } }}>
                            <InputLabel>Work Location *</InputLabel>
                            <Select
                              value={household.primaryMember.locationId || matchLocation(household.primaryMember.locationName) || primaryLocation?.LocationId || ''}
                              onChange={(e) => handleLocationChange(householdIndex, 'primary', null, e.target.value)}
                              label="Work Location *"
                              sx={{
                                '& .MuiOutlinedInput-root': {
                                  '&.Mui-focused fieldset': {
                                    borderColor: '#1f8dbf',
                                  },
                                },
                              }}
                            >
                              {activeLocations.length > 0 ? (
                                activeLocations.map((location) => (
                                  <MenuItem key={location.LocationId} value={location.LocationId} sx={{ fontSize: '0.8rem' }}>
                                    {location.Name || 'Unnamed Location'}
                                    {location.IsPrimary && ' (Primary)'}
                                    {' - '}
                                    {location.City}, {location.State}
                                  </MenuItem>
                                ))
                              ) : (
                                <MenuItem value="" disabled>
                                  No locations available
                                </MenuItem>
                              )}
                            </Select>
                            {household.primaryMember.locationName && !household.primaryMember.locationId && (
                              <Typography variant="caption" sx={{ color: theme.palette.warning.main, mt: 0.5, display: 'block' }}>
                                Original: {household.primaryMember.locationName}
                              </Typography>
                            )}
                          </FormControl>
                        </Stack>
                      </Paper>

                          {/* Dependents */}
                          {household.dependents.length > 0 && (
                            <Box>
                              <Typography variant="body2" sx={{ fontWeight: 600, mb: 1, fontSize: '0.8rem' }}>
                                Dependents ({household.dependents.length})
                              </Typography>
                              <Stack spacing={1.5}>
                            {household.dependents.map((dependent, dependentIndex) => {
                              const depErrors: string[] = [];
                              if (!dependent.firstName || !dependent.lastName) {
                                depErrors.push('Missing required fields');
                              }
                              // Email is optional for spouses (system will generate default if missing)
                              if (dependent.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dependent.email)) {
                                depErrors.push('Invalid email format');
                              }
                              if (dependent.dateOfBirth && !isValidDate(dependent.dateOfBirth)) {
                                depErrors.push('Invalid date of birth');
                              }
                              const hasDepErrors = depErrors.length > 0;
                              
                              return (
                                <Paper
                                  key={dependentIndex}
                                  sx={{
                                    p: 1.5,
                                    border: `1px solid ${hasDepErrors ? theme.palette.error.main : theme.palette.divider}`,
                                    bgcolor: hasDepErrors ? alpha(theme.palette.error.main, 0.05) : alpha('#fbbf24', 0.05),
                                  }}
                                >
                                  <Stack spacing={1.5}>
                                    <Stack direction="row" spacing={0.75} alignItems="center">
                                      <PersonIcon sx={{ color: hasDepErrors ? theme.palette.error.main : '#f59e0b', fontSize: '0.9rem' }} />
                                      <Chip
                                        label={dependent.relationshipType === 'S' ? 'Spouse' : 'Child'}
                                        size="small"
                                        color={hasDepErrors ? 'error' : 'warning'}
                                        variant="outlined"
                                        sx={{ height: 20, fontSize: '0.65rem' }}
                                      />
                                    </Stack>
                                    
                                    <Stack spacing={1.5}>
                                    <TextField
                                      label="First Name *"
                                      value={dependent.firstName || ''}
                                      onChange={(e) => handleFieldUpdate(householdIndex, 'dependent', dependentIndex, 'firstName', e.target.value)}
                                      error={!dependent.firstName}
                                      fullWidth
                                      size="small"
                                      required
                                      sx={{
                                        '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                        '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                        '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                                      }}
                                    />
                                    <TextField
                                      label="Last Name *"
                                      value={dependent.lastName || ''}
                                      onChange={(e) => handleFieldUpdate(householdIndex, 'dependent', dependentIndex, 'lastName', e.target.value)}
                                      error={!dependent.lastName}
                                      fullWidth
                                      size="small"
                                      required
                                      sx={{
                                        '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                        '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                        '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                                      }}
                                    />
                                    {/* Email field only for spouses, not children */}
                                    {dependent.relationshipType === 'S' && (
                                      <TextField
                                        label="Email (optional)"
                                        type="email"
                                        value={dependent.email || ''}
                                        onChange={(e) => handleFieldUpdate(householdIndex, 'dependent', dependentIndex, 'email', e.target.value)}
                                        error={dependent.email ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dependent.email) : false}
                                        helperText={dependent.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dependent.email) ? 'Invalid email format' : 'Optional - default email will be generated if not provided'}
                                        fullWidth
                                        size="small"
                                        sx={{
                                          '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                          '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                          '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                                        }}
                                      />
                                    )}
                                    <FormControl fullWidth size="small" sx={{ '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' }, '& .MuiInputLabel-root': { fontSize: '0.8rem' } }}>
                                      <InputLabel>Gender</InputLabel>
                                      <Select
                                        value={dependent.gender || ''}
                                        onChange={(e) => handleFieldUpdate(householdIndex, 'dependent', dependentIndex, 'gender', e.target.value)}
                                        label="Gender"
                                      >
                                        <MenuItem value="Male" sx={{ fontSize: '0.8rem' }}>Male</MenuItem>
                                        <MenuItem value="Female" sx={{ fontSize: '0.8rem' }}>Female</MenuItem>
                                      </Select>
                                    </FormControl>
                                    <TextField
                                      label="Date of Birth"
                                      type="date"
                                      value={dependent.dateOfBirth && isValidDate(dependent.dateOfBirth) ? dependent.dateOfBirth : ''}
                                      onChange={(e) => handleFieldUpdate(householdIndex, 'dependent', dependentIndex, 'dateOfBirth', e.target.value)}
                                      error={dependent.dateOfBirth ? !isValidDate(dependent.dateOfBirth) : false}
                                      helperText={dependent.dateOfBirth && !isValidDate(dependent.dateOfBirth) ? `Invalid date format. Original: ${dependent.dateOfBirth}` : 'Format: YYYY-MM-DD'}
                                      fullWidth
                                      size="small"
                                      InputLabelProps={{ shrink: true }}
                                      sx={{
                                        '& .MuiInputBase-root': { height: '32px', fontSize: '0.8rem' },
                                        '& .MuiInputLabel-root': { fontSize: '0.8rem' },
                                        '& .MuiFormHelperText-root': { fontSize: '0.7rem', mt: 0.25 }
                                      }}
                                    />
                                    {dependent.phoneNumber && (
                                      <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                        Phone: {dependent.phoneNumber}
                                      </Typography>
                                    )}
                                  </Stack>

                                  {/* Dependents automatically inherit the primary member's work location. */}
                                  <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                    Work Location: {(() => {
                                      const primaryLocId = household.primaryMember.locationId || matchLocation(household.primaryMember.locationName) || primaryLocation?.LocationId;
                                      const location = locations.find(l => l.LocationId === primaryLocId);
                                      if (location) {
                                        return location.Name || 'Unnamed Location';
                                      }
                                      if (household.primaryMember.locationName) {
                                        return household.primaryMember.locationName;
                                      }
                                      return 'Same as primary';
                                    })()}
                                  </Typography>
                                </Stack>
                              </Paper>
                            );
                            })}
                          </Stack>
                        </Box>
                      )}
                    </Stack>
                  </AccordionDetails>
                </Accordion>
                );
                })}
              </Stack>
            </Box>
          ) : parsedData && parsedData.households && parsedData.households.length === 0 ? (
            <Alert severity="warning">
              <AlertTitle>No Households Found</AlertTitle>
              <Typography variant="body2">
                The parser did not find any households in the file. Please check your file format and try again.
              </Typography>
            </Alert>
          ) : null}

          {/* Summary */}
          {hasErrors && (
            <Box sx={{ p: 1.5, bgcolor: alpha('#1f8dbf', 0.05), borderRadius: 1, flexShrink: 0 }}>
              <Typography variant="body2" sx={{ color: theme.palette.text.secondary, fontSize: '0.8rem' }}>
                <strong>Cannot Import:</strong> {householdsWithErrors.length} household(s) have errors that must be resolved first.
                Please fix the highlighted issues above before proceeding.
              </Typography>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3 }}>
        <Button
          onClick={handleCloseClick}
          sx={{ textTransform: 'none' }}
          disabled={loading}
        >
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          variant="contained"
          disabled={loading || !parsedData || households.length === 0 || hasErrors}
          startIcon={loading ? <CircularProgress size={16} /> : <CheckCircleIcon />}
          sx={{
            textTransform: 'none',
            bgcolor: hasErrors ? theme.palette.error.main : '#1f8dbf',
            '&:hover': {
              bgcolor: hasErrors ? theme.palette.error.dark : '#175a7a',
            },
            '&:disabled': {
              bgcolor: hasErrors ? alpha(theme.palette.error.main, 0.3) : undefined,
            },
          }}
        >
          {loading ? 'Importing...' : hasErrors ? `Fix Errors First (${householdsWithErrors.length} household(s))` : `Confirm Import (${households.reduce((sum, h) => sum + 1 + h.dependents.length, 0)} members)`}
        </Button>
      </DialogActions>
      
      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={handleDeleteCancel}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {selectedHouseholds.size > 0 ? `Delete ${selectedHouseholds.size} Household(s)?` : 'Delete Household?'}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {selectedHouseholds.size > 0
              ? `Are you sure you want to remove ${selectedHouseholds.size} selected household(s) from the import list? This action cannot be undone.`
              : 'Are you sure you want to remove this household from the import list?'}
          </Typography>
          {selectedHouseholds.size > 0 ? (
            <Box sx={{ mt: 2, p: 2, bgcolor: alpha(theme.palette.error.main, 0.1), borderRadius: 1, maxHeight: 200, overflow: 'auto' }}>
              <Stack spacing={1}>
                {Array.from(selectedHouseholds).map((index) => {
                  const household = households[index];
                  if (!household) return null;
                  return (
                    <Typography key={index} variant="body2">
                      • {household.primaryMember.firstName || '(Missing Name)'} {household.primaryMember.lastName || ''} ({household.dependents.length + 1} member(s))
                    </Typography>
                  );
                })}
              </Stack>
            </Box>
          ) : householdToDelete !== null && households[householdToDelete] ? (
            <Box sx={{ mt: 2, p: 2, bgcolor: alpha(theme.palette.error.main, 0.1), borderRadius: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {households[householdToDelete].primaryMember.firstName || '(Missing Name)'} {households[householdToDelete].primaryMember.lastName || ''}
              </Typography>
              <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                This will remove {households[householdToDelete].dependents.length + 1} member(s) from the import
              </Typography>
            </Box>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            onClick={handleDeleteConfirm}
            color="error"
            variant="contained"
            sx={{ textTransform: 'none' }}
          >
            {selectedHouseholds.size > 0 ? `Delete ${selectedHouseholds.size} Household(s)` : 'Delete Household'}
          </Button>
        </DialogActions>
      </Dialog>
      
      {/* Close Confirmation Dialog */}
      <Dialog
        open={closeConfirmOpen}
        onClose={handleCloseCancel}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Discard Changes?</DialogTitle>
        <DialogContent>
          <Typography>
            Are you sure you want to close this dialog? All your edits and changes will be lost.
          </Typography>
          <Box sx={{ mt: 2, p: 2, bgcolor: alpha(theme.palette.warning.main, 0.1), borderRadius: 1 }}>
            <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
              You have {households.length} household(s) ready to import. Closing now will discard all your work.
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseCancel} sx={{ textTransform: 'none' }}>
            Keep Editing
          </Button>
          <Button
            onClick={handleCloseConfirm}
            color="error"
            variant="contained"
            sx={{ textTransform: 'none' }}
          >
            Discard Changes
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
};

export default CensusImportPreview;

