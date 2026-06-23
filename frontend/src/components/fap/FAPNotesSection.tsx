// components/fap/FAPNotesSection.tsx
// FAP Notes Management Component

import { useEffect, useState } from 'react';
import { Plus, MessageSquare, Phone, Mail, FileText, Calendar, X } from 'lucide-react';
import { apiService } from '../../services/api.service';
import { FAPNote, FAP_CONTACT_METHODS } from '../../types/fap.types';

interface FAPNotesSectionProps {
  providerId: string;
}

const FAPNotesSection: React.FC<FAPNotesSectionProps> = ({ providerId }) => {
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<FAPNote[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [noteForm, setNoteForm] = useState({
    note: '',
    noteType: 'Note' as 'Note' | 'Communication' | 'SystemActivity',
    contactMethod: '',
    personContacted: '',
    nextFollowUpDate: '',
    isInternal: true
  });

  useEffect(() => {
    loadNotes();
  }, [providerId]);

  const loadNotes = async () => {
    try {
      setLoading(true);
      const response = await apiService.get<{ success: boolean; data: any[] }>(
        `/api/me/vendor/providers/${providerId}/fap/notes`
      );
      if (response.success) {
        // Normalize field names - handle both PascalCase (from DB) and camelCase
        const normalizedNotes: FAPNote[] = response.data.map((note: any) => ({
          noteId: note.noteId || note.NoteId,
          providerId: note.providerId || note.ProviderId,
          submissionId: note.submissionId || note.SubmissionId,
          vendorId: note.vendorId || note.VendorId,
          noteType: note.noteType || note.NoteType,
          contactMethod: note.contactMethod || note.ContactMethod,
          personContacted: note.personContacted || note.PersonContacted,
          note: note.note || note.Note,
          nextFollowUpDate: note.nextFollowUpDate || note.NextFollowUpDate,
          isInternal: note.isInternal !== undefined ? note.isInternal : (note.IsInternal !== undefined ? note.IsInternal : false),
          createdDate: note.createdDate || note.CreatedDate,
          createdBy: note.createdBy || note.CreatedBy,
          createdByName: note.createdByName || note.CreatedByName,
          createdByFirstName: note.createdByFirstName || note.CreatedByFirstName,
          createdByLastName: note.createdByLastName || note.CreatedByLastName,
        }));
        setNotes(normalizedNotes);
      }
    } catch (err: any) {
      console.error('Error loading FAP notes:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNote = async () => {
    if (!noteForm.note.trim()) {
      alert('Note is required');
      return;
    }

    try {
      const response = await apiService.post<{ success: boolean; data: FAPNote }>(
        `/api/me/vendor/providers/${providerId}/fap/notes`,
        noteForm
      );
      if (response.success) {
        await loadNotes();
        setShowCreateModal(false);
        setNoteForm({
          note: '',
          noteType: 'Note',
          contactMethod: '',
          personContacted: '',
          nextFollowUpDate: '',
          isInternal: true
        });
      }
    } catch (err: any) {
      console.error('Error creating note:', err);
      alert(err.message || 'Failed to create note');
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return null;
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  };

  const getContactIcon = (method?: string) => {
    switch (method) {
      case 'Phone':
        return <Phone className="h-4 w-4" />;
      case 'Email':
        return <Mail className="h-4 w-4" />;
      case 'Fax':
        return <FileText className="h-4 w-4" />;
      default:
        return <MessageSquare className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">FAP Notes & Communications</h4>
          <p className="text-xs text-gray-500 mt-1">
            Track communications, notes, and interactions with this provider
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-oe-primary hover:text-oe-dark hover:bg-oe-light rounded-lg transition-colors"
        >
          <Plus className="h-4 w-4" />
          Add Note
        </button>
      </div>

      {/* Notes Timeline */}
      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 bg-gray-200 rounded"></div>
          <div className="h-24 bg-gray-200 rounded"></div>
        </div>
      ) : notes.length === 0 ? (
        <div className="bg-gray-50 rounded-lg p-8 text-center border border-gray-200">
          <MessageSquare className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500 text-sm font-medium">No notes yet</p>
          <p className="text-gray-400 text-xs mt-1">Add your first note or communication</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-oe-primary bg-oe-light hover:bg-oe-primary-light rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Note
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {notes.map((note, index) => (
            <div
              key={note.noteId || `note-${index}`}
              className="bg-white rounded-lg border border-gray-200 p-4"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-oe-primary-light rounded-lg">
                  {getContactIcon(note.contactMethod)}
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">
                        {note.createdByName || `${note.createdByFirstName} ${note.createdByLastName}` || 'Unknown User'}
                      </span>
                      {note.noteType === 'Communication' && note.contactMethod && (
                        <span className="text-xs text-gray-500 flex items-center gap-1">
                          {getContactIcon(note.contactMethod)}
                          {note.contactMethod}
                        </span>
                      )}
                      {note.personContacted && (
                        <span className="text-xs text-gray-500">
                          with {note.personContacted}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {note.isInternal && (
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">
                          Internal
                        </span>
                      )}
                      <span className="text-xs text-gray-500">
                        {formatDate(note.createdDate)}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-900 whitespace-pre-wrap">{note.note}</p>
                  {note.nextFollowUpDate && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-yellow-600">
                      <Calendar className="h-3 w-3" />
                      <span>Follow up: {formatDate(note.nextFollowUpDate)}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Note Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg w-full max-w-2xl">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">Add Note</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Note Type
                </label>
                <select
                  value={noteForm.noteType}
                  onChange={(e) => setNoteForm(prev => ({ ...prev, noteType: e.target.value as any }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                >
                  <option value="Note">Note</option>
                  <option value="Communication">Communication</option>
                  <option value="SystemActivity">System Activity</option>
                </select>
              </div>
              {noteForm.noteType === 'Communication' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Contact Method
                    </label>
                    <select
                      value={noteForm.contactMethod}
                      onChange={(e) => setNoteForm(prev => ({ ...prev, contactMethod: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                    >
                      <option value="">Select method</option>
                      {FAP_CONTACT_METHODS.map(method => (
                        <option key={method} value={method}>{method}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Person Contacted
                    </label>
                    <input
                      type="text"
                      value={noteForm.personContacted}
                      onChange={(e) => setNoteForm(prev => ({ ...prev, personContacted: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      placeholder="Name of person contacted"
                    />
                  </div>
                </>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Note *
                </label>
                <textarea
                  value={noteForm.note}
                  onChange={(e) => setNoteForm(prev => ({ ...prev, note: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  rows={6}
                  placeholder="Enter your note..."
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Next Follow-up Date (optional)
                </label>
                <input
                  type="datetime-local"
                  value={noteForm.nextFollowUpDate}
                  onChange={(e) => setNoteForm(prev => ({ ...prev, nextFollowUpDate: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="isInternal"
                  checked={noteForm.isInternal}
                  onChange={(e) => setNoteForm(prev => ({ ...prev, isInternal: e.target.checked }))}
                  className="h-4 w-4 text-oe-primary rounded border-gray-300 focus:ring-oe-primary"
                />
                <label htmlFor="isInternal" className="ml-2 text-sm text-gray-700">
                  Internal note (not visible to members)
                </label>
              </div>
            </div>
            <div className="p-6 border-t border-gray-200 flex justify-end gap-3">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateNote}
                className="btn-primary"
              >
                Save Note
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FAPNotesSection;

