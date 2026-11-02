import type { Address, AttendeeStatus, MailboxAvailability } from '../../../mail-types';
import { bodyText } from '../body-text';
import type { CalendarEvent, EventAttendee, EventDetail, ShowAs } from '../calendar';
import { MailError, MessageGoneError } from '../errors';
import type { MailAccount } from '../types';
import { check, ewsCall, ewsOperation, failed } from './client';
import { dateOrNull, firstItem, itemId, itemsOf, mailboxes } from './items';
import { resolveAddresses } from './messages';
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

/** Answers Exchange records, in `MyResponseType` and in each attendee's `ResponseType`. */
const ANSWERS: Record<string, AttendeeStatus> = {
	Accept: 'accepted',
	Tentative: 'tentative',
	Decline: 'declined'
};

const SHOW_AS: Record<string, ShowAs> = {
	Free: 'free',
	Tentative: 'tentative',
	Busy: 'busy',
	OOF: 'away',
	WorkingElsewhere: 'elsewhere'
};

const instant = (value: string) => (dateOrNull(value) ?? new Date(0)).toISOString();

/**
 * A calendar item as listed. A meeting is the user's own when they organize it; otherwise it
 * carries the organizer and the user's answer. Appointments without attendees have neither.
 */
export function eventOf(accountId: string, node: XmlNode): CalendarEvent {
	const meeting = text(node.IsMeeting) === 'true';
	const response = text(node.MyResponseType);
	const organizedByYou = meeting && response === 'Organizer';
	const invited = meeting && !organizedByYou;
	return {
		id: itemId(node),
		accountId,
		title: text(node.Subject),
		start: instant(text(node.Start)),
		end: instant(text(node.End)),
		allDay: text(node.IsAllDayEvent) === 'true',
		location: text(node.Location) || null,
		organizer: invited ? (mailboxes(child(node, 'Organizer'))[0] ?? null) : null,
		organizedByYou,
		ownStatus: invited ? (ANSWERS[response] ?? 'needs-action') : null,
		recurring: ['Occurrence', 'Exception'].includes(text(node.CalendarItemType)),
		canceled: text(node.IsCancelled) === 'true',
		showAs: SHOW_AS[text(node.LegacyFreeBusyStatus)] ?? 'busy'
	};
}

const ATTENDEE_LISTS = [
	['RequiredAttendees', 'required'],
	['OptionalAttendees', 'optional'],
	['Resources', 'resource']
] as const;

/**
 * A calendar item with its attendees. Their answers are known only on the organizer's item;
 * everything but an accept, tentative, or decline there counts as no answer yet.
 */
export function eventDetailOf(accountId: string, node: XmlNode): EventDetail {
	const event = eventOf(accountId, node);
	const attendees = ATTENDEE_LISTS.flatMap(([element, role]) =>
		list(child(node, element)?.Attendee).flatMap((attendee): EventAttendee[] => {
			const response = text(attendee.ResponseType);
			const [address] = mailboxes(attendee);
			if (!address || response === 'Organizer') return [];
			const status = event.organizedByYou ? (ANSWERS[response] ?? 'needs-action') : null;
			const replied = status && status !== 'needs-action';
			return [
				{
					...address,
					role,
					status,
					repliedAt: replied
						? (dateOrNull(text(attendee.LastResponseTime))?.toISOString() ?? null)
						: null
				}
			];
		})
	);
	const body = text(node.Body);
	return {
		...event,
		attendees,
		description: body ? bodyText({ html: body, text: '', subject: event.title }).text : ''
	};
}

/** Calendar view entries per request; more are left for the next call. */
const MAX_EVENTS = 250;
const GET_BATCH = 100;

/**
 * The events overlapping a time span (ISO instants), recurring meetings as single occurrences.
 * `complete` is false when the view held more than it returned.
 */
export async function listEvents(
	account: MailAccount,
	start: string,
	end: string
): Promise<{ events: CalendarEvent[]; complete: boolean }> {
	const [view] = await ewsCall(account, request.calendarView(start, end, MAX_EVENTS));
	const root = child(check(view), 'RootFolder');
	const ids = itemsOf(child(root, 'Items')).map(({ node }) => itemId(node));
	const events: CalendarEvent[] = [];
	for (let i = 0; i < ids.length; i += GET_BATCH) {
		const messages = await ewsCall(
			account,
			request.getItems(ids.slice(i, i + GET_BATCH), request.EVENT_FIELDS)
		);
		for (const message of messages) {
			// An item deleted since the view was taken is left out.
			const node = failed(message) ? null : firstItem(message)?.node;
			if (node) events.push(eventOf(account.id, node));
		}
	}
	await resolveAddresses(
		account,
		events.map((event) => event.organizer)
	);
	return { events, complete: attr(root, 'IncludesLastItemInRange') !== 'false' };
}

const EVENT_GONE = 'This event is no longer in your calendar.';

/** One calendar item with its attendees and description. */
export async function getEvent(account: MailAccount, id: string): Promise<EventDetail> {
	const [message] = await ewsCall(
		account,
		request.getItems([id], request.EVENT_DETAIL_FIELDS, { body: true })
	);
	let node: XmlNode | undefined;
	try {
		node = firstItem(check(message))?.node;
	} catch (error) {
		if (error instanceof MessageGoneError) throw new MailError(EVENT_GONE, 404);
		throw error;
	}
	if (!node) throw new MailError(EVENT_GONE, 404);
	const event = eventDetailOf(account.id, node);
	await resolveAddresses(account, [event.organizer, ...event.attendees]);
	return event;
}
