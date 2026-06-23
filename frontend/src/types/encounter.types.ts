// Types for the back-office Encounters feature.
// Spec: docs/superpowers/specs/2026-05-15-encounters-design.md

export type EncounterChannel = 'phone' | 'email' | 'in_person' | 'sms' | 'video' | 'other';
export type EncounterDirection = 'inbound' | 'outbound' | 'internal';
export type EncounterSource = 'manual' | 'zoom_phone' | 'zoom_meeting' | 'imported';

export const ENCOUNTER_CHANNELS: EncounterChannel[] = ['phone', 'email', 'in_person', 'sms', 'video', 'other'];
export const ENCOUNTER_DIRECTIONS: EncounterDirection[] = ['inbound', 'outbound', 'internal'];

export const CHANNEL_LABELS: Record<EncounterChannel, string> = {
  phone: 'Phone',
  email: 'Email',
  in_person: 'In-person',
  sms: 'SMS',
  video: 'Video',
  other: 'Other',
};

export const DIRECTION_LABELS: Record<EncounterDirection, string> = {
  inbound: 'Inbound',
  outbound: 'Outbound',
  internal: 'Internal',
};

export interface EncounterRow {
  EncounterId: string;
  VendorId: string;
  EncounterNumber: string;
  MemberId: string | null;
  CaseId: string | null;
  ShareRequestId: string | null;
  Summary: string;
  Notes?: string | null;
  Channel: EncounterChannel | null;
  Direction: EncounterDirection | null;
  Source: EncounterSource;
  ExternalRef: string | null;
  OccurredAt: string | null;
  DurationSeconds: number | null;
  RecordingUrl: string | null;
  TranscriptText?: string | null;
  AssignedToUserId: string | null;
  FollowUpDueDate: string | null;
  FollowUpCompletedAt: string | null;
  IsArchived: boolean;
  CreatedDate: string;
  CreatedBy: string | null;
  CreatedByName: string | null;
  ModifiedDate: string | null;
  ModifiedBy: string | null;
  // Joined display fields
  MemberFirstName?: string | null;
  MemberLastName?: string | null;
  MemberEmail?: string | null;
  MemberPhone?: string | null;
  AssignedToFirstName?: string | null;
  AssignedToLastName?: string | null;
  AssignedToColor?: string | null;
  CreatedByFirstName?: string | null;
  CreatedByLastName?: string | null;
  PinnedCaseNumber?: string | null;
  PinnedShareRequestNumber?: string | null;
  /** Email encounters: the inbox thread this came from (for a "Go to email" deep link). */
  EmailMessageId?: string | null;
  EmailThreadId?: string | null;
}

export interface EncounterAttachment {
  AttachmentId: string;
  EncounterId: string;
  FileName: string;
  MimeType?: string | null;
  FileSize?: number | null;
  BlobUrl?: string | null;
  BlobPath?: string | null;
  Description?: string | null;
  UploadedBy?: string | null;
  IsActive: boolean;
  CreatedDate: string;
  AuthenticatedUrl?: string | null;
}

export interface EncounterDashboardStats {
  Total: number;
  NoMember: number;
  Mine: number;
  FollowUpOpen: number;
  FollowUpDueThisWeek: number;
  Today: number;
  ByChannel: Record<EncounterChannel, number>;
}

export interface EncounterAssignee {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  assignedCount: number;
}

export type EncounterScope =
  | { kind: 'member'; memberId: string }
  | { kind: 'case'; caseId: string; memberId?: string }
  | { kind: 'shareRequest'; shareRequestId: string; memberId?: string }
  | { kind: 'all' };

export const channelLabel = (c: EncounterChannel | null | undefined): string =>
  c ? CHANNEL_LABELS[c] : '—';

export const directionLabel = (d: EncounterDirection | null | undefined): string =>
  d ? DIRECTION_LABELS[d] : '—';

export const isFollowUpOpen = (e: EncounterRow): boolean =>
  !!e.FollowUpDueDate && !e.FollowUpCompletedAt;

export const isFollowUpOverdue = (e: EncounterRow): boolean => {
  if (!isFollowUpOpen(e)) return false;
  const due = new Date(e.FollowUpDueDate as string);
  return !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
};
