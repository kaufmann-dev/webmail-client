/** Wall-clock times in IANA time zones, converted with `Intl` alone. */

export interface WallClock {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

export function isTimeZone(name: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: name });
		return true;
	} catch {
		return false;
	}
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string): Intl.DateTimeFormat {
	let cached = formats.get(timeZone);
	if (!cached) {
		cached = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: 'numeric',
			day: 'numeric',
			hour: 'numeric',
			minute: 'numeric',
			second: 'numeric'
		});
		formats.set(timeZone, cached);
	}
	return cached;
}

/** The wall-clock time in `timeZone` at a UTC instant. */
export function wallClockAt(ms: number, timeZone: string): WallClock {
	const parts = Object.fromEntries(
		format(timeZone)
			.formatToParts(ms)
			.map((p) => [p.type, Number(p.value)])
	);
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: parts.hour,
		minute: parts.minute,
		second: parts.second
	};
}

const wallMs = (t: WallClock) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);

/** UTC milliseconds of a wall-clock time in an IANA time zone. */
export function zonedToUtc(time: WallClock, timeZone: string): number {
	const offsetAt = (ms: number) => wallMs(wallClockAt(ms, timeZone)) - ms;
	const wall = wallMs(time);
	// The second pass corrects the offset when the first guess lands across a DST change.
	return wall - offsetAt(wall - offsetAt(wall));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DDTHH:MM` in `timeZone`. */
export function formatWallClock(ms: number, timeZone: string): string {
	const t = wallClockAt(ms, timeZone);
	return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`;
}

/** Reads `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; null when malformed. */
export function parseWallClock(value: string): WallClock | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
	if (!match) return null;
	const [year, month, day, hour, minute] = match.slice(1).map((n) => Number(n ?? 0));
	const time = { year, month, day, hour, minute, second: 0 };
	// Rejects impossible dates such as 2026-02-30 or 25:00.
	const check = new Date(wallMs(time));
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		hour > 23 ||
		minute > 59
	) {
		return null;
	}
	return time;
}
