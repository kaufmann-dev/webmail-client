import ICAL from 'ical.js';
import { describe, expect, it } from 'vitest';
import { MailError } from './errors';
import { findCalendarPart, invitationReply, parseInvitation } from './invitations';

const ics = (...lines: string[]) => lines.join('\r\n');

const GOOGLE = ics(
	'BEGIN:VCALENDAR',
	'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
	'VERSION:2.0',
	'METHOD:REQUEST',
	'BEGIN:VEVENT',
	'DTSTART:20261006T080000Z',
	'DTEND:20261006T090000Z',
	'RRULE:FREQ=WEEKLY;BYDAY=TU',
	'DTSTAMP:20261001T120000Z',
	'ORGANIZER;CN=Alex Organizer:mailto:alex@example.com',
	'UID:abc123@google.com',
	'ATTENDEE;PARTSTAT=ACCEPTED;CN=Alex Organizer:mailto:alex@example.com',
	'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=me@example.org:mailto:Me@Example.org',
	'SEQUENCE:2',
	'SUMMARY:Weekly sync',
	'LOCATION:Room 4',
	'END:VEVENT',
	'END:VCALENDAR'
);

const OUTLOOK = ics(
	'BEGIN:VCALENDAR',
	'METHOD:REQUEST',
	'PRODID:Microsoft Exchange Server 2010',
	'VERSION:2.0',
	'BEGIN:VTIMEZONE',
	'TZID:W. Europe Standard Time',
	'BEGIN:STANDARD',
	'DTSTART:16010101T030000',
	'TZOFFSETFROM:+0200',
	'TZOFFSETTO:+0100',
	'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
	'END:STANDARD',
	'BEGIN:DAYLIGHT',
	'DTSTART:16010101T020000',
	'TZOFFSETFROM:+0100',
	'TZOFFSETTO:+0200',
	'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
	'END:DAYLIGHT',
	'END:VTIMEZONE',
	'BEGIN:VEVENT',
	'ORGANIZER;CN=Prof. Smith:MAILTO:smith@uni.example',
	'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Student:mailto:me@uni.example',
	'SUMMARY;LANGUAGE=de-DE:Sprechstunde',
	'DTSTART;TZID=W. Europe Standard Time:20261006T100000',
	'DTEND;TZID=W. Europe Standard Time:20261006T110000',
	'UID:040000008200E00074C5B7101A82E008',
	'RECURRENCE-ID;TZID=W. Europe Standard Time:20261006T100000',
	'SEQUENCE:0',
	'DTSTAMP:20261001T090000Z',
	'LOCATION;LANGUAGE=de-DE:Raum 101',
	'END:VEVENT',
	'END:VCALENDAR'
);

function calendar(method: string, ...event: string[]) {
	return ics(
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		`METHOD:${method}`,
		'BEGIN:VEVENT',
		'UID:x@example.com',
		'DTSTAMP:20261001T000000Z',
		...event,
		'END:VEVENT',
		'END:VCALENDAR'
	);
}

describe('parseInvitation', () => {
	it('reads a Google invitation and the account’s own status', () => {
		expect(parseInvitation(GOOGLE, 'me@example.org')).toEqual({
			method: 'request',
			title: 'Weekly sync',
			start: '2026-10-06T08:00:00.000Z',
			end: '2026-10-06T09:00:00.000Z',
			allDay: false,
			location: 'Room 4',
			organizer: { name: 'Alex Organizer', address: 'alex@example.com' },
			recurring: true,
			attendees: [
				{ name: 'Alex Organizer', address: 'alex@example.com', status: 'accepted' },
				{ name: 'me@example.org', address: 'Me@Example.org', status: 'needs-action' }
			],
			ownStatus: 'needs-action'
		});
	});

	it('applies a VTIMEZONE from the same file', () => {
		const invitation = parseInvitation(OUTLOOK, 'someone@else.example');
		expect(invitation).toMatchObject({
			start: '2026-10-06T08:00:00.000Z',
			end: '2026-10-06T09:00:00.000Z',
			organizer: { name: 'Prof. Smith', address: 'smith@uni.example' },
			recurring: false,
			ownStatus: null
		});
	});

	it('converts IANA time zones without a VTIMEZONE and reads DURATION', () => {
		const invitation = parseInvitation(
			calendar('REQUEST', 'DTSTART;TZID=America/New_York:20260710T090000', 'DURATION:PT30M'),
			'me@example.org'
		);
		expect(invitation).toMatchObject({
			start: '2026-07-10T13:00:00.000Z',
			end: '2026-07-10T13:30:00.000Z'
		});
	});

	it('keeps all-day events as dates with an exclusive end', () => {
		expect(
			parseInvitation(
				calendar('PUBLISH', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261101'),
				'me@example.org'
			)
		).toMatchObject({ method: 'other', allDay: true, start: '2026-10-30', end: '2026-11-01' });
		expect(
			parseInvitation(calendar('REQUEST', 'DTSTART;VALUE=DATE:20261031'), 'me@example.org')
		).toMatchObject({ start: '2026-10-31', end: '2026-11-01' });
	});

	it('recognizes cancellations', () => {
		const cancelled = calendar('CANCEL', 'DTSTART:20261006T080000Z', 'STATUS:CANCELLED');
		expect(parseInvitation(cancelled, 'me@example.org')?.method).toBe('cancel');
	});

	it('returns null for unreadable calendars', () => {
		expect(parseInvitation('not a calendar', 'me@example.org')).toBeNull();
		expect(
			parseInvitation(ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'END:VCALENDAR'), 'me@example.org')
		).toBeNull();
	});
});

