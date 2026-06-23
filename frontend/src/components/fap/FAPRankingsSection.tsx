// components/fap/FAPRankingsSection.tsx
// Provider Rankings Component with 5-star rating system

import { useEffect, useState } from 'react';
import { Star, Plus, Edit2, Trash2, TrendingUp, MessageCircle, Handshake, X, Save } from 'lucide-react';
import { apiService } from '../../services/api.service';
import { ProviderRanking } from '../../types/fap.types';

interface FAPRankingsSectionProps {
  providerId: string;
}

interface ShareRequestOption {
  shareRequestId: string;
  requestNumber: string;
  requestName?: string;
  status: string;
  submittedDate: string;
  dateOfService?: string;
}

const FAPRankingsSection: React.FC<FAPRankingsSectionProps> = ({ providerId }) => {
  const [loading, setLoading] = useState(true);
  const [rankings, setRankings] = useState<ProviderRanking[]>([]);
  const [shareRequests, setShareRequests] = useState<ShareRequestOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formData, setFormData] = useState({
    shareRequestId: '',
    fairPricingRating: 0,
    communicationRating: 0,
    negotiationRating: 0,
    fairPricingNotes: '',
    communicationNotes: '',
    negotiationNotes: ''
  });

  useEffect(() => {
    loadData();
  }, [providerId]);

  const loadData = async () => {
    try {
      setLoading(true);
      await Promise.all([
        loadRankings(),
        loadShareRequests()
      ]);
    } finally {
      setLoading(false);
    }
  };

  const loadRankings = async () => {
    try {
      const response = await apiService.get<{ success: boolean; data: ProviderRanking[] }>(
        `/api/me/vendor/providers/${providerId}/fap/rankings`
      );
      if (response.success) {
        setRankings(response.data || []);
      }
    } catch (err: any) {
      console.error('Error loading rankings:', err);
    }
  };

  const loadShareRequests = async () => {
    try {
      const response = await apiService.get<{ success: boolean; data: ShareRequestOption[] }>(
        `/api/me/vendor/providers/${providerId}/fap/share-requests`
      );
      if (response.success) {
        setShareRequests(response.data || []);
      }
    } catch (err: any) {
      console.error('Error loading share requests:', err);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      
      // Validate ShareRequest is selected
      if (!formData.shareRequestId) {
        alert('Please select a Share Request');
        return;
      }

      // Validate at least one rating is provided
      if (formData.fairPricingRating === 0 && formData.communicationRating === 0 && formData.negotiationRating === 0) {
        alert('Please provide at least one rating');
        return;
      }

      const payload = {
        shareRequestId: formData.shareRequestId,
        fairPricingRating: formData.fairPricingRating > 0 ? formData.fairPricingRating : undefined,
        communicationRating: formData.communicationRating > 0 ? formData.communicationRating : undefined,
        negotiationRating: formData.negotiationRating > 0 ? formData.negotiationRating : undefined,
        fairPricingNotes: formData.fairPricingNotes || undefined,
        communicationNotes: formData.communicationNotes || undefined,
        negotiationNotes: formData.negotiationNotes || undefined
      };

      if (editingId) {
        // Update existing
        await apiService.put(
          `/api/me/vendor/providers/${providerId}/fap/rankings/${editingId}`,
          payload
        );
      } else {
        // Create new
        await apiService.post(
          `/api/me/vendor/providers/${providerId}/fap/rankings`,
          payload
        );
      }

      await loadRankings();
      resetForm();
    } catch (err: any) {
      console.error('Error saving ranking:', err);
      alert(err.message || 'Failed to save ranking');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (ranking: ProviderRanking) => {
    setFormData({
      shareRequestId: ranking.shareRequestId || '',
      fairPricingRating: ranking.fairPricingRating || 0,
      communicationRating: ranking.communicationRating || 0,
      negotiationRating: ranking.negotiationRating || 0,
      fairPricingNotes: ranking.fairPricingNotes || '',
      communicationNotes: ranking.communicationNotes || '',
      negotiationNotes: ranking.negotiationNotes || ''
    });
    setEditingId(ranking.rankingId || null);
    setShowAddForm(true);
  };

  const handleDelete = async (rankingId: string) => {
    if (!confirm('Are you sure you want to delete this ranking?')) return;

    try {
      await apiService.delete(
        `/api/me/vendor/providers/${providerId}/fap/rankings/${rankingId}`
      );
      await loadRankings();
    } catch (err: any) {
      console.error('Error deleting ranking:', err);
      alert(err.message || 'Failed to delete ranking');
    }
  };

  const resetForm = () => {
    setFormData({
      shareRequestId: '',
      fairPricingRating: 0,
      communicationRating: 0,
      negotiationRating: 0,
      fairPricingNotes: '',
      communicationNotes: '',
      negotiationNotes: ''
    });
    setEditingId(null);
    setShowAddForm(false);
  };

  const StarRating: React.FC<{
    rating: number;
    onRatingChange: (rating: number) => void;
    disabled?: boolean;
  }> = ({ rating, onRatingChange, disabled = false }) => {
    return (
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((star) => (
          <button
            key={star}
            type="button"
            onClick={() => !disabled && onRatingChange(star)}
            disabled={disabled}
            className={`transition-colors ${
              disabled ? 'cursor-default' : 'cursor-pointer hover:scale-110'
            }`}
          >
            <Star
              className={`h-6 w-6 ${
                star <= rating
                  ? 'fill-oe-primary text-oe-primary'
                  : 'fill-gray-200 text-gray-200'
              }`}
            />
          </button>
        ))}
        {!disabled && (
          <button
            type="button"
            onClick={() => onRatingChange(0)}
            className="ml-2 text-xs text-gray-500 hover:text-gray-700"
          >
            Clear
          </button>
        )}
      </div>
    );
  };

  const calculateAverage = (rating: ProviderRanking) => {
    const ratings = [
      rating.fairPricingRating,
      rating.communicationRating,
      rating.negotiationRating
    ].filter(r => r && r > 0);
    
    if (ratings.length === 0) return 0;
    const sum = ratings.reduce((a, b) => a + (b || 0), 0);
    return sum / ratings.length;
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-24 bg-gray-200 rounded"></div>
        <div className="space-y-3">
          <div className="h-32 bg-gray-200 rounded"></div>
          <div className="h-32 bg-gray-200 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">Provider Rankings</h4>
          <p className="text-xs text-gray-500 mt-1">
            Rate this provider on Fair Pricing, Communication, and Negotiation (5-star rating)
          </p>
        </div>
        {!showAddForm && (
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Ranking
          </button>
        )}
      </div>

      {/* Add/Edit Form */}
      {showAddForm && (
        <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h5 className="text-sm font-semibold text-gray-900">
              {editingId ? 'Edit Ranking' : 'Add New Ranking'}
            </h5>
            <button
              onClick={resetForm}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* ShareRequest Dropdown */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Share Request <span className="text-red-500">*</span>
            </label>
            <select
              value={formData.shareRequestId}
              onChange={(e) => setFormData({ ...formData, shareRequestId: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
              disabled={!!editingId} // Don't allow changing ShareRequest when editing
            >
              <option value="">Select a Share Request...</option>
              {shareRequests.map((sr) => (
                <option key={sr.shareRequestId} value={sr.shareRequestId}>
                  {sr.requestName ? `${sr.requestName} - ` : ''}{sr.requestNumber} - {sr.status} {sr.dateOfService ? `(${new Date(sr.dateOfService).toLocaleDateString()})` : ''}
                </option>
              ))}
            </select>
            {shareRequests.length === 0 && (
              <p className="text-xs text-gray-500 mt-1">
                No share requests found for this provider. Rankings can only be added for providers linked to share requests.
              </p>
            )}
          </div>

          {/* Rating Sections */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Fair Pricing */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-green-600" />
                <h6 className="text-xs font-semibold text-gray-900">Fair Pricing</h6>
              </div>
              <StarRating
                rating={formData.fairPricingRating}
                onRatingChange={(rating) => setFormData({ ...formData, fairPricingRating: rating })}
              />
              <textarea
                value={formData.fairPricingNotes}
                onChange={(e) => setFormData({ ...formData, fairPricingNotes: e.target.value })}
                className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary focus:border-oe-primary"
                rows={4}
                placeholder="Notes about fair pricing..."
              />
            </div>

            {/* Communication */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 text-oe-primary" />
                <h6 className="text-xs font-semibold text-gray-900">Communication</h6>
              </div>
              <StarRating
                rating={formData.communicationRating}
                onRatingChange={(rating) => setFormData({ ...formData, communicationRating: rating })}
              />
              <textarea
                value={formData.communicationNotes}
                onChange={(e) => setFormData({ ...formData, communicationNotes: e.target.value })}
                className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary focus:border-oe-primary"
                rows={4}
                placeholder="Notes about communication..."
              />
            </div>

            {/* Negotiation */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Handshake className="h-4 w-4 text-purple-600" />
                <h6 className="text-xs font-semibold text-gray-900">Negotiation</h6>
              </div>
              <StarRating
                rating={formData.negotiationRating}
                onRatingChange={(rating) => setFormData({ ...formData, negotiationRating: rating })}
              />
              <textarea
                value={formData.negotiationNotes}
                onChange={(e) => setFormData({ ...formData, negotiationNotes: e.target.value })}
                className="w-full px-2 py-1 text-xs border border-gray-300 rounded focus:ring-1 focus:ring-oe-primary focus:border-oe-primary"
                rows={4}
                placeholder="Notes about negotiation..."
              />
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={resetForm}
              className="px-4 py-2 text-sm font-medium border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !formData.shareRequestId}
              className="px-4 py-2 text-sm font-medium text-white bg-oe-primary rounded-lg hover:bg-oe-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              <Save className="h-4 w-4" />
              {saving ? 'Saving...' : 'Save Ranking'}
            </button>
          </div>
        </div>
      )}

      {/* Rankings List */}
      {rankings.length === 0 && !showAddForm ? (
        <div className="text-center py-8 bg-gray-50 rounded-lg border border-gray-200">
          <Star className="h-12 w-12 text-gray-300 mx-auto mb-2" />
          <p className="text-sm text-gray-500">No rankings yet</p>
          <p className="text-xs text-gray-400 mt-1">Add your first ranking above</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rankings.map((ranking) => {
            const avgRating = calculateAverage(ranking);
            const shareRequest = shareRequests.find(sr => sr.shareRequestId === ranking.shareRequestId);
            
            return (
              <div key={ranking.rankingId} className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h5 className="text-sm font-semibold text-gray-900">
                        {shareRequest 
                          ? (shareRequest.requestName 
                              ? `${shareRequest.requestName} (${shareRequest.requestNumber})`
                              : `Share Request: ${shareRequest.requestNumber}`)
                          : 'Ranking'}
                      </h5>
                      {ranking.shareRequestId && shareRequest && (
                        <span className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded">
                          {shareRequest.status}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-1">
                      Rated by {ranking.createdByFirstName} {ranking.createdByLastName} on{' '}
                      {new Date(ranking.createdDate || '').toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleEdit(ranking)}
                      className="p-1.5 text-oe-primary hover:bg-oe-primary-light rounded transition-colors"
                      title="Edit"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => ranking.rankingId && handleDelete(ranking.rankingId)}
                      className="p-1.5 text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Average Rating */}
                <div className="mb-3 pb-3 border-b border-gray-200">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-700">Overall:</span>
                    <StarRating rating={Math.round(avgRating)} onRatingChange={() => {}} disabled />
                    <span className="text-xs text-gray-500">({avgRating.toFixed(1)} / 5.0)</span>
                  </div>
                </div>

                {/* Ratings Grid */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Fair Pricing */}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <TrendingUp className="h-3 w-3 text-green-600" />
                      <span className="text-xs font-medium text-gray-700">Fair Pricing</span>
                    </div>
                    <StarRating rating={ranking.fairPricingRating || 0} onRatingChange={() => {}} disabled />
                    {ranking.fairPricingNotes && (
                      <p className="text-xs text-gray-600 mt-1">{ranking.fairPricingNotes}</p>
                    )}
                  </div>

                  {/* Communication */}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <MessageCircle className="h-3 w-3 text-oe-primary" />
                      <span className="text-xs font-medium text-gray-700">Communication</span>
                    </div>
                    <StarRating rating={ranking.communicationRating || 0} onRatingChange={() => {}} disabled />
                    {ranking.communicationNotes && (
                      <p className="text-xs text-gray-600 mt-1">{ranking.communicationNotes}</p>
                    )}
                  </div>

                  {/* Negotiation */}
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Handshake className="h-3 w-3 text-purple-600" />
                      <span className="text-xs font-medium text-gray-700">Negotiation</span>
                    </div>
                    <StarRating rating={ranking.negotiationRating || 0} onRatingChange={() => {}} disabled />
                    {ranking.negotiationNotes && (
                      <p className="text-xs text-gray-600 mt-1">{ranking.negotiationNotes}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default FAPRankingsSection;
