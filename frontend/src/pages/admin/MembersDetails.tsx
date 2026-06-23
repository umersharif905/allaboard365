// File: frontend/src/pages/admin/MembersDetails.tsx
import { Home, Mail, Trash2, UserPlus, Users, X } from 'lucide-react';
import React from 'react';
import { Member } from '../../types/member.types';

interface Enrollment {
  EnrollmentId: string;
  ProductName: string;
  ProductType: string;
  Status: string;
  EffectiveDate: string;
  TerminationDate?: string;
  Premium: number;
  PaymentFrequency: string;
}

interface Props {
  member: Member;
  householdMembers: Member[];
  memberEnrollments: Enrollment[];
  enrollmentsLoading: boolean;
  onClose: () => void;
  onEdit: (member: Member) => void;
  onDelete: (memberId: string) => void;
  onAddDependent: () => void;
  onSendEnrollmentLink?: (member: Member) => void;
  formatCurrency: (amount: number) => string;
  getStatusColor: (status: string) => string;
  getRelationshipIcon: (relationshipType?: string) => React.ReactNode;
  getRelationshipColor: (relationshipType?: string) => string;
}

const MembersDetails: React.FC<Props> = ({
  member,
  householdMembers,
  memberEnrollments,
  enrollmentsLoading,
  onClose,
  onEdit,
  onDelete,
  onAddDependent,
  onSendEnrollmentLink,
  formatCurrency,
  getStatusColor,
  getRelationshipIcon,
  getRelationshipColor
}) => {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex justify-between items-start mb-6">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-oe-light flex items-center justify-center">
                <Users size={24} className="text-oe-primary" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-oe-neutral-dark">{member.FirstName} {member.LastName}</h2>
                <p className="text-gray-600">{member.Email}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`inline-block px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(member.Status)}`}>
                    {member.Status}
                  </span>
                  <div className="flex items-center">
                    {getRelationshipIcon(member.RelationshipType)}
                    <span className={`ml-1 px-2 py-1 text-xs font-medium rounded-full ${getRelationshipColor(member.RelationshipType)}`}>
                      {member.RelationshipDescription || 'Primary'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 p-1 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X size={25} />
            </button>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Personal Information */}
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Personal Information</h3>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium text-gray-700">First Name</label>
                      <p className="text-oe-neutral-dark">{member.FirstName}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">Last Name</label>
                      <p className="text-oe-neutral-dark">{member.LastName}</p>
                    </div>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Email</label>
                    <p className="text-oe-neutral-dark">{member.Email}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Phone Number</label>
                    <p className="text-oe-neutral-dark">{member.PhoneNumber || 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Date of Birth</label>
                    <p className="text-oe-neutral-dark">{member.DateOfBirth || 'Not provided'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Gender</label>
                    <p className="text-oe-neutral-dark">{member.Gender || 'Not provided'}</p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Address Information</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Address</label>
                    <p className="text-oe-neutral-dark">{member.Address || 'Not provided'}</p>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-sm font-medium text-gray-700">City</label>
                      <p className="text-oe-neutral-dark">{member.City || 'Not provided'}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">State</label>
                      <p className="text-oe-neutral-dark">{member.State || 'Not provided'}</p>
                    </div>
                    <div>
                      <label className="text-sm font-medium text-gray-700">ZIP Code</label>
                      <p className="text-oe-neutral-dark">{member.Zip || 'Not provided'}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Membership Details</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium text-gray-700">Tenant</label>
                    <p className="text-oe-neutral-dark">{member.TenantName || 'No Tenant'}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Enrollment Type</label>
                    <p className="text-oe-neutral-dark">{member.EnrollmentType || 'Standard'}</p>
                  </div>
                  {member.GroupName && (
                    <div>
                      <label className="text-sm font-medium text-gray-700">Group</label>
                      <p className="text-oe-neutral-dark">{member.GroupName}</p>
                    </div>
                  )}
                  <div>
                    <label className="text-sm font-medium text-gray-700">Member Since</label>
                    <p className="text-oe-neutral-dark">{new Date(member.CreatedDate).toLocaleDateString()}</p>
                  </div>
                </div>
              </div>

              {/* Household Members Section - Only show for Primary members */}
              {member.RelationshipType === 'P' && (
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold text-oe-neutral-dark">Household Members</h3>
                    <button
                      onClick={onAddDependent}
                      className="bg-oe-primary text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-oe-dark transition-colors flex items-center"
                    >
                      <UserPlus size={14} className="mr-1" />
                      Add Dependent
                    </button>
                  </div>
                  
                  {householdMembers.length > 0 ? (
                    <div className="space-y-3">
                      {householdMembers.map((householdMember) => (
                        <div key={householdMember.MemberId} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200">
                          <div className="flex items-center">
                            {getRelationshipIcon(householdMember.RelationshipType)}
                            <div className="ml-3">
                              <div className="text-sm font-medium text-oe-neutral-dark">
                                {householdMember.FirstName} {householdMember.LastName}
                              </div>
                              <div className="text-xs text-gray-500">
                                {householdMember.Email}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${getRelationshipColor(householdMember.RelationshipType)}`}>
                              {householdMember.RelationshipDescription}
                            </span>
                            <div className="text-xs text-gray-500 mt-1">
                              {householdMember.ActiveEnrollments || 0} enrollments
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-6 text-gray-500 bg-gray-50 rounded-lg border border-gray-200">
                      <Users size={32} className="mx-auto mb-2 text-gray-400" />
                      <p className="text-sm">No dependents added yet</p>
                      <p className="text-xs text-gray-400">Click "Add Dependent" to add spouse or children</p>
                    </div>
                  )}
                </div>
              )}

              {/* Show household context for non-Primary members */}
              {member.RelationshipType !== 'P' && member.HouseholdId && (
                <div>
                  <h3 className="text-lg font-semibold text-oe-neutral-dark mb-4">Household Information</h3>
                  <div className="p-4 bg-blue-50 rounded-lg border border-blue-200">
                    <div className="flex items-center">
                      <Home size={20} className="text-oe-primary mr-2" />
                      <div>
                        <p className="text-sm font-medium text-blue-800">
                          This member belongs to {member.PrimaryMemberName}'s household
                        </p>
                        <p className="text-xs text-oe-primary">
                          Household ID: {member.HouseholdId}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Enrollments */}
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-lg font-semibold text-oe-neutral-dark">Enrollments</h3>
                <div className="text-sm text-gray-600">
                  {member.ActiveEnrollments || 0} active of {member.TotalEnrollments || 0} total
                </div>
              </div>
              
              {enrollmentsLoading ? (
                <div className="text-center py-8">
                  <div className="text-gray-600">Loading enrollments...</div>
                </div>
              ) : (
                <div className="space-y-3">
                  {Array.isArray(memberEnrollments) && memberEnrollments.map((enrollment) => (
                    <div key={enrollment.EnrollmentId} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <h4 className="font-medium text-oe-neutral-dark">{enrollment.ProductName}</h4>
                          <p className="text-sm text-gray-600">{enrollment.ProductType}</p>
                        </div>
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(enrollment.Status)}`}>
                          {enrollment.Status}
                        </span>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 text-sm">
                        <div>
                          <label className="text-gray-500">Effective Date</label>
                          <p className="text-oe-neutral-dark">{new Date(enrollment.EffectiveDate).toLocaleDateString()}</p>
                        </div>
                        {enrollment.TerminationDate && (
                          <div>
                            <label className="text-gray-500">Termination Date</label>
                            <p className="text-oe-neutral-dark">{new Date(enrollment.TerminationDate).toLocaleDateString()}</p>
                          </div>
                        )}
                        <div>
                          <label className="text-gray-500">Premium</label>
                          <p className="text-oe-neutral-dark font-medium">{formatCurrency(enrollment.Premium)}</p>
                        </div>
                        <div>
                          <label className="text-gray-500">Payment Frequency</label>
                          <p className="text-oe-neutral-dark">{enrollment.PaymentFrequency}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                  {(!Array.isArray(memberEnrollments) || memberEnrollments.length === 0) && (
                    <div className="text-center py-8 text-gray-500">
                      No enrollments found for this member
                    </div>
                  )}
                </div>
              )}

              <div className="mt-6 p-4 bg-oe-neutral-light rounded-lg">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <label className="text-gray-500">Total Active Enrollments</label>
                    <p className="text-lg font-medium text-oe-neutral-dark">{member.ActiveEnrollments || 0}</p>
                  </div>
                  <div>
                    <label className="text-gray-500">Total Monthly Premium</label>
                    <p className="text-lg font-medium text-oe-success">{formatCurrency(member.MonthlyPremium || 0)}</p>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex gap-3">
                <button 
                  onClick={() => onEdit(member)}
                  className="flex-1 bg-oe-primary text-white py-2 px-4 rounded-md font-medium hover:bg-oe-dark transition-colors"
                >
                  Edit Member
                </button>
                <button className="flex-1 border border-gray-300 py-2 px-4 rounded-md font-medium hover:bg-oe-neutral-light transition-colors">
                  View Payments
                </button>
                {/* Send Enrollment Link Button - Only show for unenrolled members */}
                {onSendEnrollmentLink && (member.ActiveEnrollments === 0 || !member.ActiveEnrollments) && (
                  <button
                    onClick={() => onSendEnrollmentLink(member)}
                    className="bg-green-600 text-white px-4 py-2 rounded-md font-medium hover:bg-green-700 transition-colors flex items-center"
                    title={member.GroupId ? "Send group enrollment link" : "Send individual enrollment link"}
                  >
                    <Mail size={16} className="mr-1" />
                    {member.GroupId ? "Send Group Link" : "Send Individual Link"}
                  </button>
                )}
                <button 
                  onClick={() => onDelete(member.MemberId)}
                  className="px-4 py-2 border border-red-300 text-red-600 rounded-md font-medium hover:bg-red-50 transition-colors flex items-center"
                >
                  <Trash2 size={16} className="mr-1" />
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MembersDetails;