describe('invitationReply', () => {
	const now = new Date('2026-10-02T10:00:00Z');

	it('answers with only the attendee’s own status', () => {
		const reply = invitationReply(
			OUTLOOK,
			{ name: 'Student', address: 'me@uni.example' },
			'tentative',
			now
		);
		expect(reply.organizer).toEqual({ name: 'Prof. Smith', address: 'smith@uni.example' });
		expect(reply.subject).toBe('Tentatively accepted: Sprechstunde');
		expect(reply.text).toBe('Student has tentatively accepted this invitation.');

		const parsed = new ICAL.Component(ICAL.parse(reply.ics));
		expect(parsed.getFirstPropertyValue('method')).toBe('REPLY');
		expect(parsed.getAllSubcomponents('vtimezone')).toHaveLength(1);
		const event = parsed.getFirstSubcomponent('vevent')!;
		expect(event.getFirstPropertyValue('uid')).toBe('040000008200E00074C5B7101A82E008');
		expect(event.getFirstPropertyValue('sequence')).toBe(0);
		expect(event.getFirstProperty('recurrence-id')?.getParameter('tzid')).toBe(
			'W. Europe Standard Time'
		);
		expect(String(event.getFirstPropertyValue('dtstamp'))).toBe('2026-10-02T10:00:00Z');
		const attendees = event.getAllProperties('attendee');
		expect(attendees).toHaveLength(1);
		expect(attendees[0].getFirstValue()).toBe('mailto:me@uni.example');
		expect(attendees[0].getParameter('partstat')).toBe('TENTATIVE');
		expect(attendees[0].getParameter('rsvp')).toBeUndefined();
	});

	it('adds the attendee when the invitation does not list it', () => {
		const reply = invitationReply(
			GOOGLE,
			{ name: 'Other', address: 'other@example.org' },
			'accepted',
			now
		);
		expect(reply.subject).toBe('Accepted: Weekly sync');
		const event = new ICAL.Component(ICAL.parse(reply.ics)).getFirstSubcomponent('vevent')!;
		const [attendee] = event.getAllProperties('attendee');
		expect(attendee.getFirstValue()).toBe('mailto:other@example.org');
		expect(attendee.getParameter('cn')).toBe('Other');
		expect(attendee.getParameter('partstat')).toBe('ACCEPTED');
		expect(event.getFirstPropertyValue('sequence')).toBe(2);
	});

	it('refuses anything but an invitation with an organizer', () => {
		const me = { name: '', address: 'me@example.org' };
		const cancelled = calendar('CANCEL', 'DTSTART:20261006T080000Z');
		expect(() => invitationReply(cancelled, me, 'declined')).toThrow(MailError);
		const anonymous = calendar('REQUEST', 'DTSTART:20261006T080000Z');
		expect(() => invitationReply(anonymous, me, 'declined')).toThrow(/no organizer/);
	});
});

describe('findCalendarPart', () => {
	it('prefers the text/calendar alternative and skips oversized parts', () => {
		const ics = { contentType: 'application/ics', content: Buffer.from('ics file') };
		const alternative = { contentType: 'text/calendar', content: Buffer.from('alternative') };
		const huge = { contentType: 'text/calendar', content: Buffer.alloc(1024 * 1024 + 1) };
		expect(findCalendarPart([ics, alternative])).toBe('alternative');
		expect(findCalendarPart([huge, ics])).toBe('ics file');
		expect(findCalendarPart([{ contentType: 'image/png', content: Buffer.from('x') }])).toBeNull();
	});
});
