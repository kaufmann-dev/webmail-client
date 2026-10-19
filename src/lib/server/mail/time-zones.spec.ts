import { describe, expect, it } from 'vitest';
import { formatWallClock, isTimeZone, parseWallClock, zonedToUtc } from './time-zones';

describe('time zones', () => {
	it('converts wall-clock times across daylight saving changes', () => {
		const summer = parseWallClock('2026-07-10T09:00')!;
		const winter = parseWallClock('2026-12-10T09:00')!;
		expect(new Date(zonedToUtc(summer, 'Europe/Vienna')).toISOString()).toBe(
			'2026-07-10T07:00:00.000Z'
		);
		expect(new Date(zonedToUtc(winter, 'Europe/Vienna')).toISOString()).toBe(
			'2026-12-10T08:00:00.000Z'
		);
		expect(formatWallClock(Date.parse('2026-07-10T07:00:00Z'), 'Europe/Vienna')).toBe(
			'2026-07-10T09:00'
		);
	});

	it('rejects malformed values', () => {
		expect(parseWallClock('2026-02-30T09:00')).toBeNull();
		expect(parseWallClock('2026-02-10T24:00')).toBeNull();
		expect(parseWallClock('10.02.2026')).toBeNull();
		expect(parseWallClock('2026-02-10')).toMatchObject({ day: 10, hour: 0 });
		expect(isTimeZone('Europe/Vienna')).toBe(true);
		expect(isTimeZone('Mars/Base')).toBe(false);
	});
});
