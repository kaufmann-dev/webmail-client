import type { Address, AttendeeStatus } from '../../mail-types';
import { day } from './availability';
import { MailError } from './errors';
import * as ews from './ews/calendar';
import { zonedToUtc } from './time-zones';
import type { MailAccount } from './types';

/** Calendar events of Exchange accounts, read-only; IMAP accounts have no calendar. */

export type ShowAs = 'free' | 'tentative' | 'busy' | 'away' | 'elsewhere';

export interface CalendarEvent {
	/** The provider's item ID; recurring meetings have one per occurrence. */
	id: string;
	accountId: string;
	title: string;
	/** ISO instants; all-day events run from midnight to midnight in their calendar's zone. */
	start: string;
	end: string;
	allDay: boolean;
	location: string | null;
	/** Who organizes a meeting the user is invited to. */
	organizer: Address | null;
	/** A meeting the user organizes. */
	organizedByYou: boolean;
	/** The user's answer to a meeting they are invited to. */
	ownStatus: AttendeeStatus | null;
	/** An occurrence of a recurring meeting. */
	recurring: boolean;
	canceled: boolean;
	showAs: ShowAs;
}

export interface EventAttendee extends Address {
	role: 'required' | 'optional' | 'resource';
	/** The attendee's current answer; only known for meetings the user organizes. */
	status: AttendeeStatus | null;
	/** When the answer arrived (ISO). */
	repliedAt: string | null;
}

export interface EventDetail extends CalendarEvent {
	attendees: EventAttendee[];
	/** The description as plain text. */
	description: string;
}

const MAX_DAYS = 92;
const DAY_MS = 24 * 60 * 60_000;

function requireExchange(account: MailAccount): void {
	if (account.provider !== 'exchange') {
		throw new MailError('Calendars are only available for Exchange accounts.', 400);
	}
}

/**
 * The events between two days (inclusive) in a time zone, in order of start. With `notBefore`,
 * only events starting from then on. `complete` is false when more events were left out.
 */
export async function listEvents(
	account: MailAccount,
	options: { from: string; to: string; timeZone: string; notBefore?: Date | null }
): Promise<{ events: CalendarEvent[]; complete: boolean }> {
	requireExchange(account);
	const first = day(options.from);
	const last = day(options.to);
	const start = zonedToUtc(first, options.timeZone);
	const end = zonedToUtc({ ...last, day: last.day + 1 }, options.timeZone);
	const days =
		Math.round(
			(Date.UTC(last.year, last.month - 1, last.day) -
				Date.UTC(first.year, first.month - 1, first.day)) /
				DAY_MS
		) + 1;
	if (days < 1 || days > MAX_DAYS) {
		throw new MailError(`Choose between 1 and ${MAX_DAYS} days.`, 400);
	}
	const notBefore = options.notBefore?.getTime() ?? -Infinity;
	if (end <= notBefore) return { events: [], complete: true };
	const { events, complete } = await ews.listEvents(
		account,
		new Date(Math.max(start, notBefore)).toISOString(),
		new Date(end).toISOString()
	);
	return {
		events: events
			.filter((event) => Date.parse(event.start) >= notBefore)
			.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
		complete
	};
}

/** One event with its attendees and description. */
export async function getEvent(account: MailAccount, id: string): Promise<EventDetail> {
	requireExchange(account);
	return ews.getEvent(account, id);
}
