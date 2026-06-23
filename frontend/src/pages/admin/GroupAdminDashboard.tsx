// frontend/src/pages/admin/GroupAdminDashboard.tsx
import React, { useEffect, useState } from 'react';
import SharedHeader from '../../components/layout/SharedHeader';
import { apiService } from '../../services/api.service';
import GroupDetails from '../groups/GroupDetails';

interface GroupAdmin {
  UserId: string;
  Email: string;
  FirstName: string;
  LastName: string;
  UserType: string;
  Status: string;
  TenantId: string;
  PhoneNumber?: string;
  CreatedDate: string;
  ModifiedDate?: string;
  LastLoginDate?: string;
  Roles?: string;
}

interface GroupInfo {
  GroupId: string;
  GroupName: string;
  TenantId: string;
  TenantName?: string;
  AgentFirstName?: string;
  AgentLastName?: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

const GroupAdminDashboard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupAdmin, setGroupAdmin] = useState<GroupAdmin | null>(null);
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);

  useEffect(() => {
    const fetchGroupAdminDetails = async () => {
      try {
        setLoading(true);
        
        // Fetch user profile
        const userResponse = await apiService.get<ApiResponse<GroupAdmin>>('/api/users/me');
        
        if (userResponse && userResponse.success) {
          setGroupAdmin(userResponse.data);
        } else {
          throw new Error('Group admin profile not found for current user');
        }
        
        // Fetch group information for this admin
        const groupResponse = await apiService.get<ApiResponse<GroupInfo>>('/api/group-admin/group-info');
        
        if (groupResponse && groupResponse.success) {
          setGroupInfo(groupResponse.data);
        } else {
          throw new Error('Group information not found for this admin');
        }
        
        setError(null);
      } catch (err: any) {
        console.error('Error fetching group admin details:', err);
        setError(err.message || 'An unknown error occurred while fetching your profile.');
      } finally {
        setLoading(false);
      }
    };

    fetchGroupAdminDetails();
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col h-screen">
        <SharedHeader title="Group Admin Dashboard" />
        <div className="flex-1 p-6 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
        </div>
      </div>
    );
  }

  if (error || !groupAdmin || !groupInfo) {
    return (
      <div className="flex flex-col h-screen">
        <SharedHeader title="Group Admin Dashboard" />
        <div className="flex-1 p-6">
          <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
            {error || 'Unable to load group admin profile or group information.'}
          </div>
        </div>
      </div>
    );
  }

  // Show the actual group details instead of sample data
  return (
    <div className="flex flex-col h-screen">
      <SharedHeader title={`${groupInfo.GroupName} - Group Management`} />
      <div className="flex-1 overflow-y-auto">
        <GroupDetails groupId={groupInfo.GroupId} hideBackButton={true} />
      </div>
    </div>
  );
};

export default GroupAdminDashboard; 