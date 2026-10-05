import ICAL from 'ical.js';
import type { Attachment } from 'mailparser';
import type {
	Address,
	Attendee,
	AttendeeStatus,
	Invitation,
	InvitationResponse
} from '../../mail-types';
import { MailError } from './errors';

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;

const PRODID = '-//kaufmann.dev//Mail//EN';
const MAX_CALENDAR_BYTES = 1024 * 1024;

const METHODS: Record<string, Invitation['method']> = {
	REQUEST: 'request',
	CANCEL: 'cancel',
	REPLY: 'reply'
};

const STATUSES: Record<string, AttendeeStatus> = {
	'NEEDS-ACTION': 'needs-action',
	ACCEPTED: 'accepted',
	TENTATIVE: 'tentative',
	DECLINED: 'declined',
	DELEGATED: 'delegated'
};

const RESPONSE_WORDS: Record<InvitationResponse, { subject: string; verb: string }> = {
	accepted: { subject: 'Accepted', verb: 'accepted' },
	tentative: { subject: 'Tentatively accepted', verb: 'tentatively accepted' },
	declined: { subject: 'Declined', verb: 'declined' }
};

/** Whether a parsed MIME part holds iCalendar data. */
export function isCalendarPart(part: Pick<Attachment, 'contentType'>): boolean {
	const type = part.contentType.toLowerCase();
	return type === 'text/calendar' || type === 'application/ics';
}

/** A message's iCalendar text, preferring the `text/calendar` alternative over `.ics` files. */
export function findCalendarPart(
	attachments: Pick<Attachment, 'contentType' | 'content'>[]
): string | null {
	const parts = attachments.filter(
		(part) => isCalendarPart(part) && part.content.length <= MAX_CALENDAR_BYTES
	);
	const part = parts.find((p) => p.contentType.toLowerCase() === 'text/calendar') ?? parts[0];
	return part ? part.content.toString('utf8') : null;
}

/** The calendar and its main event: the first one that is not an exception of a series. */
function load(ics: string): { calendar: Component; event: Component } | null {
	try {
		const calendar = new ICAL.Component(ICAL.parse(ics));
		if (calendar.name !== 'vcalendar') return null;
		const events = calendar.getAllSubcomponents('vevent');
		const event = events.find((e) => !e.hasProperty('recurrence-id')) ?? events[0];
		return event?.hasProperty('dtstart') ? { calendar, event } : null;
	} catch {
		return null;
	}
}

function method(calendar: Component): string {
	return String(calendar.getFirstPropertyValue('method') ?? '').toUpperCase();
}

function text(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function calAddress(property: Property | null): Address | null {
	const value = property?.getFirstValue();
	if (!property || typeof value !== 'string' || !/^mailto:/i.test(value)) return null;
	const address = value.replace(/^mailto:/i, '').trim();
	const name = property.getParameter('cn');
	return address ? { name: typeof name === 'string' ? name : '', address } : null;
}

function partstat(property: Property): AttendeeStatus {
	const value = property.getParameter('partstat');
	return (typeof value === 'string' && STATUSES[value.toUpperCase()]) || 'needs-action';
}

const pad = (n: number) => String(n).padStart(2, '0');

function isTimeZone(name: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

/** UTC milliseconds of a wall-clock time in an IANA time zone. */
function zonedToUtc(time: Time, timeZone: string): number {
	const format = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric'
	});
	const offsetAt = (ms: number) => {
		const parts = Object.fromEntries(
			format.formatToParts(ms).map((p) => [p.type, Number(p.value)])
		);
		const wall = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second
		);
		return wall - ms;
	};
	const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
	// The second pass corrects the offset when the first guess lands across a DST change.
	return wall - offsetAt(wall - offsetAt(wall));
}

/**
 * The instant of a date-time. ical.js applies UTC and VTIMEZONEs from the same file; an IANA TZID
 * without a VTIMEZONE is converted here, and anything else is read as UTC.
 */
function instant(time: Time, tzid: unknown): string {
	if (time.zone === ICAL.Timezone.localTimezone && typeof tzid === 'string' && isTimeZone(tzid)) {
		return new Date(zonedToUtc(time, tzid)).toISOString();
	}
	return new Date(time.toUnixTime() * 1000).toISOString();
}

