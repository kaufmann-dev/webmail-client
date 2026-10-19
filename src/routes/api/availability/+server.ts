import { error, json } from '@sveltejs/kit';
import { getAccount } from '#lib/server/mail/accounts.js';
import { parseAddressList } from '#lib/server/mail/addresses.js';
import { findMeetingTimes } from '#lib/server/mail/availability.js';
import { MailError } from '#lib/server/mail/errors.js';
import { isTimeZone } from '#lib/server/mail/time-zones.js';
import type { RequestHandler } from './$types';

/** Busy and free times for one day of a meeting in the compose form (Exchange accounts). */
export const GET: RequestHandler = async ({ url, locals }) => {
	const params = url.searchParams;
	const date = params.get('date') ?? '';
	const timeZone = params.get('tz') ?? '';
	if (!isTimeZone(timeZone)) error(400, 'Unknown time zone.');
	try {
		const account = await getAccount(locals.user.id, params.get('account') ?? '');
		return json(
			await findMeetingTimes(account, {
				attendees: parseAddressList(
					[params.get('to') ?? '', params.get('cc') ?? ''].filter((v) => v.trim())
				).map((a) => a.address),
				from: date,
				to: date,
				durationMinutes: Number(params.get('duration')),
				timeZone,
				workday: { start: '08:00', end: '18:00' }
			})
		);
	} catch (e) {
		if (e instanceof MailError) error(e.status, e.message);
		throw e;
	}
};
