// src/pages/agent/AgentMemberManagement.tsx
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Edit,
  Eye,
  Filter,
  Mail,
  MoreVertical,
  Phone,
  Search,
  Send,
  Target,
  UserPlus,
  Users
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import QuickEnrollmentLinkModal from '../../components/shared/QuickEnrollmentLinkModal';
import { AgentService } from '../../services/agent/agent.service';
import { apiService } from '../../services/api.service';
import type { AgentMember } from '../../types/agent/agent.types';

const AgentMemberManagement: React.FC = () => {
  const [members, setMembers] = useState<AgentMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [agentProfile, setAgentProfile] = useState<{
    firstName: string;
    lastName: string;
    profileImageUrl: string | null;
    commissionLevelName: string | null;
  } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [selectedEnrollmentStatus, setSelectedEnrollmentStatus] = useState<string>('');
  const [selectedLifecycleStage, setSelectedLifecycleStage] = useState<string>('');
  const [selectedMember, setSelectedMember] = useState<AgentMember | null>(null);
  const [showActionsMenu, setShowActionsMenu] = useState<string | null>(null);
  const [showMemberModal, setShowMemberModal] = useState(false);
  // 1. Add filter state for enrollment date and product type
  const [selectedEnrollmentDate, setSelectedEnrollmentDate] = useState<string>('');
  const [selectedProductType, setSelectedProductType] = useState<string>('');
  const [productTypes, setProductTypes] = useState<string[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);

  // 2. Add member modal state
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);

  // 3. Add terminate member modal state
  const [showTerminateModal, setShowTerminateModal] = useState<{ open: boolean; member: AgentMember | null }>({ open: false, member: null });

  const [showSendLinkModal, setShowSendLinkModal] = useState(false);
  const [sendLinkMember, setSendLinkMember] = useState<{
    memberId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phoneNumber?: string;
  } | null>(null);

  useEffect(() => {
    loadMembers();
  }, [searchTerm, selectedStatus, selectedEnrollmentStatus, selectedLifecycleStage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiService.get<{ success: boolean; data?: any }>('/api/me/agent/profile');
        if (cancelled || !res?.success || !res.data) return;
        setAgentProfile({
          firstName: res.data.FirstName || '',
          lastName: res.data.LastName || '',
          profileImageUrl: res.data.ProfileImageUrl || null,
          commissionLevelName: res.data.CommissionLevelName ? String(res.data.CommissionLevelName).trim() || null : null,
        });
      } catch {
        // non-critical
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Fetch available products for agent and extract unique types
    const fetchProducts = async () => {
      setProductsLoading(true);
      try {
        const response = await AgentService.getAgentProducts();
        if (response.success && response.data) {
          const types = Array.from(new Set(response.data.map((p: any) => p.ProductType).filter(Boolean)));
          setProductTypes(types as string[]);
        }
      } catch (err) {
        setProductTypes([]);
      } finally {
        setProductsLoading(false);
      }
    };
    fetchProducts();
  }, []);

  const loadMembers = async () => {
    try {
      setLoading(true);
      const response = await AgentService.getAssignedMembers({
        search: searchTerm || undefined,
        status: selectedStatus || undefined,
        enrollmentStatus: selectedEnrollmentStatus || undefined,
        lifecycleStage: selectedLifecycleStage || undefined,
        enrollmentDate: selectedEnrollmentDate || undefined,
        productType: selectedProductType || undefined,
        sortBy: 'lastName',
        sortOrder: 'asc',
      });
      if (response.success && response.data) {
        setMembers(response.data as any);
      }
    } catch (error) {
      console.error('Failed to load members:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMemberStage = async (memberId: string, stage: 'Lead' | 'Prospect' | 'Member' | 'Renewal') => {
    try {
      const response = await AgentService.updateMemberStage(memberId, stage);
      if (response.success) {
        loadMembers();
        setShowActionsMenu(null);
      }
    } catch (error) {
      console.error('Failed to update member stage:', error);
    }
  };

  const handleUpdateMemberNotes = async (memberId: string, notes: string, nextFollowUpDate?: string) => {
    try {
      const response = await AgentService.updateMemberNotes(memberId, {
        notes,
        nextFollowUpDate
      });
      if (response.success) {
        loadMembers();
        setShowMemberModal(false);
      }
    } catch (error) {
      console.error('Failed to update member notes:', error);
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800';
      case 'Inactive':
        return 'bg-gray-100 text-gray-800';
      case 'Pending':
        return 'bg-yellow-100 text-yellow-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getEnrollmentStatusIcon = (status: string) => {
    switch (status) {
      case 'Enrolled':
        return <CheckCircle className="h-4 w-4 text-oe-success" />;
      case 'Pending':
        return <Clock className="h-4 w-4 text-oe-warning" />;
      case 'Declined':
        return <AlertCircle className="h-4 w-4 text-oe-error" />;
      case 'Not Started':
        return <Target className="h-4 w-4 text-gray-500" />;
      default:
        return <Target className="h-4 w-4 text-gray-500" />;
    }
  };

  const getLifecycleBadgeColor = (stage: string) => {
    switch (stage) {
      case 'Prospect':
        return 'bg-purple-100 text-purple-800';
      case 'Member':
        return 'bg-green-100 text-green-800';
      case 'Renewal':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const memberStats = {
    total: members.length,
    enrolled: members.filter(m => m.enrollmentStatus === 'Enrolled').length,
    pending: members.filter(m => m.enrollmentStatus === 'Pending').length,
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {agentProfile && (
            agentProfile.profileImageUrl ? (
              <img
                src={agentProfile.profileImageUrl}
                alt={`${agentProfile.firstName} ${agentProfile.lastName}`}
                className="h-10 w-10 rounded-full object-cover border border-gray-200 shrink-0"
              />
            ) : (
              <div className="h-10 w-10 rounded-full bg-oe-light flex items-center justify-center border border-gray-200 shrink-0">
                <span className="text-sm font-semibold text-oe-primary">
                  {(agentProfile.firstName[0] || '') + (agentProfile.lastName[0] || '')}
                </span>
              </div>
            )
          )}
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-oe-neutral-dark">My Members</h1>
              {agentProfile?.commissionLevelName && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 border border-blue-200">
                  {agentProfile.commissionLevelName}
                </span>
              )}
            </div>
            {agentProfile && (
              <p className="text-sm text-gray-500">{agentProfile.firstName} {agentProfile.lastName}</p>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="flex items-center space-x-4 text-sm text-gray-500">
            <span>Total: {memberStats.total}</span>
            <span>Enrolled: {memberStats.enrolled}</span>
            <span>Pending: {memberStats.pending}</span>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-oe-light rounded-lg">
              <Users className="h-6 w-6 text-oe-primary" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">{memberStats.total}</p>
              <p className="text-sm text-gray-600">Total Members</p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-green-100 rounded-lg">
              <CheckCircle className="h-6 w-6 text-oe-success" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">{memberStats.enrolled}</p>
              <p className="text-sm text-gray-600">Enrolled</p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
          <div className="flex items-center">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <Clock className="h-6 w-6 text-oe-warning" />
            </div>
            <div className="ml-4">
              <p className="text-2xl font-bold text-oe-neutral-dark">{memberStats.pending}</p>
              <p className="text-sm text-gray-600">Pending</p>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
        <div className="grid grid-cols-1 md:grid-cols-7 gap-4">
          <div className="relative">
            <Search className="h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search members..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 w-full border border-gray-300 rounded-md focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="form-input focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">All Statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
            <option value="Pending">Pending</option>
            <option value="Terminated">Terminated</option>
          </select>
          <select
            value={selectedEnrollmentStatus}
            onChange={(e) => setSelectedEnrollmentStatus(e.target.value)}
            className="form-input focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">All Enrollment</option>
            <option value="Enrolled">Enrolled</option>
            <option value="Pending">Pending</option>
            <option value="Declined">Declined</option>
            <option value="Not Started">Not Started</option>
          </select>
          <select
            value={selectedLifecycleStage}
            onChange={(e) => setSelectedLifecycleStage(e.target.value)}
            className="form-input focus:ring-oe-primary focus:border-oe-primary"
          >
            <option value="">All Stages</option>
            <option value="Prospect">Prospect</option>
            <option value="Member">Member</option>
            <option value="Renewal">Renewal</option>
          </select>
          {/* Enrollment Date Filter */}
          <input
            type="date"
            value={selectedEnrollmentDate}
            onChange={(e) => setSelectedEnrollmentDate(e.target.value)}
            className="form-input focus:ring-oe-primary focus:border-oe-primary"
            placeholder="Enrollment Date"
          />
          {/* Product Type Filter */}
          <select
            value={selectedProductType}
            onChange={(e) => setSelectedProductType(e.target.value)}
            className="form-input focus:ring-oe-primary focus:border-oe-primary"
            disabled={productsLoading}
          >
            <option value="">All Products</option>
            {productTypes.map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <button
            onClick={loadMembers}
            className="inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-oe-neutral-light"
          >
            <Filter className="h-4 w-4 mr-2" />
            Filter
          </button>
        </div>
      </div>
      {/* Add Member Button */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setShowAddMemberModal(true)}
          className="inline-flex items-center px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
        >
          <UserPlus className="h-4 w-4 mr-2" /> Add Member
        </button>
      </div>

      {/* Members Table */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-oe-neutral-dark">
            Members ({members.length})
          </h2>
        </div>

        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-oe-primary"></div>
          </div>
        ) : members.length === 0 ? (
          <div className="p-8 text-center">
            <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-oe-neutral-dark mb-2">No members found</h3>
            <p className="text-gray-600 mb-4">
              {searchTerm || selectedStatus || selectedEnrollmentStatus || selectedLifecycleStage 
                ? 'Try adjusting your filters' 
                : 'You have no assigned members yet'
              }
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-oe-neutral-light">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Member
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Group
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Enrollment
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Stage
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Premium
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Last Contact
                  </th>
                  <th className="relative px-6 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {members.map((member) => (
                  <tr key={member.memberId} className="hover:bg-oe-neutral-light">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div className="flex-shrink-0 h-10 w-10">
                          <div className="h-10 w-10 rounded-full bg-oe-light flex items-center justify-center">
                            <span className="text-sm font-medium text-oe-primary">
                              {member.firstName.charAt(0)}{member.lastName.charAt(0)}
                            </span>
                          </div>
                        </div>
                        <div className="ml-4">
                          <div className="text-sm font-medium text-oe-neutral-dark">
                            {member.firstName} {member.lastName}
                          </div>
                          <div className="text-sm text-gray-500">
                            {member.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      {member.groupName ? (
                        <div className="text-sm text-oe-neutral-dark">{member.groupName}</div>
                      ) : (
                        <span className="text-sm text-gray-500 italic">Individual</span>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getStatusBadgeColor(member.status)}`}>
                        {member.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        {getEnrollmentStatusIcon(member.enrollmentStatus)}
                        <span className="ml-2 text-sm text-oe-neutral-dark">
                          {member.enrollmentStatus}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${getLifecycleBadgeColor(member.lifecycleStage)}`}>
                        {member.lifecycleStage}
                      </span>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-oe-neutral-dark">
                      ${member.totalPremium.toLocaleString()}
                      {member.dependentCount > 0 && (
                        <div className="text-xs text-gray-500">
                          +{member.dependentCount} dependent{member.dependentCount > 1 ? 's' : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {member.lastContactDate 
                        ? new Date(member.lastContactDate).toLocaleDateString()
                        : 'Never'
                      }
                      {member.nextFollowUpDate && (
                        <div className="text-xs text-oe-primary">
                          Follow up: {new Date(member.nextFollowUpDate).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex items-center space-x-2">
                        {member.enrollmentStatus !== 'Enrolled' && (
                          <button
                            onClick={() => {
                              setSendLinkMember({
                                memberId: member.memberId,
                                firstName: member.firstName,
                                lastName: member.lastName,
                                email: member.email,
                                phoneNumber: member.phoneNumber,
                              });
                              setShowSendLinkModal(true);
                            }}
                            className="inline-flex items-center px-2.5 py-1.5 text-xs font-medium rounded-lg text-white bg-oe-primary hover:bg-oe-dark transition-colors"
                            title="Send enrollment link"
                          >
                            <Send className="h-3.5 w-3.5 mr-1" />
                            Send Link
                          </button>
                        )}
                        <button
                          onClick={() => {/* Handle call */}}
                          className="text-oe-primary hover:text-oe-dark"
                          title="Call member"
                        >
                          <Phone className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => {/* Handle email */}}
                          className="text-oe-success hover:text-green-900"
                          title="Email member"
                        >
                          <Mail className="h-4 w-4" />
                        </button>
                        <div className="relative">
                          <button
                            onClick={() => setShowActionsMenu(showActionsMenu === member.memberId ? null : member.memberId)}
                            className="text-gray-400 hover:text-gray-500"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </button>
                          
                          {showActionsMenu === member.memberId && (
                            <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg ring-1 ring-black ring-opacity-5 focus:outline-none z-10">
                              <div className="py-1">
                                <button
                                  onClick={() => {
                                    setSelectedMember(member);
                                    setShowMemberModal(true);
                                    setShowActionsMenu(null);
                                  }}
                                  className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <Eye className="h-4 w-4 mr-2" />
                                  View Details
                                </button>
                                
                                <button
                                  onClick={() => {/* Handle edit */}}
                                  className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <Edit className="h-4 w-4 mr-2" />
                                  Edit Notes
                                </button>
                                
                                <div className="border-t border-gray-100 my-1"></div>
                                
                                <button
                                  onClick={() => handleUpdateMemberStage(member.memberId, 'Prospect')}
                                  className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <UserPlus className="h-4 w-4 mr-2" />
                                  Mark as Prospect
                                </button>
                                
                                <button
                                  onClick={() => handleUpdateMemberStage(member.memberId, 'Member')}
                                  className="flex items-center px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 w-full text-left"
                                >
                                  <CheckCircle className="h-4 w-4 mr-2" />
                                  Mark as Member
                                </button>
                                <button
                                  onClick={() => setShowTerminateModal({ open: true, member })}
                                  className="flex items-center px-4 py-2 text-sm text-red-700 hover:bg-red-50 w-full text-left"
                                >
                                  <AlertCircle className="h-4 w-4 mr-2" /> Terminate Member
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Member Details Modal */}
      {showMemberModal && selectedMember && (
        <MemberDetailsModal
          member={selectedMember}
          onClose={() => {
            setShowMemberModal(false);
            setSelectedMember(null);
          }}
          onUpdateNotes={handleUpdateMemberNotes}
        />
      )}
      {/* Add AddMemberModal */}
      {showAddMemberModal && (
        <AddMemberModal
          onClose={() => setShowAddMemberModal(false)}
          onMemberAdded={loadMembers}
        />
      )}
      {/* Add TerminateMemberModal */}
      {showTerminateModal.open && (
        <TerminateMemberModal
          member={showTerminateModal.member}
          onClose={() => setShowTerminateModal({ open: false, member: null })}
          onTerminated={loadMembers}
        />
      )}
      {showSendLinkModal && sendLinkMember && (
        <QuickEnrollmentLinkModal
          open={showSendLinkModal}
          onClose={() => {
            setShowSendLinkModal(false);
            setSendLinkMember(null);
          }}
          onLinkSent={() => {
            setShowSendLinkModal(false);
            setSendLinkMember(null);
          }}
          prefillMember={sendLinkMember}
        />
      )}
    </div>
  );
};

// Member Details Modal Component
interface MemberDetailsModalProps {
  member: AgentMember;
  onClose: () => void;
  onUpdateNotes: (memberId: string, notes: string, nextFollowUpDate?: string) => void;
}

const MemberDetailsModal: React.FC<MemberDetailsModalProps> = ({ 
  member, 
  onClose, 
  onUpdateNotes 
}) => {
  const [notes, setNotes] = useState(member.notes || '');
  const [nextFollowUpDate, setNextFollowUpDate] = useState(member.nextFollowUpDate || '');
  const [tab, setTab] = useState<'coverage' | 'household' | 'communication' | 'payments'>('coverage');

  const handleSave = () => {
    onUpdateNotes(member.memberId, notes, nextFollowUpDate || undefined);
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-2xl w-full p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-oe-neutral-dark">
            {member.firstName} {member.lastName} - Member Details
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">×</button>
        </div>
        {/* Tabs */}
        <div className="flex space-x-4 border-b mb-4">
          <button className={`pb-2 ${tab === 'coverage' ? 'border-b-2 border-oe-primary text-oe-primary' : 'text-gray-600'}`} onClick={() => setTab('coverage')}>Coverage</button>
          <button className={`pb-2 ${tab === 'household' ? 'border-b-2 border-oe-primary text-oe-primary' : 'text-gray-600'}`} onClick={() => setTab('household')}>Household</button>
          <button className={`pb-2 ${tab === 'communication' ? 'border-b-2 border-oe-primary text-oe-primary' : 'text-gray-600'}`} onClick={() => setTab('communication')}>Communication Log</button>
          <button className={`pb-2 ${tab === 'payments' ? 'border-b-2 border-oe-primary text-oe-primary' : 'text-gray-600'}`} onClick={() => setTab('payments')}>Payment History</button>
        </div>
        {/* Tab Content */}
        {tab === 'coverage' && (
          <div>(Coverage summary goes here)</div>
        )}
        {tab === 'household' && (
          <div>(Household details go here)</div>
        )}
        {tab === 'communication' && (
          <div>(Communication log goes here)</div>
        )}
        {tab === 'payments' && (
          <div>(Payment history and invoice status go here)</div>
        )}
        {/* Notes and follow-up (always visible) */}
        <div className="space-y-4 mt-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full form-input focus:ring-oe-primary focus:border-oe-primary"
              placeholder="Add notes about this member..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Next Follow-up Date
            </label>
            <input
              type="date"
              value={nextFollowUpDate}
              onChange={(e) => setNextFollowUpDate(e.target.value)}
              className="w-full form-input focus:ring-oe-primary focus:border-oe-primary"
            />
          </div>
        </div>
        <div className="flex justify-end space-x-3 pt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-oe-neutral-light"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

function getStatusBadgeColor(status: string) {
  switch (status) {
    case 'Active':
      return 'bg-green-100 text-green-800';
    case 'Inactive':
      return 'bg-gray-100 text-gray-800';
    case 'Pending':
      return 'bg-yellow-100 text-yellow-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

function getLifecycleBadgeColor(stage: string) {
  switch (stage) {
    case 'Prospect':
      return 'bg-purple-100 text-purple-800';
    case 'Member':
      return 'bg-green-100 text-green-800';
    case 'Renewal':
      return 'bg-orange-100 text-orange-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

// AddMemberModal stub
const AddMemberModal = ({ onClose, onMemberAdded }: { onClose: () => void; onMemberAdded: () => void }) => {
  // TODO: Implement form fields and backend call
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-lg w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-oe-neutral-dark">Add New Member</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">×</button>
        </div>
        <div className="mb-4">(Form fields go here)</div>
        <div className="flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-oe-neutral-light">Cancel</button>
          <button onClick={() => { /* TODO: Call backend */ onMemberAdded(); onClose(); }} className="px-4 py-2 text-sm font-medium text-white bg-oe-primary border border-transparent rounded-md hover:bg-oe-dark">Add Member</button>
        </div>
      </div>
    </div>
  );
};

// TerminateMemberModal stub
const TerminateMemberModal = ({ member, onClose, onTerminated }: { member: AgentMember | null; onClose: () => void; onTerminated: () => void }) => {
  // TODO: Implement backend call for termination (effective next bill date, no proration)
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg max-w-lg w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-red-700">Terminate Member</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-500">×</button>
        </div>
        <div className="mb-4">Are you sure you want to terminate <span className="font-semibold">{member?.firstName} {member?.lastName}</span>?<br/>Termination will be effective on the next bill date. No proration will occur.</div>
        <div className="flex justify-end space-x-3">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-oe-neutral-light">Cancel</button>
          <button onClick={() => { /* TODO: Call backend */ onTerminated(); onClose(); }} className="px-4 py-2 text-sm font-medium text-white bg-red-600 border border-transparent rounded-md hover:bg-red-700">Terminate</button>
        </div>
      </div>
    </div>
  );
};

export default AgentMemberManagement;





