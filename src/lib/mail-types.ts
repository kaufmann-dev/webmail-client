/** Types and constants shared by the server mail layer and the UI. */

import type { MailFont } from './html';

export const PROVIDERS = ['gmail', 'purelymail', 'microsoft', 'exchange'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = {
	gmail: 'Gmail',
	purelymail: 'Purelymail',
	microsoft: 'Microsoft 365',
	exchange: 'Exchange'
};

export const ACCOUNT_COLORS = [
	'blue',
	'green',
	'orange',
	'purple',
	'red',
	'teal',
	'pink',
	'gray'
] as const;
export type AccountColor = (typeof ACCOUNT_COLORS)[number];

/** MCP access levels, each including the ones before it. */
export const ACCESS_LEVELS = ['read', 'organize', 'send'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
	read: 'Read only',
	organize: 'Read & organize',
	send: 'Full (can send)'
};

export const ACCESS_LEVEL_DESCRIPTIONS: Record<AccessLevel, string> = {
	read: 'List, search, and read messages and attachments.',
	organize: 'Also flag, move, archive, trash, save drafts, and manage folders.',
	send: 'Also send replies, forwards, new messages, and invitation responses.'
};

/** Optional MCP time windows: an app may only see messages received within this many days. */
export const MAX_AGE_DAYS = [7, 30, 90] as const;
export type MaxAgeDays = (typeof MAX_AGE_DAYS)[number];

export function isMaxAgeDays(value: number): value is MaxAgeDays {
	return (MAX_AGE_DAYS as readonly number[]).includes(value);
}

/** A stored time window; a value this version does not offer becomes the narrowest one. */
export function storedMaxAgeDays(value: number | null): MaxAgeDays | null {
	if (value === null) return null;
	return isMaxAgeDays(value) ? value : MAX_AGE_DAYS[0];
}

/** One MCP client's access to one mail account. */
export interface AccountGrant {
	level: AccessLevel;
	/** Null means messages of any age. */
	maxAgeDays: MaxAgeDays | null;
	allowAttachments: boolean;
}

export const FOLDER_ROLES = ['inbox', 'drafts', 'sent', 'archive', 'spam', 'trash'] as const;
export type FolderRole = (typeof FOLDER_ROLES)[number];

export const FOLDER_ROLE_LABELS: Record<FolderRole, string> = {
	inbox: 'Inbox',
	drafts: 'Drafts',
	sent: 'Sent',
	archive: 'Archive',
	spam: 'Spam',
	trash: 'Trash'
};

export function isFolderRole(value: string): value is FolderRole {
	return (FOLDER_ROLES as readonly string[]).includes(value);
}

export const LIST_FILTERS = ['all', 'unread', 'starred'] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export interface Address {
	name: string;
	address: string;
}

/** An account as the UI sees it; never includes the secret. */
export interface AccountSummary {
	id: string;
	provider: Provider;
	email: string;
	displayName: string;
	label: string;
	color: AccountColor;
	/** Sanitized HTML, or null without a signature. */
	signature: string | null;
	/** Null sends mail without a font. */
	font: MailFont | null;
	lastError: string | null;
}

export interface MessageSummary {
	ref: string;
	accountId: string;
	/**
	 * The account's list cursor after this message: its UID over IMAP; on Exchange its received
	 * second and place among that second's messages (`timeCursors`), or its 1-based position in
	 * text searches.
	 */
	cursor: number;
	from: Address | null;
	to: Address[];
	subject: string;
	date: string;
	unread: boolean;
	starred: boolean;
	draft: boolean;
	hasAttachments: boolean;
	messageId: string | null;
	/** Conversation keys, only when a list asked for them (MCP `group_by: "thread"`). */
	thread?: ThreadKeys;
}

/** What links a message to its conversation. */
export interface ThreadKeys {
	/** The provider's conversation ID: Exchange ConversationId, Gmail X-GM-THRID, or THREADID. */
	id: string | null;
	inReplyTo: string | null;
	references: string[];
}

export interface AttachmentInfo {
	partId: string;
	filename: string;
	contentType: string;
	size: number;
}

export const INVITATION_RESPONSES = ['accepted', 'tentative', 'declined'] as const;
export type InvitationResponse = (typeof INVITATION_RESPONSES)[number];
export type AttendeeStatus = InvitationResponse | 'needs-action' | 'delegated';

export interface Attendee extends Address {
	status: AttendeeStatus;
}

/** A calendar invitation carried by a message (iCalendar over email, RFC 6047). */
export interface Invitation {
	/** `request` asks for an answer, `cancel` withdraws the event, `reply` answers the user's own invitation. */
	method: 'request' | 'cancel' | 'reply' | 'other';
	title: string;
	/** An ISO instant, or `YYYY-MM-DD` for all-day events. */
	start: string;
	/** Exclusive end in the same form as `start`. */
	end: string | null;
	allDay: boolean;
	location: string | null;
	uid: string | null;
	/** The iCalendar SEQUENCE, raised by every update the organizer sends. */
	sequence: number;
	organizer: Address | null;
	recurring: boolean;
	attendees: Attendee[];
	/** The receiving account's own status when it is listed as an attendee. */
	ownStatus: AttendeeStatus | null;
	/** The account itself organizes the event (its own drafts and sent invitations). */
	organizedByYou: boolean;
}

export interface BusyTime {
	/** ISO instants. */
	start: string;
	end: string;
	tentative: boolean;
}

export interface MailboxAvailability {
	address: string;
	/** Null when Exchange has no information, as for addresses outside the organization. */
	busy: BusyTime[] | null;
}

/** A period of time, as ISO instants. */
export interface TimeRange {
	start: string;
	end: string;
}

/** Busy times of the organizer and attendees (Exchange), and the free times that suit all. */
export interface MeetingTimes {
	attendees: MailboxAvailability[];
	free: TimeRange[];
}

export interface MessageDetail extends MessageSummary {
	cc: Address[];
	bcc: Address[];
	replyTo: Address[];
	inReplyTo: string | null;
	references: string[];
	text: string;
	/** Sanitized HTML body; plain-text messages arrive converted to HTML. */
	html: string;
	/** Whether the HTML references remote images that were blocked. */
	hasRemoteImages: boolean;
	attachments: AttachmentInfo[];
	invitation: Invitation | null;
}

export interface AccountError {
	accountId: string;
	message: string;
}

export interface MessagePage {
	messages: MessageSummary[];
	nextCursor: string | null;
	errors: AccountError[];
	/** Accounts still loading; their messages are not in this page yet. */
	pending: string[];
}

/** The editor's starting state; carried attachments stay on the server until sending. */
export interface ComposeState {
	accountId: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	/** The editor HTML. */
	body: string;
	inReplyTo: string;
	references: string;
	replacesDraftRef: string;
	answersRef: string;
	carriedRef: string;
	carried: AttachmentInfo[];
	mode: 'new' | 'reply' | 'forward' | 'draft';
	/** Set when the message is a meeting invitation (new messages and drafts only). */
	meeting: ComposeMeeting | null;
}

export interface ComposeMeeting {
	/** ISO instants; the form shows them in the browser's time zone. */
	start: string;
	end: string;
	location: string;
}
