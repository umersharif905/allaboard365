// File: src/pages/tenant-admin/TenantMembers.tsx
import {
    AlertCircle,
    Building2,
    Calendar,
    ChevronLeft,
    ChevronRight,
    Download,
    Edit,
    Eye,
    Filter,
    Mail,
    MoreVertical,
    Search,
    Upload,
    User,
    Users
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TenantAdminService } from '../../services/tenant-admin/tenant-admin.service';
import { Member } from '../../types/member.types';

const TenantMembers: React.FC = () => {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [showActionsMenu, setShowActionsMenu] = useState<string | null>(null);
  const [groups, setGroups] = useState<Array<{groupId: string, groupName: string}>>([]);

  const membersPerPage = 25;

  useEffect(() => {
    loadMembers();
    loadGroups();
  }, [currentPage, statusFilter, groupFilter]);

  const loadMembers = async () => {
    try {
      setLoading(true);
      // TEMPORARY: Using a placeholder API call since getTenantMembers doesn't exist
      // TODO: Backend needs to implement the /api/tenant-admin/members endpoint
      const mockMembers: Member[] = [
        {
          MemberId: '1',
          UserId: 'user1',
          FirstName: 'John',
          LastName: 'Doe',
          Email: 'john.doe@example.com',
          PhoneNumber: '(555) 123-4567',
          GroupId: 'g1',
          GroupName: 'Acme Corp',
          Status: 'Active',
          CreatedDate: new Date().toISOString(),
          DateOfBirth: '1980-01-01',
          RelationshipType: 'P',
          // Note: Some fields like products, totalPremium don't exist in Member interface
          // These would need to be added as computed fields or separate interfaces
        },
        {
          MemberId: '2',
          UserId: 'user2',
          FirstName: 'Jane',
          LastName: 'Smith',
          Email: 'jane.smith@example.com',
          PhoneNumber: '(555) 987-6543',
          GroupId: 'g2',
          GroupName: 'Tech Solutions',
          Status: 'Active',
          CreatedDate: new Date().toISOString(),
          DateOfBirth: '1985-05-15',
          RelationshipType: 'P',
        }
      ];

      // Simulate API response
      setMembers(mockMembers);
      setTotalPages(1);
      setError(null);
      
    } catch (err: any) {
      console.error('Failed to load members:', err);
      setError(err.message || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  };

  const loadGroups = async () => {
    try {
      const response = await TenantAdminService.getTenantGroups();
      if (response.success && response.data) {
        setGroups(response.data as any[]);
      }
    } catch (err) {
      console.error('Failed to load groups:', err);
    }
  };

  const handleExportMembers = () => {
    console.log('Export members to CSV');
  };

  const handleBulkImport = () => {
    console.log('Open bulk import dialog');
  };

  const getStatusBadge = (status: string) => {
    const colors = {
      Active: 'bg-green-100 text-green-800',
      Inactive: 'bg-yellow-100 text-yellow-800',
      Pending: 'bg-blue-100 text-blue-800',
      Terminated: 'bg-red-100 text-red-800'
    };
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const getMemberTypeBadge = (type: string) => {
    const colors = {
      Primary: 'bg-purple-100 text-purple-800',
      Spouse: 'bg-pink-100 text-pink-800',
      Dependent: 'bg-indigo-100 text-indigo-800'
    };
    return colors[type as keyof typeof colors] || 'bg-gray-100 text-gray-800';
  };

  const filteredMembers = members.filter(member => {
    const matchesSearch = 
      member.FirstName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      member.LastName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      member.Email.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (member.GroupName || 'Unknown Group').toLowerCase().includes(searchTerm.toLowerCase());
    return matchesSearch;
  });

  if (loading && members.length === 0) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-oe-primary"></div>
      </div>
    );
  }

  if (error && members.length === 0) {
    return (
      <div className="min-h-screen bg-oe-neutral-light flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="h-12 w-12 text-oe-error mx-auto mb-4" />
          <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">Failed to Load Members</h3>
          <p className="text-gray-600">{error}</p>
          <button 
            onClick={loadMembers}
            className="mt-4 px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-3">
        <button
          onClick={handleExportMembers}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
        >
          <Download className="h-4 w-4" />
          Export
        </button>
        <button
          onClick={handleBulkImport}
          className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2"
        >
          <Upload className="h-4 w-4" />
          Import
        </button>
      </div>
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-oe-light rounded-lg">
              <Users className="h-6 w-6 text-oe-primary" />
            </div>
            <span className="text-sm text-gray-500">Total</span>
          </div>
          <div className="space-y-1">
            <h3 className="text-2xl font-bold text-oe-neutral-dark">
              {members.length}
            </h3>
            <p className="text-sm text-gray-600">Members</p>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-green-100 rounded-lg">
              <User className="h-6 w-6 text-green-600" />
            </div>
            <span className="text-sm text-gray-500">Active</span>
          </div>
          <div className="space-y-1">
            <h3 className="text-2xl font-bold text-oe-neutral-dark">
              {members.filter(m => m.Status === 'Active').length}
            </h3>
            <p className="text-sm text-gray-600">Active Members</p>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-purple-100 rounded-lg">
              <Building2 className="h-6 w-6 text-purple-600" />
            </div>
            <span className="text-sm text-gray-500">Groups</span>
          </div>
          <div className="space-y-1">
            <h3 className="text-2xl font-bold text-oe-neutral-dark">
              {groups.length}
            </h3>
            <p className="text-sm text-gray-600">Total Groups</p>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-blue-100 rounded-lg">
              <Calendar className="h-6 w-6 text-oe-primary" />
            </div>
            <span className="text-sm text-gray-500">This Month</span>
          </div>
          <div className="space-y-1">
            <h3 className="text-2xl font-bold text-oe-neutral-dark">
              {members.filter(m => {
                const enrollDate = new Date(m.CreatedDate);
                const now = new Date();
                return enrollDate.getMonth() === now.getMonth() && 
                       enrollDate.getFullYear() === now.getFullYear();
              }).length}
            </h3>
            <p className="text-sm text-gray-600">New Enrollments</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm p-4">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search members..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-transparent"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
            >
              <option value="all">All Status</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Pending">Pending</option>
              <option value="Terminated">Terminated</option>
            </select>
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary"
            >
              <option value="all">All Groups</option>
              {groups.map(group => (
                <option key={group.groupId} value={group.groupId}>
                  {group.groupName}
                </option>
              ))}
            </select>
            <button className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 flex items-center gap-2">
              <Filter className="h-4 w-4" />
              More Filters
            </button>
          </div>
        </div>
      </div>

      {/* Members List */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {filteredMembers.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">No members found</h3>
            <p className="text-gray-600">
              {searchTerm || statusFilter !== 'all' || groupFilter !== 'all'
                ? 'Try adjusting your filters' 
                : 'No members enrolled yet'}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Member
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Type
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Group
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Products
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Premium
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                      Effective Date
                    </th>
                    <th className="relative px-6 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {filteredMembers.map((member) => (
                    <tr key={member.MemberId} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div>
                          <div className="text-sm font-medium text-oe-neutral-dark">
                            {member.FirstName} {member.LastName}
                          </div>
                          <div className="text-sm text-gray-500 flex items-center gap-2">
                            <Mail className="h-3 w-3" />
                            {member.Email}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getMemberTypeBadge(member.RelationshipType || 'P')}`}>
                          {member.RelationshipType || 'Primary'}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {member.GroupName || 'Unknown Group'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadge(member.Status)}`}>
                          {member.Status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {/* Products and TotalPremium are not directly available in the Member interface */}
                        {/* This would require a separate service call or computed field */}
                        N/A
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {/* EffectiveDate is not directly available in the Member interface */}
                        {/* This would require a separate service call or computed field */}
                        N/A
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="relative">
                          <button
                            onClick={() => setShowActionsMenu(
                              showActionsMenu === member.MemberId ? null : member.MemberId
                            )}
                            className="p-2 rounded-lg hover:bg-gray-100"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                          
                          {showActionsMenu === member.MemberId && (
                            <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 z-10">
                              <Link
                                to={`/tenant-admin/members/${member.MemberId}`}
                                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
                              >
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
                              </Link>
                              <Link
                                to={`/tenant-admin/members/${member.MemberId}/edit`}
                                className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
                              >
                                <Edit className="h-4 w-4 mr-2" />
                                Edit Member
                              </Link>
                              <button
                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center"
                              >
                                <Mail className="h-4 w-4 mr-2" />
                                Send Email
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="bg-gray-50 px-4 py-3 flex items-center justify-between border-t border-gray-200">
              <div className="flex-1 flex justify-between sm:hidden">
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
              <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-gray-700">
                    Showing{' '}
                    <span className="font-medium">{(currentPage - 1) * membersPerPage + 1}</span>{' '}
                    to{' '}
                    <span className="font-medium">
                      {Math.min(currentPage * membersPerPage, members.length)}
                    </span>{' '}
                    of{' '}
                    <span className="font-medium">{members.length}</span>{' '}
                    results
                  </p>
                </div>
                <div>
                  <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px">
                    <button
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                      className="relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <span className="relative inline-flex items-center px-4 py-2 border border-gray-300 bg-white text-sm font-medium text-gray-700">
                      Page {currentPage} of {totalPages}
                    </span>
                    <button
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                      className="relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 bg-white text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                  </nav>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default TenantMembers;