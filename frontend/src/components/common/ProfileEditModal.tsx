import { IdCard, Mail, Palette, Phone, PenLine, Upload, User, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import { API_CONFIG } from '../../config/api';
import type { EmailCard } from '../../services/user.service';
import UserService, { parseEmailCard } from '../../services/user.service';
import { getUserColorStyle } from '../../types/userColor';
import SignatureCardPreview from './SignatureCardPreview';

interface UserProfile {
  userId?: string;
  firstName: string;
  lastName: string;
  email: string;
  phoneNumber?: string;
  preferredColor?: string | null;
  emailSignature?: string | null;
  emailCard?: EmailCard | string | null;
}

interface ProfileEditModalProps {
  profile: UserProfile;
  onClose: () => void;
  onSave: (updatedProfile: Partial<UserProfile>) => void;
  loading: boolean;
  /** Show the Back Office email signature field (care-team users only). */
  showEmailSignature?: boolean;
}

const ProfileEditModal: React.FC<ProfileEditModalProps> = ({ profile, onClose, onSave, loading, showEmailSignature = false }) => {
  const initialCard = parseEmailCard(profile.emailCard);
  const [formData, setFormData] = useState({
    firstName: profile.firstName || '',
    lastName: profile.lastName || '',
    phoneNumber: profile.phoneNumber || '',
    preferredColor: profile.preferredColor ?? null,
    emailSignature: profile.emailSignature ?? '',
  });

  // ShareWELL signature-card state (separate from the simple footer text).
  const [card, setCard] = useState<EmailCard>({
    enabled: initialCard?.enabled ?? false,
    title: initialCard?.title ?? '',
    directPhone: initialCard?.directPhone ?? '',
    email: initialCard?.email ?? '',
    website: initialCard?.website ?? '',
    compositePath: initialCard?.compositePath ?? null,
    photoPath: initialCard?.photoPath ?? null,
  });
  const [hasComposite, setHasComposite] = useState(!!initialCard?.compositePath);
  const [photoCacheBuster, setPhotoCacheBuster] = useState(0);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleCardChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setCard(prev => ({ ...prev, [name]: value }));
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      e.target.value = ''; // allow re-selecting the same file later
      if (!profile.userId) {
        setPhotoError('Cannot upload yet — your profile is still loading.');
        return;
      }
      setUploadingPhoto(true);
      setPhotoError(null);
      try {
        const res = await UserService.uploadEmailSignaturePhoto(file);
        if (res.success) {
          setHasComposite(true);
          setPhotoCacheBuster(Date.now());
        } else {
          setPhotoError(res.message || 'Upload failed.');
        }
      } catch (err) {
        setPhotoError(err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setUploadingPhoto(false);
      }
    }
  };

  const handleColorChange = (hex: string) => {
    setFormData(prev => ({ ...prev, preferredColor: hex.toLowerCase() }));
  };

  const handleClearColor = () => {
    setFormData(prev => ({ ...prev, preferredColor: null }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Only send the user-editable card fields; the backend preserves
    // photoPath/compositePath (managed by the photo-upload endpoint).
    const emailCard: EmailCard | undefined = showEmailSignature
      ? {
          enabled: !!card.enabled,
          title: card.title || '',
          directPhone: card.directPhone || '',
          email: card.email || '',
          website: card.website || '',
        }
      : undefined;
    onSave({ ...formData, ...(emailCard ? { emailCard } : {}) });
  };

  // Color picker preview pill. Inline style so any hex renders correctly,
  // including ones outside the Tailwind palette.
  const previewColor = formData.preferredColor;
  const previewStyle = getUserColorStyle(previewColor);
  const previewLabel = `${formData.firstName} ${formData.lastName}`.trim() || 'You';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-lg shadow-xl p-6 w-full ${showEmailSignature ? 'max-w-2xl max-h-[90vh] overflow-y-auto' : 'max-w-md'}`}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Profile Settings</h2>
          <button 
            onClick={onClose} 
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
          >
            <X size={20} className="text-gray-500" />
          </button>
        </div>
        
        <form onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  First Name <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    type="text"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleChange}
                    required
                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Last Name <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                  <input
                    type="text"
                    name="lastName"
                    value={formData.lastName}
                    onChange={handleChange}
                    required
                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                  />
                </div>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="email"
                  value={profile.email}
                  disabled
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
                />
              </div>
              <p className="text-xs text-gray-500 mt-1">Email cannot be changed.</p>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <input
                  type="tel"
                  name="phoneNumber"
                  value={formData.phoneNumber}
                  onChange={handleChange}
                  placeholder="(555) 123-4567"
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <span className="inline-flex items-center gap-1.5">
                  <Palette className="h-4 w-4 text-gray-500" />
                  Display Color
                </span>
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={previewColor || '#1f8dbf'}
                  onChange={(e) => handleColorChange(e.target.value)}
                  className="h-10 w-14 border border-gray-300 rounded-lg cursor-pointer p-0.5 bg-white"
                  aria-label="Pick display color"
                  title="Pick any color"
                />
                <span
                  style={previewStyle.style}
                  className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${previewStyle.className}`}
                >
                  {previewLabel}
                </span>
                {previewColor && (
                  <button
                    type="button"
                    onClick={handleClearColor}
                    className="text-xs text-gray-600 hover:text-red-600 underline"
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Shown next to your name when you claim a share request.
              </p>
            </div>

            {showEmailSignature && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  <span className="inline-flex items-center gap-1.5">
                    <PenLine className="h-4 w-4 text-gray-500" />
                    Email signature
                  </span>
                </label>
                <textarea
                  name="emailSignature"
                  value={formData.emailSignature}
                  onChange={handleChange}
                  rows={3}
                  maxLength={4000}
                  placeholder={'— Jane Doe\nMember Success Specialist'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary resize-none"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Added to the bottom of emails you send from the Back Office inbox. Leave blank to use the default. The case reference (e.g. Ref: SR-2026-0123) is always added automatically.
                </p>
              </div>
            )}

            {showEmailSignature && (
              <div className="border-t border-gray-200 pt-4">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium text-gray-700">
                    <span className="inline-flex items-center gap-1.5">
                      <IdCard className="h-4 w-4 text-gray-500" />
                      ShareWELL signature card
                    </span>
                  </label>
                  <label className="inline-flex items-center cursor-pointer gap-2">
                    <input
                      type="checkbox"
                      checked={!!card.enabled}
                      onChange={(e) => setCard(prev => ({ ...prev, enabled: e.target.checked }))}
                      className="h-4 w-4 rounded border-gray-300 text-oe-primary focus:ring-oe-primary"
                    />
                    <span className="text-sm text-gray-700">Use card</span>
                  </label>
                </div>
                <p className="text-xs text-gray-500 mt-1 mb-3">
                  A branded business card added to the bottom of your sent emails. When enabled, it
                  replaces the plain text signature above (the Ref line is still added).
                </p>

                <div className={card.enabled ? '' : 'opacity-50 pointer-events-none'}>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Title</label>
                      <input
                        type="text"
                        name="title"
                        value={card.title ?? ''}
                        onChange={handleCardChange}
                        placeholder="Member Success Specialist"
                        maxLength={200}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Direct phone</label>
                      <input
                        type="tel"
                        name="directPhone"
                        value={card.directPhone ?? ''}
                        onChange={handleCardChange}
                        placeholder="801.555.0123"
                        maxLength={50}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                      <input
                        type="email"
                        name="email"
                        value={card.email ?? ''}
                        onChange={handleCardChange}
                        placeholder="jane@sharewellpartners.com"
                        maxLength={255}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Website</label>
                      <input
                        type="text"
                        name="website"
                        value={card.website ?? ''}
                        onChange={handleCardChange}
                        placeholder="www.sharewellhealth.org"
                        maxLength={255}
                        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-oe-primary focus:border-oe-primary"
                      />
                    </div>
                  </div>

                  {/* Headshot upload */}
                  <div className="mt-3">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Headshot</label>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingPhoto}
                        className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 text-gray-700 bg-white rounded-lg hover:bg-gray-50 disabled:opacity-50"
                      >
                        <Upload className="h-4 w-4" />
                        {uploadingPhoto ? 'Uploading…' : hasComposite ? 'Replace photo' : 'Upload photo'}
                      </button>
                      <span className="text-xs text-gray-500">
                        {hasComposite ? 'Photo set — cropped to an oval automatically.' : 'JPG or PNG, up to 8 MB.'}
                      </span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={handlePhotoSelected}
                        className="hidden"
                      />
                    </div>
                    {photoError && <p className="text-xs text-red-600 mt-1">{photoError}</p>}
                  </div>

                  {/* Live preview */}
                  <div className="mt-4">
                    <p className="text-xs font-medium text-gray-600 mb-2">Preview</p>
                    <div className="overflow-x-auto border border-gray-200 rounded-lg p-3 bg-gray-50">
                      <SignatureCardPreview
                        apiBase={API_CONFIG.BASE_URL || ''}
                        userId={profile.userId || ''}
                        name={`${formData.firstName} ${formData.lastName}`.trim() || 'Your Name'}
                        title={card.title ?? ''}
                        directPhone={card.directPhone}
                        email={card.email}
                        website={card.website}
                        hasComposite={hasComposite}
                        cacheBuster={photoCacheBuster}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
          
          <div className="mt-6 flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-oe-primary text-white rounded-lg hover:bg-oe-primary-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ProfileEditModal;

