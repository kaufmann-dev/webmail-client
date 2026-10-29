import type { BusyTime, MeetingTimes, TimeRange } from '../../mail-types';
import { MailError } from './errors';
import { availability } from './ews/calendar';
import { parseWallClock, zonedToUtc, type WallClock } from './time-zones';
import type { MailAccount } from './types';

export interface FreeTimeOptions {
	/** Busy times of each attendee whose calendar is known. */
	busy: BusyTime[][];
	/** First and last day, `YYYY-MM-DD`, in `timeZone`. */
	from: string;
	to: string;
	durationMinutes: number;
	timeZone: string;
	/** Working hours, `HH:MM` in `timeZone`. */
	workday: { start: string; end: string };
	/** Free time starts no earlier than this (now, rounded up to the next half hour). */
	notBefore: number;
}

const MINUTE = 60_000;
const HALF_HOUR = 30 * MINUTE;
const DAY = 24 * 60 * MINUTE;

const MAX_DAYS = 14;
const MAX_ATTENDEES = 20;

function day(value: string): WallClock {
	const time = parseWallClock(value);
	if (!time || value.length !== 10) throw new MailError(`Not a date: ${value}`, 400);
	return time;
}

function clock(date: WallClock, value: string): WallClock {
	const match = /^(\d{2}):(\d{2})$/.exec(value);
	if (!match || Number(match[1]) > 24 || Number(match[2]) > 59) {
		throw new MailError(`Not a time: ${value}`, 400);
	}
	return { ...date, hour: Number(match[1]), minute: Number(match[2]) };
}

/** The days from `from` to `to`, inclusive, as wall-clock dates. */
function days(from: string, to: string): WallClock[] {
	const first = day(from);
	const last = day(to);
	const result: WallClock[] = [];
	for (
		let ms = Date.UTC(first.year, first.month - 1, first.day);
		ms <= Date.UTC(last.year, last.month - 1, last.day);
		ms += DAY
	) {
		const date = new Date(ms);
		result.push({
			year: date.getUTCFullYear(),
			month: date.getUTCMonth() + 1,
			day: date.getUTCDate(),
			hour: 0,
			minute: 0,
			second: 0
		});
	}
	return result;
}

const isWeekend = (date: WallClock) =>
	[0, 6].includes(new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay());

/**
 * Periods in working hours on weekdays where every attendee with a known calendar is free for at
 * least the meeting's duration. Tentative times count as busy.
 */
export function freeTimes(options: FreeTimeOptions): TimeRange[] {
	const duration = options.durationMinutes * MINUTE;
	const busy = options.busy
		.flat()
		.map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
		.sort((a, b) => a[0] - b[0]);
	const earliest = Math.ceil(options.notBefore / HALF_HOUR) * HALF_HOUR;
	const free: TimeRange[] = [];
	for (const date of days(options.from, options.to)) {
		if (isWeekend(date)) continue;
		let cursor = Math.max(
			zonedToUtc(clock(date, options.workday.start), options.timeZone),
			earliest
		);
		const end = zonedToUtc(clock(date, options.workday.end), options.timeZone);
		const add = (until: number) => {
			if (until - cursor >= duration) {
				free.push({ start: new Date(cursor).toISOString(), end: new Date(until).toISOString() });
			}
		};
		for (const [start, stop] of busy) {
			if (stop <= cursor || start >= end) continue;
			add(Math.min(start, end));
			cursor = Math.max(cursor, stop);
		}
		add(end);
	}
	return free;
}

/** Busy times of the account and the attendees, and the free times that suit all of them. */
export async function findMeetingTimes(
	account: MailAccount,
	options: Omit<FreeTimeOptions, 'busy' | 'notBefore'> & { attendees: string[] }
): Promise<MeetingTimes> {
	if (account.provider !== 'exchange') {
		throw new MailError('Free times are only available for Exchange accounts.', 400);
	}
	const span = days(options.from, options.to);
	if (!span.length || span.length > MAX_DAYS) {
		throw new MailError(`Choose between 1 and ${MAX_DAYS} days.`, 400);
	}
	if (options.durationMinutes < 5 || options.durationMinutes > 24 * 60) {
		throw new MailError('Choose a duration between 5 minutes and 24 hours.', 400);
	}
	// Both are HH:MM, so they compare as text.
	if (options.workday.start >= options.workday.end) {
		throw new MailError('The workday must end after it starts.', 400);
	}
	const seen = new Set<string>();
	const addresses = [account.email, ...options.attendees].filter((address) => {
		const key = address.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	if (addresses.length > MAX_ATTENDEES + 1) {
		throw new MailError(`Check at most ${MAX_ATTENDEES} attendees at once.`, 400);
	}
	const start = zonedToUtc(span[0], options.timeZone);
	const last = span[span.length - 1];
	const end = zonedToUtc({ ...last, day: last.day + 1 }, options.timeZone);
	const attendees = await availability(
		account,
		addresses,
		new Date(start).toISOString(),
		new Date(end).toISOString()
	);
	const free = freeTimes({
		...options,
		busy: attendees.flatMap((a) => (a.busy ? [a.busy] : [])),
		notBefore: Date.now()
	});
	return { attendees, free };
}
