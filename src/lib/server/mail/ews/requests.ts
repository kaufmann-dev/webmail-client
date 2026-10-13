import type { InvitationResponse } from '../../../mail-types';
import type { MessageFilters } from '../messages';
import { escapeXml } from './xml';

/** Request bodies for Exchange Web Services, without the SOAP envelope (see `client.ts`). */

export const SUMMARY_FIELDS = [
	'item:Subject',
	'item:DateTimeReceived',
	'item:HasAttachments',
	'item:IsDraft',
	'item:Flag',
	'item:ParentFolderId',
	'message:IsRead',
	'message:From',
	'message:ToRecipients',
	'message:InternetMessageId'
];

export const DETAIL_FIELDS = [
	...SUMMARY_FIELDS,
	'message:CcRecipients',
	'message:BccRecipients',
	'message:ReplyTo',
	'item:InReplyTo',
	'message:References',
	'item:DateTimeSent',
	'item:ItemClass',
	'item:Attachments',
	'item:Body'
];

/** Summary fields plus the conversation a message belongs to. */
export const THREAD_FIELDS = [...SUMMARY_FIELDS, 'item:ConversationId'];

/** Exchange's preview: the start of the body as one line of text (Exchange 2013 and later). */
export const PREVIEW_FIELDS = ['item:Preview'];

/** PidTagFlagStatus: 2 means flagged for follow-up. */
const FLAG_STATUS = '<t:ExtendedFieldURI PropertyTag="0x1090" PropertyType="Integer"/>';
/** PidTagAttributeHidden: folders Outlook does not show. */
export const HIDDEN = '<t:ExtendedFieldURI PropertyTag="0x10F4" PropertyType="Boolean"/>';

function fields(names: string[], extended = ''): string {
	const uris = names.map((name) => `<t:FieldURI FieldURI="${name}"/>`).join('');
	return `<t:AdditionalProperties>${uris}${extended}</t:AdditionalProperties>`;
}

function itemIds(ids: string[], element = 't:ItemId'): string {
	return ids.map((id) => `<${element} Id="${escapeXml(id)}"/>`).join('');
}

function folderId(id: string): string {
	return `<t:FolderId Id="${escapeXml(id)}"/>`;
}

export function distinguishedFolders(ids: string[]): string {
	const folders = ids.map((id) => `<t:DistinguishedFolderId Id="${id}"/>`).join('');
	return (
		'<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>' +
		`<m:FolderIds>${folders}</m:FolderIds></m:GetFolder>`
	);
}

export function findFolders(): string {
	return (
		'<m:FindFolder Traversal="Deep"><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape>' +
		fields(['folder:DisplayName', 'folder:ParentFolderId', 'folder:FolderClass'], HIDDEN) +
		'</m:FolderShape><m:IndexedPageFolderView MaxEntriesReturned="1000" Offset="0" BasePoint="Beginning"/>' +
		'<m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds></m:FindFolder>'
	);
}

export function inboxUnread(): string {
	return (
		'<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape>' +
		fields(['folder:UnreadCount']) +
		'</m:FolderShape><m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>'
	);
}

/** Creates a mail folder below `parentId`, or at the top level of the mailbox. */
export function createFolder(name: string, parentId?: string): string {
	const parent = parentId ? folderId(parentId) : '<t:DistinguishedFolderId Id="msgfolderroot"/>';
	return (
		`<m:CreateFolder><m:ParentFolderId>${parent}</m:ParentFolderId>` +
		`<m:Folders><t:Folder><t:FolderClass>IPF.Note</t:FolderClass><t:DisplayName>${escapeXml(name)}</t:DisplayName></t:Folder></m:Folders>` +
		'</m:CreateFolder>'
	);
}

export function renameFolder(id: string, name: string): string {
	return (
		`<m:UpdateFolder><m:FolderChanges><t:FolderChange>${folderId(id)}<t:Updates>` +
		'<t:SetFolderField><t:FieldURI FieldURI="folder:DisplayName"/>' +
		`<t:Folder><t:DisplayName>${escapeXml(name)}</t:DisplayName></t:Folder></t:SetFolderField>` +
		'</t:Updates></t:FolderChange></m:FolderChanges></m:UpdateFolder>'
	);
}

/** Deletes a folder with its subfolders and items, bypassing Deleted Items. */
export function deleteFolder(id: string): string {
	return `<m:DeleteFolder DeleteType="HardDelete"><m:FolderIds>${folderId(id)}</m:FolderIds></m:DeleteFolder>`;
}

function compare(operator: string, field: string, value: string): string {
	return (
		`<t:${operator}>${field}<t:FieldURIOrConstant><t:Constant Value="${escapeXml(value)}"/>` +
		`</t:FieldURIOrConstant></t:${operator}>`
	);
}

const IS_READ = '<t:FieldURI FieldURI="message:IsRead"/>';
const RECEIVED = '<t:FieldURI FieldURI="item:DateTimeReceived"/>';

