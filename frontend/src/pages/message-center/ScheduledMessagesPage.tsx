// File: ScheduledMessagesPage.tsx
// Path: frontend/src/pages/message-center/ScheduledMessagesPage.tsx

import React, { useState, useEffect } from 'react';
import { Calendar, Clock, Play, Pause, Edit, Trash2, Plus, Search, Mail, MessageSquare, ChevronRight, Building2, ChevronDown } from 'lucide-react';
import { scheduledMessageService, messageTemplateService, type ScheduledMessage, type MessageTemplate } from '../../services/messageCenter.service';
import { useAuth } from '../../hooks/useAuth';
import { useTenants } from '../../hooks/useTenants';

// Using types from service

const ScheduledMessagesPage: React.FC = () => {
  const [schedules, setSchedules] = useState<ScheduledMessage[]>([]);
  const [filteredSchedules, setFilteredSchedules] = useState<ScheduledMessage[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedSchedule, setSelectedSchedule] = useState<ScheduledMessage | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState<'All' | 'Active' | 'Inactive'>('All');
  const [filterType, setFilterType] = useState<'All' | 'Email' | 'SMS'>('All');
  const { user } = useAuth();
  const activeTenantId = user?.currentTenantId || user?.tenantId || '';
  const currentRole = user?.currentRole || localStorage.getItem('currentRole');
  const isSysAdmin = currentRole === 'SysAdmin';
  const { data: tenants = [] } = useTenants(isSysAdmin);
  const [showTenantDropdown, setShowTenantDropdown] = useState(false);
  const [tenantSearchQuery, setTenantSearchQuery] = useState('');
  
  const [formData, setFormData] = useState({
    scheduleName: '',
    templateId: '',
    messageType: 'Email' as 'Email' | 'SMS',
    recurrencePattern: 'Daily' as 'Daily' | 'Weekly' | 'Monthly' | 'FirstOfMonth' | 'Annual',
    recurrenceTime: '10:00',
    isActive: true,
    tenantId: '' as string,
    tenantName: '' as string
  });

  const loadData = async () => {
    try {
      const [schedulesRes, templatesRes] = await Promise.all([
        scheduledMessageService.getSchedules({ page: 1, limit: 100 }),
        messageTemplateService.getTemplates({ page: 1, limit: 100 })
      ]);
      if (schedulesRes.success) {
        setSchedules(schedulesRes.data.data as any);
        setFilteredSchedules(schedulesRes.data.data as any);
      }
      if (templatesRes.success) {
        setTemplates(templatesRes.data.data as any);
      }
    } catch (e) {
      console.error('Failed to load scheduled messages:', e);
      setSchedules([]);
      setFilteredSchedules([]);
    }
  };

  useEffect(() => {
    loadData();
  }, [activeTenantId]);

  // Filter schedules
  useEffect(() => {
    let filtered = schedules;
    
    if (searchTerm) {
      filtered = filtered.filter(schedule => 
        schedule.scheduleName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        ((schedule as any).templateName || '').toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    if (filterStatus !== 'All') {
      filtered = filtered.filter(schedule => 
        filterStatus === 'Active' ? schedule.isActive : !schedule.isActive
      );
    }
    
    if (filterType !== 'All') {
      filtered = filtered.filter(schedule => schedule.messageType === filterType);
    }
    
    setFilteredSchedules(filtered);
  }, [schedules, searchTerm, filterStatus, filterType]);

  const handleCreate = async () => {
    try {
      const normalizeTime = (t: string) => (t && t.split(':').length === 2) ? `${t}:00` : (t || '10:00:00');
      const finalTime = normalizeTime(formData.recurrenceTime);
      const finalTenantId = isSysAdmin ? (formData.tenantName === 'All Tenants' || formData.tenantId === '' ? undefined as any : formData.tenantId) : (activeTenantId || undefined as any);
      await scheduledMessageService.createSchedule({
        scheduleName: formData.scheduleName,
        templateId: formData.templateId || undefined as any,
        messageType: formData.messageType,
        recurrencePattern: formData.recurrencePattern as any,
        recurrenceTime: finalTime,
        isActive: formData.isActive,
        tenantId: finalTenantId,
        createdBy: '' as any,
        createdDate: '' as any,
      } as any);
      setIsCreateModalOpen(false);
      resetForm();
      await loadData();
    } catch (e) {
      console.error('Failed to create schedule', e);
      alert('Failed to create schedule');
    }
  };

  const handleEdit = async () => {
    if (!selectedSchedule) return;
    try {
      const normalizeTime = (t: string) => (t && t.split(':').length === 2) ? `${t}:00` : (t || '10:00:00');
      const finalTime = normalizeTime(formData.recurrenceTime);
      const finalTenantId = isSysAdmin ? (formData.tenantName === 'All Tenants' || formData.tenantId === '' ? undefined as any : formData.tenantId) : undefined;
      await scheduledMessageService.updateSchedule(selectedSchedule.scheduleId, {
        scheduleName: formData.scheduleName,
        templateId: formData.templateId || undefined as any,
        messageType: formData.messageType,
        recurrencePattern: formData.recurrencePattern as any,
        recurrenceTime: finalTime,
        isActive: formData.isActive,
        tenantId: finalTenantId
      } as any);
      setIsEditModalOpen(false);
      resetForm();
      await loadData();
    } catch (e) {
      console.error('Failed to update schedule', e);
      alert('Failed to update schedule');
    }
  };

  const handleDelete = async (scheduleId: string) => {
    if (!window.confirm('Delete this scheduled message?')) return;
    try {
      await scheduledMessageService.deleteSchedule(scheduleId);
      await loadData();
    } catch (e) {
      console.error('Failed to delete schedule', e);
      alert('Failed to delete schedule');
    }
  };

  const handleToggleActive = async (scheduleId: string) => {
    const current = schedules.find(s => s.scheduleId === scheduleId);
    if (!current) return;
    try {
      await scheduledMessageService.updateSchedule(scheduleId, { isActive: !current.isActive } as any);
      await loadData();
    } catch (e) {
      console.error('Failed to toggle active', e);
    }
  };

  const handleRunNow = async (scheduleId: string) => {
    try {
      await scheduledMessageService.runSchedule(scheduleId);
      alert('Run queued');
    } catch (e) {
      console.error('Run now failed', e);
      alert('Run now failed');
    }
  };

  // No recipient count until requirements are defined

  const resetForm = () => {
    setFormData({
      scheduleName: '',
      templateId: '',
      messageType: 'Email',
      recurrencePattern: 'Daily',
      recurrenceTime: '10:00',
      isActive: true,
      tenantId: '',
      tenantName: ''
    });
    setSelectedSchedule(null);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Scheduled Messages</h1>
        <p className="text-gray-600 mt-1">Automate your email and SMS campaigns</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Total Schedules</p>
              <p className="text-2xl font-semibold">{schedules.length}</p>
            </div>
            <Calendar className="h-8 w-8 text-gray-400" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Active</p>
              <p className="text-2xl font-semibold">{schedules.filter(s => s.isActive).length}</p>
            </div>
            <Play className="h-8 w-8 text-green-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">Email Campaigns</p>
              <p className="text-2xl font-semibold">{schedules.filter(s => s.messageType === 'Email').length}</p>
            </div>
            <Mail className="h-8 w-8 text-blue-500" />
          </div>
        </div>
        <div className="bg-white p-4 rounded-lg shadow">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">SMS Campaigns</p>
              <p className="text-2xl font-semibold">{schedules.filter(s => s.messageType === 'SMS').length}</p>
            </div>
            <MessageSquare className="h-8 w-8 text-green-500" />
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-4 mb-6">
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex-1 min-w-64">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input
                type="text"
                placeholder="Search schedules..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
              />
            </div>
          </div>
          
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
          >
            <option value="All">All Status</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>
          
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as any)}
            className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
          >
            <option value="All">All Types</option>
            <option value="Email">Email</option>
            <option value="SMS">SMS</option>
          </select>
          
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            Create Schedule
          </button>
        </div>
      </div>

      {/* Schedules Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Schedule
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Template
              </th>
              
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Pattern
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Next Run
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {filteredSchedules.map((schedule) => (
              <tr key={schedule.scheduleId} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    {schedule.messageType === 'Email' ? (
                      <Mail className="h-5 w-5 text-blue-500 mr-3" />
                    ) : (
                      <MessageSquare className="h-5 w-5 text-green-500 mr-3" />
                    )}
                    <div>
                      <div className="text-sm font-medium text-gray-900">
                        {schedule.scheduleName}
                      </div>
                      <div className="text-sm text-gray-500">
                        Created {new Date(schedule.createdDate).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="text-sm text-gray-900">{(schedule as any).templateName || '-'}</div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center text-sm">
                    <Clock className="h-4 w-4 text-gray-400 mr-1" />
                    <span className="text-gray-900">
                      {schedule.recurrencePattern}
                      {schedule.recurrenceTime && ` at ${schedule.recurrenceTime}`}
                    </span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                  {(() => {
                    const nrd = (schedule as any).nextRunDate as any;
                    if (nrd) return formatDate(nrd);
                    // Client-side fallback compute
                    try {
                      const time = schedule.recurrenceTime || '10:00:00';
                      const [hh, mm, ss] = time.split(':').map((x: string) => parseInt(x, 10));
                      const now = new Date();
                      let candidate = new Date();
                      candidate.setHours(hh || 0, mm || 0, (ss || 0), 0);
                      const addDays = (d: number) => { candidate = new Date(candidate.getTime() + d*24*60*60*1000); };
                      switch (schedule.recurrencePattern) {
                        case 'Daily':
                          if (candidate <= now) addDays(1);
                          break;
                        case 'Weekly':
                          while (candidate <= now) addDays(7);
                          break;
                        case 'Monthly': {
                          const next = new Date(now);
                          next.setHours(hh || 0, mm || 0, (ss || 0), 0);
                          if (next <= now) next.setMonth(next.getMonth() + 1);
                          candidate = next; break; }
                        case 'FirstOfMonth': {
                          const y = now.getFullYear(); const m = now.getMonth();
                          const first = new Date(y, m, 1, hh || 0, mm || 0, (ss || 0), 0);
                          candidate = first > now ? first : new Date(y, m+1, 1, hh || 0, mm || 0, (ss || 0), 0);
                          break; }
                        case 'Annual': {
                          const next = new Date(now);
                          next.setHours(hh || 0, mm || 0, (ss || 0), 0);
                          if (next <= now) next.setFullYear(next.getFullYear() + 1);
                          candidate = next; break; }
                        default:
                          return '—';
                      }
                      return formatDate(candidate.toISOString());
                    } catch { return '—'; }
                  })()}
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    schedule.isActive 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    {schedule.isActive ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleToggleActive(schedule.scheduleId)}
                      className="text-gray-600 hover:text-gray-900"
                      title={schedule.isActive ? 'Pause' : 'Activate'}
                    >
                      {schedule.isActive ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </button>
                    <button
                      onClick={() => handleRunNow(schedule.scheduleId)}
                      className="text-oe-primary hover:text-blue-900"
                      title="Run Now"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => {
                        setSelectedSchedule(schedule);
                        setFormData({
                          scheduleName: schedule.scheduleName,
                          templateId: schedule.templateId || '',
                          messageType: schedule.messageType as any,
                          recurrencePattern: schedule.recurrencePattern as any,
                          recurrenceTime: schedule.recurrenceTime || '10:00',
                          isActive: schedule.isActive,
                          tenantId: (schedule as any).tenantId || '',
                          tenantName: tenants.find(t => t.TenantId === (schedule as any).tenantId)?.Name || ((schedule as any).tenantId ? '' : 'All Tenants')
                        });
                        setIsEditModalOpen(true);
                      }}
                      className="text-gray-600 hover:text-gray-900"
                    >
                      <Edit className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(schedule.scheduleId)}
                      className="text-red-600 hover:text-red-900"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create/Edit Modal */}
      {(isCreateModalOpen || isEditModalOpen) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-xl font-semibold">
                {isCreateModalOpen ? 'Create Scheduled Message' : 'Edit Scheduled Message'}
              </h2>
            </div>
            
            <div className="p-6 space-y-4">
              {isSysAdmin && (
                <div className="mb-2 relative">
                  <label className="block text-sm font-medium text-gray-700 mb-2">Tenant</label>
                  <div className="relative">
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={tenantSearchQuery}
                      onChange={(e) => { setTenantSearchQuery(e.target.value); setShowTenantDropdown(true); }}
                      onFocus={() => setShowTenantDropdown(true)}
                      placeholder="Search and select tenant (or choose All Tenants)"
                      className="w-full pl-9 pr-10 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                    />
                    <button
                      type="button"
                      onClick={() => { setShowTenantDropdown(!showTenantDropdown); if (!showTenantDropdown) setTenantSearchQuery(''); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                    >
                      <ChevronDown className={`h-4 w-4 transition-transform ${showTenantDropdown ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                  {showTenantDropdown && (
                    <div className="absolute left-0 right-0 z-20 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-60 overflow-auto">
                      <button
                        type="button"
                        onClick={() => { setFormData(prev => ({ ...prev, tenantId: '', tenantName: 'All Tenants' })); setTenantSearchQuery('All Tenants'); setShowTenantDropdown(false); }}
                        className="w-full text-left px-3 py-2 hover:bg-blue-50 flex items-center justify-between border-b border-gray-200"
                      >
                        <div>
                          <div className="font-medium text-blue-800">All Tenants</div>
                          <div className="text-xs text-oe-primary">Global schedule (visible to all)</div>
                        </div>
                        {formData.tenantId === '' && formData.tenantName === 'All Tenants' && (
                          <span className="text-oe-primary font-medium">✓</span>
                        )}
                      </button>
                      {tenants
                        .filter(t => t.Name.toLowerCase().includes(tenantSearchQuery.toLowerCase()))
                        .map(t => (
                          <button
                            key={t.TenantId}
                            type="button"
                            onClick={() => { setFormData(prev => ({ ...prev, tenantId: t.TenantId, tenantName: t.Name })); setTenantSearchQuery(t.Name); setShowTenantDropdown(false); }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-100 flex items-center justify-between border-b border-gray-100 last:border-b-0"
                          >
                            <div>
                              <div className="font-medium text-gray-900">{t.Name}</div>
                              <div className="text-xs text-gray-500">ID: {t.TenantId.slice(-8)}</div>
                            </div>
                            {t.TenantId === formData.tenantId && (
                              <span className="text-oe-primary font-medium">✓</span>
                            )}
                          </button>
                        ))}
                    </div>
                  )}
                  {formData.tenantName && (
                    <div className="mt-2 text-sm text-green-600">Selected: {formData.tenantName}</div>
                  )}
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Schedule Name
                </label>
                <input
                  type="text"
                  value={formData.scheduleName}
                  onChange={(e) => setFormData({ ...formData, scheduleName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  placeholder="e.g., Weekly Welcome Emails"
                />
              </div>
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Message Type
                  </label>
                  <select
                    value={formData.messageType}
                    onChange={(e) => {
                      setFormData({ 
                        ...formData, 
                        messageType: e.target.value as any,
                        templateId: '' 
                      });
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value="Email">Email</option>
                    <option value="SMS">SMS</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Template
                  </label>
                  <select
                    value={formData.templateId}
                    onChange={(e) => setFormData({ ...formData, templateId: e.target.value })}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value="">Select template</option>
                    {templates
                      .filter((t: any) => t.messageType === formData.messageType)
                      .map((template: any) => (
                        <option key={template.templateId} value={template.templateId}>
                          {template.templateName}
                        </option>
                      ))
                    }
                  </select>
                </div>
              </div>
              
              {/* Recipient selection intentionally omitted per current schema */}
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Schedule Pattern
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <select
                    value={formData.recurrencePattern}
                    onChange={(e) => setFormData({ ...formData, recurrencePattern: e.target.value as any })}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  >
                    <option value="Daily">Daily</option>
                    <option value="Weekly">Weekly</option>
                    <option value="Monthly">Monthly</option>
                    <option value="FirstOfMonth">First Of Month</option>
                    <option value="Annual">Annual</option>
                  </select>
                  
                  <input
                    type="time"
                    value={formData.recurrenceTime}
                    onChange={(e) => setFormData({ ...formData, recurrenceTime: e.target.value })}
                    className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary"
                  />
                  
                  {/* No one-time date in current schema */}
                </div>
              </div>
              
              <div>
                <label className="flex items-center">
                  <input
                    type="checkbox"
                    checked={formData.isActive}
                    onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                    className="h-4 w-4 text-oe-primary rounded focus:ring-2 focus:ring-oe-primary mr-2"
                  />
                  <span className="text-sm font-medium text-gray-700">Active</span>
                </label>
              </div>
              
              <div className="flex justify-end gap-3 pt-4">
                <button
                  onClick={() => {
                    isCreateModalOpen ? setIsCreateModalOpen(false) : setIsEditModalOpen(false);
                    resetForm();
                  }}
                  className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={isCreateModalOpen ? handleCreate : handleEdit}
                  className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark"
                >
                  {isCreateModalOpen ? 'Create Schedule' : 'Save Changes'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScheduledMessagesPage;