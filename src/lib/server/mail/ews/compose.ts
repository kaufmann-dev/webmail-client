import type { Address, InvitationResponse } from '../../../mail-types';
import type { MailAccount } from '../types';
import type { OrganizedMeeting } from './calendar';
import { check, ewsCall } from './client';
import { firstItem, itemId } from './items';
import * as request from './requests';
import { text } from './xml';

/** Saves a MIME message to Drafts and returns its item ID. */
export async function saveDraft(account: MailAccount, mime: Buffer): Promise<string> {
	const [message] = await ewsCall(account, request.createMessage(mime, 'SaveOnly'));
	const item = firstItem(check(message));
	if (!item) throw new Error('Exchange did not return the saved draft.');
	return itemId(item.node);
}

/** Sends a MIME message; Exchange delivers to its Bcc recipients and keeps a copy in Sent Items. */
export async function sendMessage(account: MailAccount, mime: Buffer): Promise<void> {
	const [message] = await ewsCall(account, request.createMessage(mime, 'SendAndSaveCopy'));
	check(message);
}

/** Creates a meeting in the calendar; Exchange sends the invitations and tracks the answers. */
export async function createMeeting(
	account: MailAccount,
	meeting: request.MeetingItem
): Promise<void> {
	const [message] = await ewsCall(account, request.createMeeting(meeting));
	check(message);
}

export { findOrganizedMeeting, type OrganizedMeeting } from './calendar';

/**
 * Changes a sent meeting in the calendar; Exchange tells the attendees the change affects (see
 * `request.updateMeeting`). Returns the meeting's attendees after the change, from the calendar
 * item, since an update sent to some attendees names only those.
 */
export async function updateMeeting(
	account: MailAccount,
	item: OrganizedMeeting,
	changes: request.MeetingChanges
): Promise<{ required: Address[]; optional: Address[] }> {
	const [message] = await ewsCall(account, request.updateMeeting(item, changes));
	check(message);
	return {
		required: changes.required ?? item.required,
		optional: changes.optional ?? item.optional
	};
}

/** Cancels a sent meeting; Exchange tells the attendees and takes it out of the calendar. */
export async function cancelMeeting(
	account: MailAccount,
	item: OrganizedMeeting,
	html: string
): Promise<void> {
	const [message] = await ewsCall(account, request.cancelMeeting(item, html));
	check(message);
}

/**
 * Answers a meeting request the Exchange way, which also updates the calendar. Returns false when
 * the item is not a meeting request (an `.ics` file in an ordinary message, for example).
 */
export async function respondToMeeting(
	account: MailAccount,
	id: string,
	response: InvitationResponse
): Promise<boolean> {
	const [message] = await ewsCall(account, request.getItems([id], ['item:ItemClass']));
	const itemClass = text(firstItem(check(message))?.node.ItemClass);
	if (!itemClass.startsWith('IPM.Schedule.Meeting.Request')) return false;
	const [sent] = await ewsCall(account, request.respondToMeeting(id, response));
	check(sent);
	return true;
}
