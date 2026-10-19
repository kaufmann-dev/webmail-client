import { describe, expect, it } from 'vitest';
import { freeTimes } from './availability';

const busy = (start: string, end: string, tentative = false) => ({ start, end, tentative });

const base = {
	durationMinutes: 30,
	timeZone: 'Europe/Vienna',
	workday: { start: '08:00', end: '18:00' },
	notBefore: 0
};

describe('freeTimes', () => {
	it('leaves out busy and tentative times of every attendee', () => {
		// Tuesday 2026-10-20, Vienna is UTC+2.
		expect(
			freeTimes({
				...base,
				from: '2026-10-20',
				to: '2026-10-20',
				busy: [
					[busy('2026-10-20T07:00:00Z', '2026-10-20T08:00:00Z')],
					[
						busy('2026-10-20T07:30:00Z', '2026-10-20T09:00:00Z', true),
						busy('2026-10-20T09:10:00Z', '2026-10-20T14:00:00Z')
					]
				]
			})
		).toEqual([
			{ start: '2026-10-20T06:00:00.000Z', end: '2026-10-20T07:00:00.000Z' },
			{ start: '2026-10-20T14:00:00.000Z', end: '2026-10-20T16:00:00.000Z' }
		]);
	});

	it('skips weekends, gaps shorter than the meeting, and the past', () => {
		expect(
			freeTimes({
				...base,
				durationMinutes: 60,
				// Friday to Monday; Vienna is UTC+1 from 2026-10-25.
				from: '2026-10-23',
				to: '2026-10-26',
				busy: [[busy('2026-10-23T06:30:00Z', '2026-10-23T16:00:00Z')]],
				notBefore: Date.parse('2026-10-26T08:10:00Z')
			})
		).toEqual([{ start: '2026-10-26T08:30:00.000Z', end: '2026-10-26T17:00:00.000Z' }]);
	});
});
