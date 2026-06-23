/**
 * Tenant Admin Agent Details Page
 * Shows detailed view of individual agent or agency with tabs
 * Updated to remove Group logic and implement all required tabs
 */

import {
    AlertTriangle,
    ArrowLeft,
    Building,
    CheckCircle,
    ChevronRight,
    Clock,
    DollarSign,
    Download,
    Edit,
    FileText,
    Mail,
    Plus,
    Trash2,
    TrendingUp,
    User,
    Users,
    XCircle
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { LICENSE_TYPES } from '../../constants/form-options';
import TenantAdminAgentsService, {
    AgentDetails,
    AgentHierarchy,
    CreateDocumentRequest,
    CreateLicenseRequest
} from '../../services/tenant-admin/agents.service';

const TenantAgentDetails: React.FC = () => {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  
  // State management
  const [agent, setAgent] = useState<AgentDetails | null>(null);
  const [downline, setDownline] = useState<AgentHierarchy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'licenses' | 'downline' | 'documents' | 'commission'>('overview');
  
  // Modal states
  const [showAddLicenseModal, setShowAddLicenseModal] = useState(false);
  const [showAddDocumentModal, setShowAddDocumentModal] = useState(false);
  const [showAssignUplineModal, setShowAssignUplineModal] = useState(false);
  
  // Form states
  const [licenseForm, setLicenseForm] = useState<CreateLicenseRequest>({
    stateCode: '',
    licenseNumber: '',
    licenseType: '',
    expirationDate: '',
    issueDate: '',
    documentUrl: ''
  });
  
  const [documentForm, setDocumentForm] = useState<CreateDocumentRequest>({
    documentType: '',
    fileName: '',
    fileUrl: '',
    fileSize: 0,
    fileType: '',
    description: ''
  });

  const [uplineForm, setUplineForm] = useState({
    parentId: '',
    parentType: 'Agency' as 'Agent' | 'Agency',
    overridePercentage: 0
  });

  // Available agents/agencies for upline assignment
  const [availableUplines, setAvailableUplines] = useState<any[]>([]);

  // Load data on component mount
  useEffect(() => {
    if (agentId) {
      loadAgentDetails();
      loadDownline();
      loadAvailableUplines();
    }
  }, [agentId]);

  const loadAgentDetails = async () => {
    if (!agentId) return;
    
    try {
      setLoading(true);
      setError(null);
      
      const response = await TenantAdminAgentsService.getAgentDetails(agentId);
      
      if (response.success && response.data) {
        setAgent(response.data);
      } else {
        setError(response.message || 'Failed to load agent details');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load agent details');
    } finally {
      setLoading(false);
    }
  };

  const loadDownline = async () => {
    if (!agentId) return;
    
    try {
      const response = await TenantAdminAgentsService.getAgentDownline(agentId);
      
      if (response.success && response.data) {
        setDownline(response.data);
      }
    } catch (err: any) {
      console.error('Failed to load downline:', err);
    }
  };

  const loadAvailableUplines = async () => {
    try {
      // Load both agents and agencies that could be uplines
      const [agentsResponse, agenciesResponse] = await Promise.all([
        TenantAdminAgentsService.getAgentsAndAgencies({ type: 'Agent' }),
        TenantAdminAgentsService.getAvailableAgencies()
      ]);

      const uplines = [
        ...(agenciesResponse.data || []).map((a: any) => ({ 
          id: a.AgencyId, 
          name: a.AgencyName, 
          type: 'Agency' 
        })),
        ...(agentsResponse.data || []).filter((a: any) => a.Id !== agentId).map((a: any) => ({ 
          id: a.Id, 
          name: a.Name, 
          type: 'Agent' 
        }))
      ];

      setAvailableUplines(uplines);
    } catch (err) {
      console.error('Failed to load available uplines:', err);
    }
  };

  // Handle adding license
  const handleAddLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId) return;
    
    try {
      setLoading(true);
      const response = await TenantAdminAgentsService.addLicense(agentId, licenseForm);
      
      if (response.success) {
        setShowAddLicenseModal(false);
        setLicenseForm({
          stateCode: '',
          licenseNumber: '',
          licenseType: '',
          expirationDate: '',
          issueDate: '',
          documentUrl: ''
        });
        await loadAgentDetails();
      } else {
        setError(response.message || 'Failed to add license');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to add license');
    } finally {
      setLoading(false);
    }
  };

  // Handle removing license
  const handleRemoveLicense = async (licenseId: string) => {
    if (!agentId || !confirm('Are you sure you want to remove this license?')) return;
    
    try {
      setLoading(true);
      const response = await TenantAdminAgentsService.removeLicense(agentId, licenseId);
      
      if (response.success) {
        await loadAgentDetails();
      } else {
        setError(response.message || 'Failed to remove license');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to remove license');
    } finally {
      setLoading(false);
    }
  };

  // Handle adding document
  const handleAddDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId) return;
    
    try {
      setLoading(true);
      const response = await TenantAdminAgentsService.uploadDocument(agentId, documentForm);
      
      if (response.success) {
        setShowAddDocumentModal(false);
        setDocumentForm({
          documentType: '',
          fileName: '',
          fileUrl: '',
          fileSize: 0,
          fileType: '',
          description: ''
        });
        await loadAgentDetails();
      } else {
        setError(response.message || 'Failed to upload document');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to upload document');
    } finally {
      setLoading(false);
    }
  };

  // Helper functions
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Active':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'Inactive':
        return <XCircle className="h-5 w-5 text-red-500" />;
      default:
        return <Clock className="h-5 w-5 text-yellow-500" />;
    }
  };

  const getTypeIcon = (type: string) => {
    return type === 'Agent' ? 
      <User className="h-6 w-6 text-oe-primary" /> : 
      <Building className="h-6 w-6 text-purple-500" />;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getLicenseStatus = (expirationDate?: string) => {
    if (!expirationDate) return { color: 'gray', text: 'No expiration' };
    
    const date = new Date(expirationDate);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    
    if (daysUntilExpiry < 0) {
      return { color: 'red', text: 'Expired' };
    } else if (daysUntilExpiry < 30) {
      return { color: 'yellow', text: `Expires in ${daysUntilExpiry} days` };
    } else {
      return { color: 'green', text: 'Valid' };
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="h-64 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  if (error || !agent) {
    return (
      <div className="p-6 max-w-7xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center">
            <AlertTriangle className="h-5 w-5 text-red-500 mr-2" />
            <span className="text-red-700">{error || 'Agent not found'}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('/tenant-admin/agents')}
              className="mr-4 p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="flex items-center">
              {getTypeIcon(agent.Type)}
              <div className="ml-3">
                <h1 className="text-2xl font-bold text-gray-900">{agent.Name}</h1>
                <p className="text-gray-600">{agent.Type}</p>
              </div>
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <div className="flex items-center">
              {getStatusIcon(agent.Status)}
              <span className="ml-2 text-sm font-medium text-gray-700">{agent.Status}</span>
            </div>
            <button
              onClick={() => navigate(`/tenant-admin/agents/${agent.Id}/edit`)}
              className="btn-primary flex items-center space-x-2"
            >
              <Edit className="h-4 w-4" />
              <span>Edit</span>
            </button>
          </div>
        </div>

        {/* Quick Info Cards - REMOVED Group Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Contact</p>
                <p className="text-lg font-semibold text-gray-900">{agent.Email}</p>
                {agent.Phone && (
                  <p className="text-sm text-gray-500">{agent.Phone}</p>
                )}
              </div>
              <Mail className="h-8 w-8 text-oe-primary" />
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">
                  {agent.Type === 'Agent' ? 'NPN' : 'EIN'}
                </p>
                <p className="text-lg font-semibold text-gray-900">{agent.NPN || 'Not provided'}</p>
                {agent.Role && (
                  <p className="text-sm text-gray-500">{agent.Role}</p>
                )}
              </div>
              <FileText className="h-8 w-8 text-purple-500" />
            </div>
          </div>
          
          <div className="bg-white rounded-lg shadow-sm border p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Agency</p>
                <p className="text-lg font-semibold text-gray-900">{agent.AgencyName || 'Independent'}</p>
                {downline.length > 0 && (
                  <p className="text-sm text-gray-500">{downline.length} downline agents</p>
                )}
              </div>
              <Users className="h-8 w-8 text-green-500" />
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8">
            {[
              { key: 'overview', label: 'Overview', count: null },
              { key: 'licenses', label: 'Licenses', count: agent.licenses?.length || 0 },
              { key: 'downline', label: 'Downline', count: downline.length },
              { key: 'documents', label: 'Documents', count: agent.documents?.length || 0 },
              { key: 'commission', label: 'Commission', count: null }
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                className={`py-4 px-1 border-b-2 font-medium text-sm ${
                  activeTab === tab.key
                    ? 'border-oe-primary text-oe-primary'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                {tab.label}
                {tab.count !== null && (
                  <span className="ml-2 bg-gray-100 text-gray-900 py-0.5 px-2 rounded-full text-xs">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-lg shadow-sm border">
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="p-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Basic Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Full Name</label>
                    <p className="mt-1 text-sm text-gray-900">{agent.Name}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Email</label>
                    <p className="mt-1 text-sm text-gray-900">{agent.Email}</p>
                  </div>
                  {agent.Phone && (
                    <div>
                      <label className="block text-sm font-medium text-gray-500">Phone</label>
                      <p className="mt-1 text-sm text-gray-900">{agent.Phone}</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-500">
                      {agent.Type === 'Agent' ? 'NPN' : 'EIN'}
                    </label>
                    <p className="mt-1 text-sm text-gray-900">{agent.NPN || 'Not provided'}</p>
                  </div>
                  {agent.Role && (
                    <div>
                      <label className="block text-sm font-medium text-gray-500">Commission Role</label>
                      <p className="mt-1 text-sm text-gray-900">{agent.Role}</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Status</label>
                    <div className="mt-1 flex items-center">
                      {getStatusIcon(agent.Status)}
                      <span className="ml-2 text-sm text-gray-900">{agent.Status}</span>
                    </div>
                  </div>
                </div>
              </div>
              
              <div>
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Assignment Information</h3>
                <div className="space-y-4">
                  {agent.AgencyName && (
                    <div>
                      <label className="block text-sm font-medium text-gray-500">Agency</label>
                      <p className="mt-1 text-sm text-gray-900">{agent.AgencyName}</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Created Date</label>
                    <p className="mt-1 text-sm text-gray-900">{formatDate(agent.CreatedDate)}</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-500">Last Modified</label>
                    <p className="mt-1 text-sm text-gray-900">{formatDate(agent.ModifiedDate)}</p>
                  </div>
                  <div className="pt-4">
                    <button
                      onClick={() => setShowAssignUplineModal(true)}
                      className="btn-secondary flex items-center space-x-2"
                    >
                      <Users className="h-4 w-4" />
                      <span>Manage Upline</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Licenses Tab */}
        {activeTab === 'licenses' && agent.Type === 'Agent' && (
          <div className="p-6">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-semibold text-gray-900">Licenses</h3>
              <button
                onClick={() => setShowAddLicenseModal(true)}
                className="btn-primary flex items-center space-x-2"
              >
                <Plus className="h-4 w-4" />
                <span>Add License</span>
              </button>
            </div>
            
            {agent.licenses && agent.licenses.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {agent.licenses.map((license) => {
                  const status = getLicenseStatus(license.ExpirationDate);
                  return (
                    <div key={license.LicenseId} className="border rounded-lg p-4">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h4 className="font-medium text-gray-900">{license.StateCode}</h4>
                          <p className="text-sm text-gray-600">{license.LicenseType || 'General'}</p>
                        </div>
                        <div className="flex items-center space-x-2">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            status.color === 'green' ? 'bg-green-100 text-green-800' :
                            status.color === 'yellow' ? 'bg-yellow-100 text-yellow-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {status.text}
                          </span>
                          <button
                            onClick={() => handleRemoveLicense(license.LicenseId)}
                            className="text-red-600 hover:text-red-800"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      
                      <div className="space-y-2 text-sm">
                        <div>
                          <span className="font-medium text-gray-700">License #:</span>
                          <span className="ml-2 text-gray-900">{license.LicenseNumber}</span>
                        </div>
                        {license.IssueDate && (
                          <div>
                            <span className="font-medium text-gray-700">Issued:</span>
                            <span className="ml-2 text-gray-900">{formatDate(license.IssueDate)}</span>
                          </div>
                        )}
                        {license.ExpirationDate && (
                          <div>
                            <span className="font-medium text-gray-700">Expires:</span>
                            <span className="ml-2 text-gray-900">{formatDate(license.ExpirationDate)}</span>
                          </div>
                        )}
                        {license.UploadedDocumentUrl && (
                          <div>
                            <a
                              href={license.UploadedDocumentUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center text-oe-primary hover:text-oe-dark"
                            >
                              <FileText className="h-4 w-4 mr-1" />
                              View Document
                            </a>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-8">
                <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">No licenses added yet</p>
                <p className="text-sm text-gray-500">Click "Add License" to get started</p>
              </div>
            )}
          </div>
        )}

        {/* Downline Tab */}
        {activeTab === 'downline' && (
          <div className="p-6">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-semibold text-gray-900">Downline Structure</h3>
              <button
                onClick={() => setShowAssignUplineModal(true)}
                className="btn-secondary flex items-center space-x-2"
              >
                <Users className="h-4 w-4" />
                <span>Manage Hierarchy</span>
              </button>
            </div>
            
            {downline.length > 0 ? (
              <div className="space-y-4">
                {downline.map((member) => (
                  <div key={member.AgentId} className="border rounded-lg p-4 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        {member.Level > 0 && (
                          <div className="flex items-center text-gray-400">
                            {Array.from({ length: member.Level }).map((_, i) => (
                              <ChevronRight key={i} className="h-4 w-4" />
                            ))}
                          </div>
                        )}
                        <div>
                          <h4 className="font-medium text-gray-900">{member.AgentName}</h4>
                          <p className="text-sm text-gray-600">{member.Email}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-gray-700">
                          {member.CommissionRole || 'Agent'}
                        </div>
                        <div className="text-sm text-gray-500">
                          Level {member.Level}
                        </div>
                        {member.OverridePercentage && (
                          <div className="text-sm text-oe-primary font-medium">
                            {member.OverridePercentage}% override
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <Users className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">No downline agents</p>
                <p className="text-sm text-gray-500">This agent has no agents reporting to them</p>
              </div>
            )}
          </div>
        )}

        {/* Documents Tab */}
        {activeTab === 'documents' && (
          <div className="p-6">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-semibold text-gray-900">Documents</h3>
              <button
                onClick={() => setShowAddDocumentModal(true)}
                className="btn-primary flex items-center space-x-2"
              >
                <Plus className="h-4 w-4" />
                <span>Upload Document</span>
              </button>
            </div>
            
            {agent.documents && agent.documents.length > 0 ? (
              <div className="grid grid-cols-1 gap-4">
                {agent.documents.map((document) => (
                  <div key={document.DocumentId} className="border rounded-lg p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <FileText className="h-8 w-8 text-oe-primary" />
                        <div>
                          <h4 className="font-medium text-gray-900">{document.FileName}</h4>
                          <p className="text-sm text-gray-600">{document.DocumentType}</p>
                          {document.Description && (
                            <p className="text-sm text-gray-500">{document.Description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <div className="text-right text-sm text-gray-500">
                          <div>{formatDate(document.CreatedDate)}</div>
                          {document.FileSize && (
                            <div>{Math.round(document.FileSize / 1024)} KB</div>
                          )}
                        </div>
                        <a
                          href={document.FileUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-oe-primary hover:text-oe-dark"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8">
                <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">No documents uploaded yet</p>
                <p className="text-sm text-gray-500">Click "Upload Document" to get started</p>
              </div>
            )}
          </div>
        )}

        {/* Commission Tab */}
        {activeTab === 'commission' && (
          <div className="p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-6">Commission Information</h3>
            
            {/* Commission Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
              <div className="bg-gray-50 rounded-lg p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">MTD Commissions</p>
                    <p className="text-2xl font-bold text-gray-900">$0.00</p>
                    <p className="text-sm text-gray-500">Current month</p>
                  </div>
                  <DollarSign className="h-8 w-8 text-green-500" />
                </div>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">YTD Commissions</p>
                    <p className="text-2xl font-bold text-gray-900">$0.00</p>
                    <p className="text-sm text-gray-500">Year to date</p>
                  </div>
                  <TrendingUp className="h-8 w-8 text-oe-primary" />
                </div>
              </div>
              
              <div className="bg-gray-50 rounded-lg p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-600">Override Rate</p>
                    <p className="text-2xl font-bold text-gray-900">0%</p>
                    <p className="text-sm text-gray-500">Current rate</p>
                  </div>
                  <Users className="h-8 w-8 text-purple-500" />
                </div>
              </div>
            </div>

            <div className="border-t pt-6">
              <div className="text-center py-8">
                <TrendingUp className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                <p className="text-gray-600">Commission tracking coming soon</p>
                <p className="text-sm text-gray-500">Detailed commission logs and payout history will be available in Phase 4</p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add License Modal */}
      {showAddLicenseModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Add New License</h2>
              
              <form onSubmit={handleAddLicense} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    State *
                  </label>
                  <select
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.stateCode}
                    onChange={(e) => setLicenseForm(prev => ({ ...prev, stateCode: e.target.value }))}
                  >
                    <option value="">Select State</option>
                    {TenantAdminAgentsService.getStateOptions().map(state => (
                      <option key={state.value} value={state.value}>{state.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    License Number *
                  </label>
                  <input
                    type="text"
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.licenseNumber}
                    onChange={(e) => setLicenseForm(prev => ({ ...prev, licenseNumber: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    License Type
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.licenseType}
                    onChange={(e) => setLicenseForm(prev => ({ ...prev, licenseType: e.target.value }))}
                  >
                    <option value="">Select Type</option>
                    {LICENSE_TYPES.map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Issue Date
                  </label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.issueDate}
                    onChange={(e) => setLicenseForm(prev => ({ ...prev, issueDate: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Expiration Date
                  </label>
                  <input
                    type="date"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.expirationDate}
                    onChange={(e) => setLicenseForm(prev => ({ ...prev, expirationDate: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Document URL
                  </label>
                  <input
                    type="url"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={licenseForm.documentUrl}
                    onChange={(e) => setLicenseForm(prev => ({ ...prev, documentUrl: e.target.value }))}
                  />
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddLicenseModal(false)}
                    className="px-4 py-2 text-gray-600 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary disabled:opacity-50"
                  >
                    {loading ? 'Adding...' : 'Add License'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Add Document Modal */}
      {showAddDocumentModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Upload Document</h2>
              
              <form onSubmit={handleAddDocument} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Document Type *
                  </label>
                  <select
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={documentForm.documentType}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, documentType: e.target.value }))}
                  >
                    <option value="">Select Type</option>
                    {TenantAdminAgentsService.getDocumentTypeOptions().map(type => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    File Name *
                  </label>
                  <input
                    type="text"
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={documentForm.fileName}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, fileName: e.target.value }))}
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    File URL *
                  </label>
                  <input
                    type="url"
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={documentForm.fileUrl}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, fileUrl: e.target.value }))}
                    placeholder="https://example.com/document.pdf"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    File Type
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={documentForm.fileType}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, fileType: e.target.value }))}
                  >
                    <option value="">Select File Type</option>
                    <option value="PDF">PDF</option>
                    <option value="DOC">Word Document</option>
                    <option value="DOCX">Word Document (Modern)</option>
                    <option value="XLS">Excel Spreadsheet</option>
                    <option value="XLSX">Excel Spreadsheet (Modern)</option>
                    <option value="JPG">JPEG Image</option>
                    <option value="PNG">PNG Image</option>
                    <option value="TXT">Text File</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    File Size (KB)
                  </label>
                  <input
                    type="number"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={documentForm.fileSize}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, fileSize: parseInt(e.target.value) || 0 }))}
                    placeholder="0"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Description
                  </label>
                  <textarea
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    rows={3}
                    value={documentForm.description}
                    onChange={(e) => setDocumentForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Optional description of the document"
                  />
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAddDocumentModal(false)}
                    className="px-4 py-2 text-gray-600 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loading}
                    className="btn-primary disabled:opacity-50"
                  >
                    {loading ? 'Uploading...' : 'Upload Document'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Assign Upline Modal */}
      {showAssignUplineModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full">
            <div className="p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-4">Manage Agent Hierarchy</h2>
              
              <form className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Parent Type
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={uplineForm.parentType}
                    onChange={(e) => setUplineForm(prev => ({ ...prev, parentType: e.target.value as 'Agent' | 'Agency' }))}
                  >
                    <option value="Agency">Agency</option>
                    <option value="Agent">Agent</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Select {uplineForm.parentType}
                  </label>
                  <select
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={uplineForm.parentId}
                    onChange={(e) => setUplineForm(prev => ({ ...prev, parentId: e.target.value }))}
                  >
                    <option value="">Select {uplineForm.parentType}...</option>
                    {availableUplines
                      .filter(u => u.type === uplineForm.parentType)
                      .map(upline => (
                        <option key={upline.id} value={upline.id}>
                          {upline.name}
                        </option>
                      ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Override Percentage
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-oe-primary"
                    value={uplineForm.overridePercentage}
                    onChange={(e) => setUplineForm(prev => ({ ...prev, overridePercentage: parseFloat(e.target.value) || 0 }))}
                    placeholder="0.00"
                  />
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowAssignUplineModal(false)}
                    className="px-4 py-2 text-gray-600 bg-gray-200 rounded-md hover:bg-gray-300 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={loading || !uplineForm.parentId}
                    className="btn-primary disabled:opacity-50"
                  >
                    {loading ? 'Saving...' : 'Save Hierarchy'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TenantAgentDetails;