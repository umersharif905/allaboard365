// Back Office email (inbox) types.
// Spec: docs/superpowers/specs/2026-06-02-back-office-email/design.md

export type EmailDirection = 'inbound' | 'outbound';

export interface EmailThread {
  ThreadId: string;
  VendorId: string;
  ConversationId: string;
  Subject: string | null;
  MemberId: string | null;
  CaseId: string | null;
  ShareRequestId: string | null;
  Participants: string | null; // JSON [{name,address}]
  FirstMessageAt: string | null;
  LastMessageAt: string | null;
  LastDirection: EmailDirection | null;
  MessageCount: number;
  UnreadCount: number;
  NeedsReply: boolean;
  AssignedToUserId: string | null;
  IsArchived: boolean;
  CreatedDate: string;
  // joined display fields
  LinkedShareRequestNumber?: string | null;
  LinkedCaseNumber?: string | null;
  CounterpartyName?: string | null;
  CounterpartyAddress?: string | null;
  LinkedMemberName?: string | null;
  /** Soft owner ("their inbox") — display name + claim-chip color. */
  OwnerName?: string | null;
  OwnerColor?: string | null;
  MemberFirstName?: string | null;
  MemberLastName?: string | null;
  MemberEmail?: string | null;
  MemberPhone?: string | null;
  /** Latest message's preview — the inbox row's third line (Outlook-style snippet). */
  LastPreview?: string | null;
  /** "Handled" resolution — set when a teammate marks the thread done; cleared on new inbound. */
  ResolvedAt?: string | null;
  ResolvedByUserId?: string | null;
  ResolvedByName?: string | null;
}

/** Team-only note on an email thread (never sent to the customer). */
export interface EmailThreadNote {
  NoteId: string;
  Note: string;
  IsInternal: boolean;
  CreatedDate: string;
  CreatedBy: string | null;
  CreatedByName: string | null;
}

export interface EmailMessage {
  EmailMessageId: string;
  ThreadId: string;
  GraphMessageId: string;
  InternetMessageId: string | null;
  Direction: EmailDirection;
  FromAddress: string | null;
  FromName: string | null;
  ToAddresses: string | null; // JSON
  CcAddresses: string | null; // JSON
  Subject: string | null;
  BodyHtml: string | null;
  BodyPreview: string | null;
  ReceivedAt: string | null;
  SentAt: string | null;
  IsRead: boolean;
  HasAttachments: boolean;
  SentByUserId: string | null;
  RefStamp: string | null;
  SendStatus: string | null;
  CreatedDate: string;
  SentByFirstName?: string | null;
  SentByLastName?: string | null;
}

export interface EmailThreadDetail extends EmailThread {
  messages: EmailMessage[];
}

/** One conversation in the customer-history modal: thread meta + its messages. */
export interface CustomerHistoryThread {
  ThreadId: string;
  Subject: string | null;
  LastMessageAt: string | null;
  FirstMessageAt: string | null;
  MemberId: string | null;
  CaseId: string | null;
  ShareRequestId: string | null;
  MessageCount: number;
  LastDirection: EmailDirection | null;
  NeedsReply: boolean;
  LinkedShareRequestNumber?: string | null;
  LinkedCaseNumber?: string | null;
  CounterpartyName?: string | null;
  CounterpartyAddress?: string | null;
  /** True when this thread is linked to the case/SR currently being worked. */
  isCurrentContext: boolean;
  messages: EmailMessage[];
}

export interface CustomerHistory {
  threads: CustomerHistoryThread[];
}

export interface EmailAttachment {
  AttachmentId: string;
  EmailMessageId: string;
  FileName: string;
  MimeType: string | null;
  FileSize: number | null;
  AuthenticatedUrl?: string | null;
}

export interface MatchSuggestion {
  member: { MemberId: string; FirstName: string; LastName: string; Email: string; Phone: string | null } | null;
  /** Set when the email named a dependent/spouse — the suggested `member` is the
   *  household primary, and this is the person on the plan the email referenced. */
  planMember?: { FirstName: string; LastName: string; RelationshipType: string; Relationship: string } | null;
  shareRequestId: string | null;
  shareRequestNumber: string | null;
  caseId: string | null;
  caseNumber: string | null;
  reason: string | null;
}

export interface LinkSuggestions {
  members: { MemberId: string; FirstName: string; LastName: string; Email: string }[];
  shareRequests: { ShareRequestId: string; RequestNumber: string; Status: string }[];
  cases: { CaseId: string; CaseNumber: string; Status: string }[];
}

export type ThreadPillKind = 'needs-reply' | 'awaiting-customer' | 'linked' | 'unread' | 'bounced';

export interface ThreadPill {
  kind: ThreadPillKind;
  label: string;
}

// Non-delivery reports arrive as inbound mail from postmaster/mailer-daemon with
// a recognizable subject — surface them so a bounced send isn't missed.
const BOUNCE_SUBJECT_RE = /^(undeliverable|delivery (status notification|has failed)|mail delivery (failed|subsystem)|returned mail|message not delivered|failure notice)/i;
const BOUNCE_SENDER_RE = /(postmaster@|mailer-daemon|microsoftexchange[0-9a-f]*@)/i;

export function isLikelyBounce(t: Pick<EmailThread, 'Subject' | 'CounterpartyName' | 'CounterpartyAddress'>): boolean {
  return BOUNCE_SUBJECT_RE.test((t.Subject || '').trim())
    || BOUNCE_SENDER_RE.test(t.CounterpartyAddress || '')
    || BOUNCE_SENDER_RE.test(t.CounterpartyName || '');
}

/** Derive the status pills for a thread (mirrors the design's pill rules). */
export function deriveThreadPills(t: Pick<EmailThread,
  'NeedsReply' | 'LastDirection' | 'UnreadCount' | 'CaseId' | 'ShareRequestId' | 'LinkedShareRequestNumber' | 'LinkedCaseNumber'
  | 'Subject' | 'CounterpartyName' | 'CounterpartyAddress'>): ThreadPill[] {
  const pills: ThreadPill[] = [];
  if (isLikelyBounce(t)) pills.push({ kind: 'bounced', label: 'Delivery failed' });
  if (t.NeedsReply) pills.push({ kind: 'needs-reply', label: 'Needs reply' });
  else if (t.LastDirection === 'outbound') pills.push({ kind: 'awaiting-customer', label: 'Awaiting customer' });
  const ref = t.LinkedShareRequestNumber || t.LinkedCaseNumber;
  if (t.ShareRequestId || t.CaseId) pills.push({ kind: 'linked', label: ref || 'Linked' });
  if (t.UnreadCount > 0) pills.push({ kind: 'unread', label: 'Unread' });
  return pills;
}

export const senderDisplay = (m: EmailMessage): string => {
  if (m.Direction === 'outbound') {
    const name = `${m.SentByFirstName || ''} ${m.SentByLastName || ''}`.trim();
    return name ? `${name} (Care Team)` : 'Care Team';
  }
  return m.FromName || m.FromAddress || 'Unknown';
};
