import { goto, invalidate } from '$app/navigation';
import { resolve } from '$app/paths';
import { toast } from 'svelte-sonner';
import type { ComposeState } from './mail-types';

/** A message as the editor last had it, with the files attached to it. */
export interface OutgoingMessage {
	state: ComposeState;
	files: File[];
}

/** Messages whose send failed, kept in memory until the editor reopens them. */
const failed = new Map<string, OutgoingMessage>();
let sending = 0;

function confirmUnload(event: BeforeUnloadEvent) {
	event.preventDefault();
}

/**
 * Follows a send that continues after the editor closed: shows its progress, asks before the tab
 * closes mid-send, and keeps a failed message so the error toast can reopen it. Call the returned
 * function with the outcome.
 */
export function followSend(message: OutgoingMessage): (error: string | null) => void {
	const id = toast.loading('Sending…');
	if (sending++ === 0) window.addEventListener('beforeunload', confirmUnload);
	return (error) => {
		if (--sending === 0) window.removeEventListener('beforeunload', confirmUnload);
		if (!error) {
			toast.success('Message sent', { id });
			invalidate('mail:list');
			return;
		}
		const key = crypto.randomUUID();
		failed.set(key, message);
		toast.error(error, {
			id,
			duration: Number.POSITIVE_INFINITY,
			closeButton: true,
			action: {
				label: 'Edit',
				onClick: () => goto(`${resolve('/(app)/compose')}?${new URLSearchParams({ unsent: key })}`)
			}
		});
	};
}

/** The failed message a compose URL (`?unsent=`) reopens; each reopens once. */
export function takeUnsent(key: string | null): OutgoingMessage | undefined {
	const message = key ? failed.get(key) : undefined;
	if (key) failed.delete(key);
	return message;
}
