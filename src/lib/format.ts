import type { Address } from './mail-types';

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat(undefined, {
	day: 'numeric',
	month: 'short',
	year: 'numeric'
});
const long = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Compact list date: time today, day and month this year, full date otherwise. */
export function listDate(iso: string, now = new Date()): string {
	const date = new Date(iso);
	if (date.toDateString() === now.toDateString()) return time.format(date);
	if (date.getFullYear() === now.getFullYear()) return dayMonth.format(date);
	return full.format(date);
}

export function longDate(iso: string): string {
	return long.format(new Date(iso));
}

export function senderName(address: Address | null): string {
	return address ? address.name || address.address : '(unknown sender)';
}

export function formatAddress(address: Address): string {
	return address.name ? `${address.name} <${address.address}>` : address.address;
}

export function fileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
