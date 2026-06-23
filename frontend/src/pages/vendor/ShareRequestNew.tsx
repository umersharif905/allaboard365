// pages/vendor/ShareRequestNew.tsx
// Create New Share Request Form

import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { 
  ArrowLeft, 
  Search,
  User,
  Save,
  Plus,
  X,
  Star
} from 'lucide-react';
import { apiService } from '../../services/api.service';
import { vendorRequestTypesService } from '../../services/vendorRequestTypes.service';
import {
  type VendorRequestType,
  SHARE_REQUEST_STATUSES,
} from '../../types/shareRequest.types';

interface MemberSearchResult {
  MemberId: string;
  FirstName: string;
  LastName: string;
  Email: string;
  HouseholdId?: string;
  HouseholdMemberID?: string;
  Relationship?: string;
  DateOfBirth?: string;
}

interface ShareRequestNewProps {
  // When rendered inside another page (e.g. the Members workspace tab),
  // pass the member id directly instead of via the URL.
  embeddedMemberId?: string;
}

const ShareRequestNew = ({ embeddedMemberId }: ShareRequestNewProps = {}) => {
  const navigate = useNavigate();
  const [urlParams] = useSearchParams();
  const prefillMemberId = embeddedMemberId ?? urlParams.get('memberId');
  const prefillAttempted = useRef(false);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Validation state - tracks which required fields are missing
  const [validationErrors, setValidationErrors] = useState<{
    member?: boolean;
    requestType?: boolean;
  }>({});

  // Per-vendor request types (managed via vendor settings)
  const [requestTypes, setRequestTypes] = useState<VendorRequestType[]>([]);
  
  // Member search - two-step process
  const [memberSearch, setMemberSearch] = useState('');
  const [memberResults, setMemberResults] = useState<MemberSearchResult[]>([]);
  const [searchingMembers, setSearchingMembers] = useState(false);
  
  // Household selection
  const [selectedHousehold, setSelectedHousehold] = useState<MemberSearchResult | null>(null);
  const [householdMembers, setHouseholdMembers] = useState<MemberSearchResult[]>([]);
  const [loadingHousehold, setLoadingHousehold] = useState(false);
  
  // Final selected member for the share request
  const [selectedMember, setSelectedMember] = useState<MemberSearchResult | null>(null);
  
  // Form data
  const [formData, setFormData] = useState({
    requestName: '',
    requestDescription: '',
    requestTypeId: '',
    subType: '',
    status: 'New',
    determination: 'Pending',
    dateOfService: '',
    dateOfServiceEnd: '',
    nextSteps: '',
    generalNotes: '',
    eligibilityNotes: ''
  });

  // Diagnosis codes (ICD-10) - multiple
  interface DiagnosisEntry {
    id: string;
    code: string;
    description: string;
    isPrimary: boolean;
  }
  const [diagnoses, setDiagnoses] = useState<DiagnosisEntry[]>([]);
  const [newDiagnosis, setNewDiagnosis] = useState({ code: '', description: '' });

  // Procedure codes (CPT) - multiple
  interface ProcedureEntry {
    id: string;
    code: string;
    description: string;
  }
  const [procedures, setProcedures] = useState<ProcedureEntry[]>([]);
  const [newProcedure, setNewProcedure] = useState({ code: '', description: '' });

  // Status and Determination options — sourced from the canonical type lists
  // so adding/removing a status only requires editing shareRequest.types.ts.
  const STATUS_OPTIONS = SHARE_REQUEST_STATUSES;
  const DETERMINATION_OPTIONS = ['Pending', 'Not Eligible', 'Eligible'];

  // Validation patterns
  const ICD10_PATTERN = /^[A-Z]\d{2}\.?\d{0,4}[A-Z]?$/i;
  const CPT_PATTERN = /^\d{5}(-\d{2})?$/;

  // Add diagnosis
  const addDiagnosis = () => {
    if (!newDiagnosis.code.trim()) return;
    
    if (!ICD10_PATTERN.test(newDiagnosis.code.trim())) {
      alert('Invalid ICD-10 code format. Expected format: A00.0 or A000');
      return;
    }

    const isPrimary = diagnoses.length === 0; // First one is primary by default
    setDiagnoses([...diagnoses, {
      id: crypto.randomUUID(),
      code: newDiagnosis.code.toUpperCase().trim(),
      description: newDiagnosis.description.trim(),
      isPrimary
    }]);
    setNewDiagnosis({ code: '', description: '' });
  };

  // Remove diagnosis
  const removeDiagnosis = (id: string) => {
    const remaining = diagnoses.filter(d => d.id !== id);
    // If we removed the primary, make the first remaining one primary
    if (remaining.length > 0 && !remaining.some(d => d.isPrimary)) {
      remaining[0].isPrimary = true;
    }
    setDiagnoses(remaining);
  };

  // Set primary diagnosis
  const setPrimaryDiagnosis = (id: string) => {
    setDiagnoses(diagnoses.map(d => ({
      ...d,
      isPrimary: d.id === id
    })));
  };

  // Add procedure
  const addProcedure = () => {
    if (!newProcedure.code.trim()) return;
    
    if (!CPT_PATTERN.test(newProcedure.code.trim())) {
      alert('Invalid CPT code format. Expected format: 99213 or 99213-25');
      return;
    }

    setProcedures([...procedures, {
      id: crypto.randomUUID(),
      code: newProcedure.code.trim(),
      description: newProcedure.description.trim()
    }]);
    setNewProcedure({ code: '', description: '' });
  };

  // Remove procedure
  const removeProcedure = (id: string) => {
    setProcedures(procedures.filter(p => p.id !== id));
  };

  useEffect(() => {
    loadRequestTypes();
  }, []);

  // Pre-fill the member selection when navigated here with ?memberId=...
  // Mirrors the manual selectHousehold() flow so the two-step UX stays identical.
  useEffect(() => {
    if (!prefillMemberId || prefillAttempted.current) return;
    prefillAttempted.current = true;

    const controller = new AbortController();
    (async () => {
      try {
        const response = await apiService.get<{
          success: boolean;
          data: {
            MemberId: string;
            HouseholdId?: string;
            HouseholdMemberID?: string;
            FirstName: string;
            LastName: string;
            Email: string;
            RelationshipType?: string;
            DateOfBirth?: string;
          };
        }>(`/api/me/vendor/members/${prefillMemberId}`, { signal: controller.signal });

        if (controller.signal.aborted) return;
        if (!response.success || !response.data) return;

        const m = response.data;
        const seed: MemberSearchResult = {
          MemberId: m.MemberId,
          HouseholdId: m.HouseholdId,
          HouseholdMemberID: m.HouseholdMemberID,
          FirstName: m.FirstName,
          LastName: m.LastName,
          Email: m.Email,
          Relationship: m.RelationshipType,
          DateOfBirth: m.DateOfBirth,
        };
        await selectHousehold(seed);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('Error pre-filling member from URL:', err);
          // Silent fallback — user can still pick manually.
        }
      }
    })();

    return () => controller.abort();
  }, [prefillMemberId]);

  const loadRequestTypes = async () => {
    try {
      const types = await vendorRequestTypesService.list();
      setRequestTypes(types);
    } catch (err) {
      console.error('Error loading request types:', err);
    }
  };

  const searchMembers = async (query: string) => {
    if (query.length < 2) {
      setMemberResults([]);
      return;
    }

    try {
      setSearchingMembers(true);
      // Note: This endpoint would need to be created to search members for vendor
      // For now, we'll use a placeholder that shows how it would work
      const response = await apiService.get<{ success: boolean; data: MemberSearchResult[] }>(
        `/api/me/vendor/members/search?q=${encodeURIComponent(query)}`
      );
      if (response.success) {
        setMemberResults(response.data);
      }
    } catch (err: any) {
      console.error('Error searching members:', err);
      // If endpoint doesn't exist yet, show a helpful message
      if (err.message?.includes('404')) {
        setError('Member search is being set up. Please enter Member ID manually for now.');
      }
      setMemberResults([]);
    } finally {
      setSearchingMembers(false);
    }
  };

  const handleMemberSearch = (value: string) => {
    setMemberSearch(value);
    if (value.length >= 2) {
      const debounce = setTimeout(() => {
        searchMembers(value);
      }, 300);
      return () => clearTimeout(debounce);
    } else {
      setMemberResults([]);
    }
  };

  // Step 1: Select a household (from search results)
  const selectHousehold = async (member: MemberSearchResult) => {
    setMemberSearch('');
    setMemberResults([]);
    
    // Check if member has a valid HouseholdId (must be a non-empty GUID format)
    const hasValidHouseholdId = member.HouseholdId && 
      member.HouseholdId.length === 36 && 
      member.HouseholdId !== '00000000-0000-0000-0000-000000000000';
    
    if (hasValidHouseholdId) {
      setSelectedHousehold(member);
      setLoadingHousehold(true);
      try {
        const response = await apiService.get<{ success: boolean; data: MemberSearchResult[] }>(
          `/api/me/vendor/members/household/${member.HouseholdId}`
        );
        if (response.success && response.data && response.data.length > 0) {
          setHouseholdMembers(response.data);
          // If only one member in household, auto-select them
          if (response.data.length === 1) {
            setSelectedMember(response.data[0]);
          }
        } else {
          // No household members found, just select the member directly
          console.log('No household members found, selecting member directly');
          setSelectedMember(member);
          setSelectedHousehold(null);
        }
      } catch (err) {
        console.error('Error loading household members:', err);
        // Fallback: just use the searched member directly
        setSelectedMember(member);
        setSelectedHousehold(null);
        setHouseholdMembers([]);
      } finally {
        setLoadingHousehold(false);
      }
    } else {
      // No valid household, just select the member directly
      console.log('No valid HouseholdId, selecting member directly');
      setSelectedMember(member);
    }
  };

  // Step 2: Select specific household member for the share request
  const selectHouseholdMember = (member: MemberSearchResult) => {
    setSelectedMember(member);
  };

  // Reset selection to start over
  const resetSelection = () => {
    setSelectedHousehold(null);
    setSelectedMember(null);
    setHouseholdMembers([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Validate required fields
    const errors: typeof validationErrors = {};

    if (!selectedMember) {
      errors.member = true;
    }
    if (!formData.requestTypeId) {
      errors.requestType = true;
    }

    // If there are validation errors, set them and don't submit
    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      setError('Please fill in all required fields highlighted in red');
      return;
    }
    
    // Clear any previous validation errors
    setValidationErrors({});

    try {
      setSaving(true);
      setError(null);
      
      // Create the share request
      const response = await apiService.post<{ success: boolean; data: { shareRequestId: string; requestNumber: string } }>(
        '/api/me/vendor/share-requests',
        {
          memberId: selectedMember.MemberId,
          householdId: selectedMember.HouseholdId,
          requestName: formData.requestName || null,
          requestDescription: formData.requestDescription || null,
          requestTypeId: formData.requestTypeId,
          subType: formData.subType || null,
          status: formData.status,
          determination: formData.determination,
          dateOfService: formData.dateOfService,
          dateOfServiceEnd: formData.dateOfServiceEnd,
          nextSteps: formData.nextSteps,
          generalNotes: formData.generalNotes,
          eligibilityNotes: formData.eligibilityNotes
        }
      );

      if (response.success && response.data.shareRequestId) {
        const shareRequestId = response.data.shareRequestId;

        // Add diagnoses (ICD-10 codes)
        for (const diagnosis of diagnoses) {
          await apiService.post(`/api/me/vendor/share-requests/${shareRequestId}/diagnoses`, {
            icd10Code: diagnosis.code,
            description: diagnosis.description,
            isPrimary: diagnosis.isPrimary
          });
        }

        // Add procedures (CPT codes)
        for (const procedure of procedures) {
          await apiService.post(`/api/me/vendor/share-requests/${shareRequestId}/procedures`, {
            cptCode: procedure.code,
            description: procedure.description
          });
        }

        navigate(`/vendor/share-requests/${shareRequestId}`);
        return;
      }
      
      if (response.success) {
        navigate(`/vendor/share-requests/${response.data.shareRequestId}`);
      } else {
        setError('Failed to create share request');
      }
    } catch (err: any) {
      console.error('Error creating share request:', err);
      setError(err.message || 'Failed to create share request');
    } finally {
      setSaving(false);
    }
  };


  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center mb-6">
        <button
          onClick={() => navigate('/vendor/share-requests')}
          className="p-2 mr-4 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">New Share Request</h1>
          <p className="text-gray-600">Create a new share request for a member</p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="bg-white rounded-lg border border-gray-200">
          {/* Member Selection - Two Step Process */}
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Member</h2>
            
            {/* Final selected member display */}
            {selectedMember ? (
              <div className="bg-oe-light border border-oe-primary/30 rounded-lg p-4 flex items-center justify-between">
                <div className="flex items-center">
                  <div className="bg-white p-2 rounded-full mr-3 border border-oe-primary/30">
                    <User className="h-5 w-5 text-oe-primary" />
                  </div>
                  <div>
                    <div className="font-medium text-gray-900">
                      {selectedMember.FirstName} {selectedMember.LastName}
                      {selectedMember.HouseholdMemberID && (
                        <span className="ml-2 text-sm font-normal text-oe-primary">
                          ({selectedMember.HouseholdMemberID})
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-600">
                      {selectedMember.Relationship && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800 mr-2">
                          {selectedMember.Relationship}
                        </span>
                      )}
                      {selectedMember.Email}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={resetSelection}
                  className="text-oe-primary hover:text-oe-dark text-sm font-medium"
                >
                  Change
                </button>
              </div>
            ) : selectedHousehold ? (
              /* Step 2: Select household member */
              <div className="space-y-4">
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center justify-between">
                  <div className="text-sm">
                    <span className="text-gray-500">Household:</span>
                    <span className="ml-2 font-medium text-gray-900">
                      {selectedHousehold.FirstName} {selectedHousehold.LastName}
                    </span>
                    {selectedHousehold.HouseholdMemberID && (
                      <span className="ml-1 text-oe-primary">({selectedHousehold.HouseholdMemberID})</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={resetSelection}
                    className="text-gray-500 hover:text-gray-700 text-sm"
                  >
                    Change Household
                  </button>
                </div>
                
                {loadingHousehold ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="animate-spin h-6 w-6 border-2 border-oe-primary border-t-transparent rounded-full"></div>
                    <span className="ml-2 text-gray-600">Loading household members...</span>
                  </div>
                ) : householdMembers.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium text-gray-700 mb-2">Select the member for this share request:</p>
                    <div className="grid grid-cols-1 gap-2">
                      {householdMembers.map((member) => (
                        <button
                          key={member.MemberId}
                          type="button"
                          onClick={() => selectHouseholdMember(member)}
                          className="w-full px-4 py-3 text-left bg-white border border-gray-200 rounded-lg hover:border-oe-primary hover:bg-oe-light/50 transition-colors flex items-center"
                        >
                          <User className="h-5 w-5 text-gray-400 mr-3" />
                          <div className="flex-1">
                            <div className="flex items-center">
                              <span className="font-medium text-gray-900">
                                {member.FirstName} {member.LastName}
                              </span>
                              {member.HouseholdMemberID && (
                                <span className="ml-2 text-xs font-mono text-oe-primary bg-oe-light px-2 py-0.5 rounded">
                                  {member.HouseholdMemberID}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center text-sm text-gray-500 mt-0.5">
                              {member.Relationship && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700 mr-2">
                                  {member.Relationship}
                                </span>
                              )}
                              {member.DateOfBirth && (
                                <span className="text-gray-400">
                                  DOB: {new Date(member.DateOfBirth).toLocaleDateString()}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-4 text-gray-500">
                    No other household members found
                  </div>
                )}
              </div>
            ) : (
              /* Step 1: Search for household */
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by name, email, or Member ID..."
                  value={memberSearch}
                  onChange={(e) => handleMemberSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
                {searchingMembers && (
                  <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                    <div className="animate-spin h-5 w-5 border-2 border-oe-primary border-t-transparent rounded-full"></div>
                  </div>
                )}
                
                {/* Search Results */}
                {memberResults.length > 0 && (
                  <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                    {memberResults.map((member) => (
                      <button
                        key={member.MemberId}
                        type="button"
                        onClick={() => selectHousehold(member)}
                        className="w-full px-4 py-3 text-left hover:bg-gray-50 flex items-center border-b border-gray-100 last:border-0"
                      >
                        <User className="h-5 w-5 text-gray-400 mr-3" />
                        <div className="flex-1">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-gray-900">
                              {member.FirstName} {member.LastName}
                            </span>
                            {member.HouseholdMemberID && (
                              <span className="text-xs font-mono text-oe-primary bg-oe-light px-2 py-0.5 rounded">
                                {member.HouseholdMemberID}
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500">{member.Email}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Request Details */}
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Request Details</h2>
            
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Request Name</label>
                <input
                  type="text"
                  value={formData.requestName}
                  onChange={(e) => setFormData({ ...formData, requestName: e.target.value })}
                  placeholder="Enter a descriptive name for this request (e.g., 'Emergency Room Visit - John Doe')"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">A short, descriptive name to help identify this request</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Request Description</label>
                <textarea
                  value={formData.requestDescription}
                  onChange={(e) => setFormData({ ...formData, requestDescription: e.target.value })}
                  rows={3}
                  placeholder="Provide a detailed description of this share request..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
                <p className="text-xs text-gray-500 mt-1">Detailed description of the request, circumstances, or additional context</p>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left Column: Request Type + free-text Sub-type */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Request Type *</label>
                  <select
                    value={formData.requestTypeId}
                    onChange={(e) => setFormData({ ...formData, requestTypeId: e.target.value })}
                    className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-oe-primary ${
                      validationErrors.requestType ? 'border-red-500' : 'border-gray-300'
                    }`}
                    required
                  >
                    <option value="">
                      {requestTypes.length === 0 ? 'No types configured — add one in Settings' : 'Select type'}
                    </option>
                    {requestTypes.map((t) => (
                      <option key={t.TypeId} value={t.TypeId}>{t.Name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Sub-type</label>
                  <input
                    type="text"
                    value={formData.subType}
                    onChange={(e) => setFormData({ ...formData, subType: e.target.value })}
                    maxLength={500}
                    placeholder="e.g. inpatient knee replacement"
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  />
                  <p className="text-xs text-gray-500 mt-1">Free-text description of the specific surgery, procedure, or treatment</p>
                </div>
              </div>

              {/* Right Column: Status, Determination */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Status *</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    required
                  >
                    {STATUS_OPTIONS.map(status => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Determination *</label>
                  <select
                    value={formData.determination}
                    onChange={(e) => setFormData({ ...formData, determination: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    required
                  >
                    {DETERMINATION_OPTIONS.map(det => (
                      <option key={det} value={det}>{det}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Service Date */}
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Service Date</h2>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date of Service</label>
                <input
                  type="date"
                  value={formData.dateOfService}
                  onChange={(e) => setFormData({ ...formData, dateOfService: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Service End Date</label>
                <input
                  type="date"
                  value={formData.dateOfServiceEnd}
                  onChange={(e) => setFormData({ ...formData, dateOfServiceEnd: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
              </div>
            </div>
          </div>

          {/* Diagnosis Codes (ICD-10) */}
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Diagnosis Codes (ICD-10)</h2>
            <p className="text-sm text-gray-500 mb-4">Add one or more ICD-10 diagnosis codes. First code is marked as primary.</p>
            
            {/* Existing diagnoses */}
            {diagnoses.length > 0 && (
              <div className="space-y-2 mb-4">
                {diagnoses.map((diagnosis) => (
                  <div key={diagnosis.id} className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                    <button
                      type="button"
                      onClick={() => setPrimaryDiagnosis(diagnosis.id)}
                      className={`p-1 rounded ${diagnosis.isPrimary ? 'text-yellow-500' : 'text-gray-300 hover:text-yellow-400'}`}
                      title={diagnosis.isPrimary ? 'Primary diagnosis' : 'Set as primary'}
                    >
                      <Star className="h-4 w-4" fill={diagnosis.isPrimary ? 'currentColor' : 'none'} />
                    </button>
                    <span className="font-mono text-sm font-medium text-oe-primary bg-oe-light px-2 py-1 rounded">
                      {diagnosis.code}
                    </span>
                    <span className="flex-1 text-sm text-gray-700">{diagnosis.description || '(no description)'}</span>
                    {diagnosis.isPrimary && (
                      <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded">Primary</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeDiagnosis(diagnosis.id)}
                      className="p-1 text-gray-400 hover:text-red-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new diagnosis */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newDiagnosis.code}
                onChange={(e) => setNewDiagnosis({ ...newDiagnosis, code: e.target.value.toUpperCase() })}
                placeholder="ICD-10 Code (e.g., M54.5)"
                className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm font-mono"
              />
              <input
                type="text"
                value={newDiagnosis.description}
                onChange={(e) => setNewDiagnosis({ ...newDiagnosis, description: e.target.value })}
                placeholder="Description (optional)"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm"
                onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addDiagnosis())}
              />
              <button
                type="button"
                onClick={addDiagnosis}
                disabled={!newDiagnosis.code.trim()}
                className="px-3 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add
              </button>
            </div>
          </div>

          {/* Procedure Codes (CPT) */}
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Procedure Codes (CPT)</h2>
            <p className="text-sm text-gray-500 mb-4">Add one or more CPT procedure codes (optional).</p>
            
            {/* Existing procedures */}
            {procedures.length > 0 && (
              <div className="space-y-2 mb-4">
                {procedures.map((procedure) => (
                  <div key={procedure.id} className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                    <span className="font-mono text-sm font-medium text-oe-primary bg-oe-light px-2 py-1 rounded">
                      {procedure.code}
                    </span>
                    <span className="flex-1 text-sm text-gray-700">{procedure.description || '(no description)'}</span>
                    <button
                      type="button"
                      onClick={() => removeProcedure(procedure.id)}
                      className="p-1 text-gray-400 hover:text-red-500"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add new procedure */}
            <div className="flex gap-2">
              <input
                type="text"
                value={newProcedure.code}
                onChange={(e) => setNewProcedure({ ...newProcedure, code: e.target.value })}
                placeholder="CPT Code (e.g., 99213)"
                className="w-32 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm font-mono"
              />
              <input
                type="text"
                value={newProcedure.description}
                onChange={(e) => setNewProcedure({ ...newProcedure, description: e.target.value })}
                placeholder="Description (optional)"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary text-sm"
                onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addProcedure())}
              />
              <button
                type="button"
                onClick={addProcedure}
                disabled={!newProcedure.code.trim()}
                className="px-3 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add
              </button>
            </div>
          </div>

          {/* Notes */}
          <div className="p-6 border-b border-gray-200">
            <h2 className="text-lg font-medium text-gray-900 mb-4">Notes</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Next Steps</label>
                <textarea
                  value={formData.nextSteps}
                  onChange={(e) => setFormData({ ...formData, nextSteps: e.target.value })}
                  rows={3}
                  placeholder="What are the next steps for this request..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">General Notes</label>
                <textarea
                  value={formData.generalNotes}
                  onChange={(e) => setFormData({ ...formData, generalNotes: e.target.value })}
                  rows={3}
                  placeholder="General notes about this request..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Eligibility Notes</label>
                <textarea
                  value={formData.eligibilityNotes}
                  onChange={(e) => setFormData({ ...formData, eligibilityNotes: e.target.value })}
                  rows={3}
                  placeholder="Notes about eligibility determination..."
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="p-6 bg-gray-50 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => navigate('/vendor/share-requests')}
              className="px-6 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !selectedMember}
              className="btn-primary flex items-center disabled:opacity-50"
            >
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Creating...' : 'Create Request'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};

export default ShareRequestNew;

