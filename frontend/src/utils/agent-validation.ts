import { IMAGES } from '../constants/images';

export interface AgentProfileValidationData {
  FirstName?: string;
  LastName?: string;
  Email?: string;
  AgentPhone?: string;
  PhoneNumber?: string;
  ProfileImageUrl?: string;
  Address1?: string;
  City?: string;
  State?: string;
  ZipCode?: string;
  W9Stored?: boolean;
  BankingInfoStored?: boolean;
}

export interface AgentLicenseValidationData {
  LicenseId?: string;
}

export interface AgentValidationCheck {
  key: string;
  label: string;
  ok: boolean;
  targetId: string;
  blocking: boolean;
  guide?: string;
}

export interface AgentValidationSummary {
  total: number;
  completed: number;
  checks: AgentValidationCheck[];
  missing: AgentValidationCheck[];
  tone: 'good' | 'warning' | 'critical';
}

const hasText = (value?: string): boolean => typeof value === 'string' && value.trim().length > 0;

const isDefaultAvatar = (value?: string): boolean => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return true;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.includes('default-avatar.svg') || normalized.includes(IMAGES.UI.DEFAULT_AVATAR.toLowerCase());
};

export const buildAgentValidationSummary = (
  profile: AgentProfileValidationData,
  activeLicenses: AgentLicenseValidationData[]
): AgentValidationSummary => {
  const checks: AgentValidationCheck[] = [
    { key: 'photo', label: 'Profile photo', ok: hasText(profile.ProfileImageUrl) && !isDefaultAvatar(profile.ProfileImageUrl), targetId: 'settings-profile-photo-action', blocking: false, guide: 'profile-photo' },
    { key: 'firstName', label: 'First name', ok: hasText(profile.FirstName), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'lastName', label: 'Last name', ok: hasText(profile.LastName), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'email', label: 'Email', ok: hasText(profile.Email), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'phone', label: 'Phone number', ok: hasText(profile.AgentPhone) || hasText(profile.PhoneNumber), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'address1', label: 'Address line 1', ok: hasText(profile.Address1), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'city', label: 'City', ok: hasText(profile.City), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'state', label: 'State', ok: hasText(profile.State), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'zipCode', label: 'ZIP code', ok: hasText(profile.ZipCode), targetId: 'settings-profile-edit-action', blocking: false, guide: 'profile-edit' },
    { key: 'w9', label: 'W-9 form', ok: Boolean(profile.W9Stored), targetId: 'settings-w9-upload-action', blocking: true, guide: 'w9-upload' },
    { key: 'banking', label: 'Banking info', ok: Boolean(profile.BankingInfoStored), targetId: 'settings-banking-edit-action', blocking: false, guide: 'banking-edit' },
    { key: 'license', label: 'Active license', ok: activeLicenses.length > 0, targetId: 'settings-licenses-edit-action', blocking: true, guide: 'license-edit' },
  ];

  const missing = checks.filter((check) => !check.ok);
  const completed = checks.length - missing.length;
  const hasBlockingMissing = missing.some((check) => check.blocking);

  return {
    total: checks.length,
    completed,
    checks,
    missing,
    tone: missing.length === 0 ? 'good' : hasBlockingMissing ? 'critical' : 'warning',
  };
};

/**
 * Requirements to create enrollment links: W-9 and banking only (not full profile, not generic license count).
 */
export const buildEnrollmentLinkCreationSummary = (
  profile: AgentProfileValidationData
): AgentValidationSummary => {
  const checks: AgentValidationCheck[] = [
    {
      key: 'w9',
      label: 'W-9 form',
      ok: Boolean(profile.W9Stored),
      targetId: 'settings-w9-upload-action',
      blocking: true,
      guide: 'w9-upload',
    },
    {
      key: 'banking',
      label: 'Banking info',
      ok: Boolean(profile.BankingInfoStored),
      targetId: 'settings-banking-edit-action',
      blocking: true,
      guide: 'banking-edit',
    },
  ];

  const missing = checks.filter((check) => !check.ok);
  const completed = checks.length - missing.length;
  const hasBlockingMissing = missing.some((check) => check.blocking);

  return {
    total: checks.length,
    completed,
    checks,
    missing,
    tone: missing.length === 0 ? 'good' : hasBlockingMissing ? 'critical' : 'warning',
  };
};
