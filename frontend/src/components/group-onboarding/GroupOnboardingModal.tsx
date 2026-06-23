import { Dialog, DialogContent, DialogTitle, IconButton } from '@mui/material';
import { X } from 'lucide-react';
import React from 'react';
import GroupOnboardingWizard from './GroupOnboardingWizard';

interface GroupOnboardingModalProps {
  open: boolean;
  onClose: () => void;
  linkToken: string;
  groupName: string;
}

const GroupOnboardingModal: React.FC<GroupOnboardingModalProps> = ({
  open,
  onClose,
  linkToken,
  groupName
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      fullScreen
      sx={{
        '& .MuiDialog-paper': {
          margin: 0,
          maxHeight: '100vh',
          borderRadius: 0,
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          p: 2,
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            Group Onboarding - {groupName}
          </h2>
          <p className="text-sm text-gray-600">
            Complete the onboarding process for this group
          </p>
        </div>
        <IconButton
          onClick={onClose}
          size="small"
          sx={{
            color: 'gray.500',
            '&:hover': {
              color: 'gray.700',
            },
          }}
        >
          <X className="h-5 w-5" />
        </IconButton>
      </DialogTitle>
      
      <DialogContent sx={{ p: 0, overflow: 'hidden' }}>
        <GroupOnboardingWizard />
      </DialogContent>
    </Dialog>
  );
};

export default GroupOnboardingModal;
