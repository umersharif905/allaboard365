// src/components/commissions/steps/CommissionGroupsStep.tsx
import React, { useEffect, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import {
  Box,
  Typography,
  FormControlLabel,
  Checkbox,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  CircularProgress,
  Alert,
} from '@mui/material';
import { commissionGroupsService, type CommissionGroup } from '../../../services/commissionGroups.service';
import { RuleCreationFormData } from '../RuleCreationWizard';

export const CommissionGroupsStep: React.FC = () => {
  const { watch, setValue } = useFormContext<RuleCreationFormData>();
  const [groups, setGroups] = useState<CommissionGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const commissionGroupIds = watch('commissionGroupIds') ?? [];
  const addToAllGroups = watch('addToAllGroups') ?? false;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const result = await commissionGroupsService.listGroups({ limit: 500 });
        if (!cancelled) setGroups(result.groups ?? []);
      } catch {
        if (!cancelled) setGroups([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const handleToggleGroup = (groupId: string) => {
    const current = commissionGroupIds as string[];
    const next = current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId];
    setValue('commissionGroupIds', next);
  };

  const handleAddToAllChange = (checked: boolean) => {
    setValue('addToAllGroups', checked);
    if (checked) setValue('commissionGroupIds', []);
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Add to Commission Groups
      </Typography>
      <Typography variant="body2" color="textSecondary" gutterBottom>
        Optionally add this rule to commission groups by default. You can change this later.
      </Typography>

      <Box sx={{ mt: 2 }}>
        <FormControlLabel
          control={
            <Checkbox
              checked={addToAllGroups}
              onChange={(e) => handleAddToAllChange(e.target.checked)}
              color="primary"
            />
          }
          label="Add to all commission groups"
        />
      </Box>

      {!addToAllGroups && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" color="textSecondary" gutterBottom>
            Or select specific groups:
          </Typography>
          {loading ? (
            <Box display="flex" alignItems="center" gap={2} py={3}>
              <CircularProgress size={24} />
              <Typography variant="body2">Loading groups…</Typography>
            </Box>
          ) : groups.length === 0 ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              No commission groups found for this tenant.
            </Alert>
          ) : (
            <List dense sx={{ maxHeight: 320, overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}>
              {groups.map((g) => (
                <ListItem key={g.CommissionGroupId} disablePadding>
                  <ListItemButton
                    onClick={() => handleToggleGroup(g.CommissionGroupId)}
                    selected={(commissionGroupIds as string[]).includes(g.CommissionGroupId)}
                  >
                    <ListItemIcon>
                      <Checkbox
                        edge="start"
                        checked={(commissionGroupIds as string[]).includes(g.CommissionGroupId)}
                        tabIndex={-1}
                        disableRipple
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={g.Name}
                      secondary={g.Description || (g.RuleCount != null ? `${g.RuleCount} rules` : undefined)}
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}
        </Box>
      )}
    </Box>
  );
};
