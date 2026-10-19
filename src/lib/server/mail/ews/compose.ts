import type { InvitationResponse } from '../../../mail-types';
import type { MailAccount } from '../types';
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
