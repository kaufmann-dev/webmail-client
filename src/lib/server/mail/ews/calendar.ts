import type { MailboxAvailability } from '../../../mail-types';
import type { MailAccount } from '../types';
import { ewsOperation } from './client';
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