function unreadWanted(filters: MessageFilters): boolean | undefined {
	return filters.unread ?? (filters.filter === 'unread' ? true : undefined);
}

function starredWanted(filters: MessageFilters): boolean | undefined {
	return filters.starred ?? (filters.filter === 'starred' ? true : undefined);
}

/** Filters without text, as a Restriction; null when nothing is filtered. */
export function restriction(filters: MessageFilters): string | null {
	const conditions: string[] = [];
	const unread = unreadWanted(filters);
	if (unread !== undefined) conditions.push(compare('IsEqualTo', IS_READ, String(!unread)));
	const starred = starredWanted(filters);
	if (starred !== undefined) {
		const flagged = compare('IsEqualTo', FLAG_STATUS, '2');
		conditions.push(starred ? flagged : `<t:Not>${flagged}</t:Not>`);
	}
	if (filters.since) {
		conditions.push(compare('IsGreaterThanOrEqualTo', RECEIVED, filters.since.toISOString()));
	}
	if (filters.before) {
		conditions.push(compare('IsLessThan', RECEIVED, filters.before.toISOString()));
	}
	if (!conditions.length) return null;
	return conditions.length === 1 ? conditions[0] : `<t:And>${conditions.join('')}</t:And>`;
}

/**
 * A field value as AQS words in parentheses, which match anywhere in the field. A quoted phrase
 * only matches the whole value on some servers ("Budget" misses "AW: Budget").
 */
function words(value: string): string {
	return `(${value.replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim()})`;
}

/** An AQS date: month/day/year, as the en-US mailbox culture of every request reads it. */
function day(date: Date): string {
	return `${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`;
}

/**
 * Text searches as an AQS query string. EWS takes either a QueryString or a Restriction, so the
 * other filters join the query; null when there is no text to search.
 */
export function queryString(filters: MessageFilters): string | null {
	const query = filters.query?.trim();
	if (!query && !filters.from && !filters.to && !filters.subject) return null;
	const parts: string[] = [];
	if (query) parts.push(query);
	if (filters.from) parts.push(`from:${words(filters.from)}`);
	if (filters.to) parts.push(`to:${words(filters.to)}`);
	if (filters.subject) parts.push(`subject:${words(filters.subject)}`);
	const unread = unreadWanted(filters);
	if (unread !== undefined) parts.push(`isread:${!unread}`);
	const starred = starredWanted(filters);
	if (starred !== undefined) parts.push(`isflagged:${starred}`);
	if (filters.since) parts.push(`received:>=${day(filters.since)}`);
	if (filters.before) parts.push(`received:<${day(filters.before)}`);
	return parts.join(' ');
}

/** The items in a folder with a Message-ID header, IDs only. */
export function findByMessageId(folder: string, messageId: string): string {
	return (
		'<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>' +
		'<m:IndexedPageItemView MaxEntriesReturned="1" Offset="0" BasePoint="Beginning"/>' +
		`<m:Restriction>${compare('IsEqualTo', '<t:FieldURI FieldURI="message:InternetMessageId"/>', messageId)}</m:Restriction>` +
		`<m:ParentFolderIds>${folderId(folder)}</m:ParentFolderIds></m:FindItem>`
	);
}

/** One page of a folder, newest first, IDs only. */
export function findItems(
	folder: string,
	filters: MessageFilters,
	offset: number,
	limit: number
): string {
	const aqs = queryString(filters);
	const where = aqs ? null : restriction(filters);
	return (
		'<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>' +
		fields(['item:DateTimeReceived']) +
		'</m:ItemShape>' +
		`<m:IndexedPageItemView MaxEntriesReturned="${limit}" Offset="${offset}" BasePoint="Beginning"/>` +
		(where ? `<m:Restriction>${where}</m:Restriction>` : '') +
		`<m:SortOrder><t:FieldOrder Order="Descending">${RECEIVED}</t:FieldOrder></m:SortOrder>` +
		`<m:ParentFolderIds>${folderId(folder)}</m:ParentFolderIds>` +
		(aqs ? `<m:QueryString>${escapeXml(aqs)}</m:QueryString>` : '') +
		'</m:FindItem>'
	);
}

export function getItems(
	ids: string[],
	names: string[],
	options: { body?: boolean; mime?: boolean } = {}
): string {
	return (
		'<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>' +
		(options.mime ? '<t:IncludeMimeContent>true</t:IncludeMimeContent>' : '') +
		(options.body ? '<t:BodyType>HTML</t:BodyType>' : '') +
		(names.length ? fields(names) : '') +
		`</m:ItemShape><m:ItemIds>${itemIds(ids)}</m:ItemIds></m:GetItem>`
	);
}

export function getAttachments(ids: string[]): string {
	return (
		'<m:GetAttachment><m:AttachmentShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:AttachmentShape>' +
		`<m:AttachmentIds>${itemIds(ids, 't:AttachmentId')}</m:AttachmentIds></m:GetAttachment>`
	);
}