function when(event: Component): Pick<Invitation, 'start' | 'end' | 'allDay'> {
	const { startDate, endDate } = new ICAL.Event(event);
	if (startDate.isDate) {
		const day = (t: Time) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
		return { allDay: true, start: day(startDate), end: day(endDate) };
	}
	const tzid = (name: string) => event.getFirstProperty(name)?.getParameter('tzid');
	const start = instant(startDate, tzid('dtstart'));
	const end = instant(endDate, tzid(event.hasProperty('dtend') ? 'dtend' : 'dtstart'));
	return { allDay: false, start, end: end === start ? null : end };
}

/** The invitation in iCalendar text, as seen by the receiving address; null if it is unreadable. */
export function parseInvitation(ics: string, ownAddress: string): Invitation | null {
	const loaded = load(ics);
	if (!loaded) return null;
	const { calendar, event } = loaded;
	try {
		const attendees = event.getAllProperties('attendee').flatMap((property): Attendee[] => {
			const address = calAddress(property);
			return address ? [{ ...address, status: partstat(property) }] : [];
		});
		const own = ownAddress.toLowerCase();
		return {
			method: METHODS[method(calendar)] ?? 'other',
			title: text(event.getFirstPropertyValue('summary')) ?? '',
			...when(event),
			location: text(event.getFirstPropertyValue('location')),
			organizer: calAddress(event.getFirstProperty('organizer')),
			recurring: event.hasProperty('rrule') || event.hasProperty('rdate'),
			attendees,
			ownStatus: attendees.find((a) => a.address.toLowerCase() === own)?.status ?? null
		};
	} catch {
		return null;
	}
}

const copy = (property: Property) => new ICAL.Property(structuredClone(property.toJSON()));

/**
 * An iMIP reply (RFC 5546 §3.2.3) answering an invitation as `attendee`, with the email's subject
 * and text. Only the attendee's own answer is included.
 */
export function invitationReply(
	ics: string,
	attendee: Address,
	response: InvitationResponse,
	now = new Date()
): { organizer: Address; subject: string; text: string; ics: string } {
	const loaded = load(ics);
	if (!loaded) throw new MailError('This invitation could not be read.', 400);
	const { calendar, event } = loaded;
	if (method(calendar) !== 'REQUEST') throw new MailError('Only invitations can be answered.', 400);
	const organizer = calAddress(event.getFirstProperty('organizer'));
	if (!organizer) throw new MailError('This invitation has no organizer to answer.', 400);

	const reply = new ICAL.Component('vcalendar');
	reply.addPropertyWithValue('prodid', PRODID);
	reply.addPropertyWithValue('version', '2.0');
	reply.addPropertyWithValue('method', 'REPLY');
	for (const zone of calendar.getAllSubcomponents('vtimezone')) {
		reply.addSubcomponent(new ICAL.Component(structuredClone(zone.toJSON())));
	}
	const answer = new ICAL.Component('vevent');
	for (const name of ['uid', 'sequence', 'recurrence-id', 'summary', 'organizer']) {
		const property = event.getFirstProperty(name);
		if (property) answer.addProperty(copy(property));
	}
	answer.addPropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now, true));

	const own = attendee.address.toLowerCase();
	const listed = event
		.getAllProperties('attendee')
		.find((property) => calAddress(property)?.address.toLowerCase() === own);
	const property = listed ? copy(listed) : new ICAL.Property('attendee');
	if (!listed) {
		property.setValue(`mailto:${attendee.address}`);
		if (attendee.name) property.setParameter('cn', attendee.name);
	}
	property.setParameter('partstat', response.toUpperCase());
	property.removeParameter('rsvp');
	answer.addProperty(property);
	reply.addSubcomponent(answer);

	const title = text(event.getFirstPropertyValue('summary')) ?? '(no title)';
	const words = RESPONSE_WORDS[response];
	return {
		organizer,
		subject: `${words.subject}: ${title}`,
		text: `${attendee.name || attendee.address} has ${words.verb} this invitation.`,
		ics: reply.toString()
	};
}
