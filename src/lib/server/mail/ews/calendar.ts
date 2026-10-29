import type { Address, MailboxAvailability } from '../../../mail-types';
import { MailError } from '../errors';
import type { MailAccount } from '../types';
import { check, ewsCall, ewsOperation, failed } from './client';
import { firstItem, itemId, itemsOf, mailboxes } from './items';
import * as request from './requests';
import { attr, child, list, text, type XmlNode } from './xml';

const BUSY = new Set(['Busy', 'OOF', 'Tentative']);

/** Availability times come back in the requested UTC zone, without an offset. */
const utc = (value: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);

/** Reads a `GetUserAvailabilityResponse`, one entry per requested address, in order. */
export function availabilityOf(
	response: XmlNode | undefined,
	addresses: string[]
): MailboxAvailability[] {
	const responses = list(child(response, 'FreeBusyResponseArray')?.FreeBusyResponse);
	return addresses.map((address, index) => {
		const entry = responses[index];
		const view = child(entry, 'FreeBusyView');
		const type = text(view?.FreeBusyViewType);
		if (!entry || attr(child(entry, 'ResponseMessage'), 'ResponseClass') === 'Error' || !view) {
			return { address, busy: null };
		}
		if (!type || type === 'None') return { address, busy: null };
		const busy = list(child(view, 'CalendarEventArray')?.CalendarEvent)
			.filter((event) => BUSY.has(text(event.BusyType)))
			.map((event) => ({
				start: utc(text(event.StartTime)).toISOString(),
				end: utc(text(event.EndTime)).toISOString(),
				tentative: text(event.BusyType) === 'Tentative'
			}))
			.filter((event) => !Number.isNaN(Date.parse(event.start)) && event.end > event.start);
		return { address, busy };
	});
}

/** Busy times of mailboxes between two ISO instants. */
export async function availability(
	account: MailAccount,
	addresses: string[],
	start: string,
	end: string
): Promise<MailboxAvailability[]> {
	const response = await ewsOperation(account, request.getUserAvailability(addresses, start, end));
	return availabilityOf(response, addresses);
}

const MEETING_FIELDS = [
	'item:Subject',
	'calendar:Start',
	'calendar:End',
	'calendar:Location',
	'calendar:UID',
	'calendar:IsOrganizer',
	'calendar:CalendarItemType',
	'calendar:RequiredAttendees',
	'calendar:OptionalAttendees'
];

/** A meeting the user organizes in the calendar, as it is now. */
export interface OrganizedMeeting extends request.CalendarItemId {
	subject: string;
	/** ISO instants. */
	start: string;
	end: string;
	location: string | null;
	required: Address[];
	optional: Address[];
}

/** The PidLidGlobalObjectId prefix every Exchange meeting ID starts with. */
const GLOBAL_OBJECT_ID = /^040000008200E00074C5B7101A82E008(?:[0-9A-F]{2})+$/i;

/**
 * The global object ID (base64) a UID stands for: Exchange gives meetings it creates their ID in
 * hex as UID. Null for UIDs from other calendar programs.
 */
export function globalObjectIdOf(uid: string): string | null {
	return GLOBAL_OBJECT_ID.test(uid) ? Buffer.from(uid, 'hex').toString('base64') : null;
}

/** The mailboxes of an attendee list such as `RequiredAttendees`. */
const attendeesOf = (container: XmlNode | undefined) =>
	list(container?.Attendee).flatMap((attendee) => mailboxes(attendee));

/**
 * The single (not recurring) meeting the user organizes with this iCalendar UID, among the
 * `GetItem` response messages of calendar items.
 */
export function organizedMeetingOf(messages: XmlNode[], uid: string): OrganizedMeeting | null {
	const wanted = uid.toLowerCase();
	for (const message of messages) {
		const node = failed(message) ? null : firstItem(message)?.node;
		if (
			node &&
			text(node.UID).toLowerCase() === wanted &&
			text(node.IsOrganizer) === 'true' &&
			text(node.CalendarItemType) === 'Single'
		) {
			return {
				id: itemId(node),
				changeKey: attr(child(node, 'ItemId'), 'ChangeKey'),
				subject: text(node.Subject),
				start: new Date(text(node.Start)).toISOString(),
				end: new Date(text(node.End)).toISOString(),
				location: text(node.Location) || null,
				required: attendeesOf(child(node, 'RequiredAttendees')),
				optional: attendeesOf(child(node, 'OptionalAttendees'))
			};
		}
	}
	return null;
}

/**
 * Finds the calendar item of a meeting the user sent by its UID, wherever it has moved since; a
 * UID Exchange did not create is looked for among the items at the given time.
 */
export async function findOrganizedMeeting(
	account: MailAccount,
	uid: string,
	start: string,
	end: string
): Promise<OrganizedMeeting> {
	const globalObjectId = globalObjectIdOf(uid);
	const [listed] = await ewsCall(
		account,
		globalObjectId ? request.meetingItems(globalObjectId) : request.calendarView(start, end)
	);
	const ids = itemsOf(child(child(check(listed), 'RootFolder'), 'Items')).map(({ node }) =>
		itemId(node)
	);
	const found = ids.length
		? organizedMeetingOf(await ewsCall(account, request.getItems(ids, MEETING_FIELDS)), uid)
		: null;
	if (!found) throw new MailError('This meeting is no longer in your calendar.', 404);
	return found;
}