export interface ItemUpdate {
	id: string;
	/** The item's element name, such as `Message` or `MeetingRequest`. */
	type: string;
	/** `SetItemField` elements; `{type}` stands for the item's element name. */
	fields: string[];
}

export function setIsRead(read: boolean): string {
	return `<t:SetItemField>${IS_READ}<t:{type}><t:IsRead>${read}</t:IsRead></t:{type}></t:SetItemField>`;
}

export function setFlag(flagged: boolean): string {
	const status = flagged ? 'Flagged' : 'NotFlagged';
	return (
		'<t:SetItemField><t:FieldURI FieldURI="item:Flag"/>' +
		`<t:{type}><t:Flag><t:FlagStatus>${status}</t:FlagStatus></t:Flag></t:{type}></t:SetItemField>`
	);
}

export function setIntegerProperty(tag: string, value: number): string {
	const uri = `<t:ExtendedFieldURI PropertyTag="${tag}" PropertyType="Integer"/>`;
	return (
		`<t:SetItemField>${uri}<t:{type}><t:ExtendedProperty>${uri}<t:Value>${value}</t:Value>` +
		'</t:ExtendedProperty></t:{type}></t:SetItemField>'
	);
}

/** Updates items without sending read receipts. */
export function updateItems(updates: ItemUpdate[]): string {
	const changes = updates
		.map(
			(update) =>
				`<t:ItemChange><t:ItemId Id="${escapeXml(update.id)}"/><t:Updates>` +
				update.fields.map((field) => field.replaceAll('{type}', update.type)).join('') +
				'</t:Updates></t:ItemChange>'
		)
		.join('');
	return (
		'<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite" SuppressReadReceipts="true">' +
		`<m:ItemChanges>${changes}</m:ItemChanges></m:UpdateItem>`
	);
}

export function moveItems(ids: string[], folder: string): string {
	return (
		`<m:MoveItem><m:ToFolderId>${folderId(folder)}</m:ToFolderId>` +
		`<m:ItemIds>${itemIds(ids)}</m:ItemIds></m:MoveItem>`
	);
}

export function deleteItems(ids: string[]): string {
	return `<m:DeleteItem DeleteType="HardDelete"><m:ItemIds>${itemIds(ids)}</m:ItemIds></m:DeleteItem>`;
}

/** The items of conversations outside Deleted Items and Junk, one response message each. */
export function conversationItems(conversationIds: string[]): string {
	const conversations = conversationIds
		.map((id) => `<t:Conversation><t:ConversationId Id="${escapeXml(id)}"/></t:Conversation>`)
		.join('');
	return (
		'<m:GetConversationItems><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>' +
		fields(THREAD_FIELDS) +
		'</m:ItemShape><m:FoldersToIgnore><t:DistinguishedFolderId Id="deleteditems"/>' +
		'<t:DistinguishedFolderId Id="junkemail"/></m:FoldersToIgnore>' +
		`<m:Conversations>${conversations}</m:Conversations></m:GetConversationItems>`
	);
}

export function resolveName(entry: string): string {
	return (
		'<m:ResolveNames ReturnFullContactData="false">' +
		`<m:UnresolvedEntry>${escapeXml(entry)}</m:UnresolvedEntry></m:ResolveNames>`
	);
}

/** PidTagMessageFlags read + unsent: a saved draft rather than a received message. */
const DRAFT_FLAGS =
	'<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="0x0E07" PropertyType="Integer"/>' +
	'<t:Value>9</t:Value></t:ExtendedProperty>';

/** A MIME message saved to Drafts, or sent with a copy in Sent Items. */
export function createMessage(mime: Buffer, disposition: 'SaveOnly' | 'SendAndSaveCopy'): string {
	const folder = disposition === 'SaveOnly' ? 'drafts' : 'sentitems';
	return (
		`<m:CreateItem MessageDisposition="${disposition}">` +
		`<m:SavedItemFolderId><t:DistinguishedFolderId Id="${folder}"/></m:SavedItemFolderId>` +
		`<m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">${mime.toString('base64')}</t:MimeContent>` +
		(disposition === 'SaveOnly' ? DRAFT_FLAGS : '') +
		'</t:Message></m:Items></m:CreateItem>'
	);
}

const MEETING_RESPONSES: Record<InvitationResponse, string> = {
	accepted: 'AcceptItem',
	tentative: 'TentativelyAcceptItem',
	declined: 'DeclineItem'
};

/** Exchange's own answer to a meeting request, which also updates the calendar. */
export function respondToMeeting(id: string, response: InvitationResponse): string {
	const element = MEETING_RESPONSES[response];
	return (
		'<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items>' +
		`<t:${element}><t:ReferenceItemId Id="${escapeXml(id)}"/></t:${element}>` +
		'</m:Items></m:CreateItem>'
	);
}
