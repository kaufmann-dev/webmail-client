import { goto, invalidate } from '$app/navigation';
import { resolve } from '$app/paths';
import { SvelteSet } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import type { ComposeState } from './mail-types';

/** A message as the editor last had it, with the files attached to it. */
export interface OutgoingMessage {
	state: ComposeState;
	files: File[];
}

/**
 * Refs of drafts being sent or discarded from the editor. Lists hide them at once, since the
 * draft is deleted only after the send finishes; a failure shows them again.
 */
export const leavingDrafts = new SvelteSet<string>();

/** Messages whose send failed, kept in memory until the editor reopens them. */
const failed = new Map<string, OutgoingMessage>();
let sending = 0;

function confirmUnload(event: BeforeUnloadEvent) {
	event.preventDefault();
}

/**
 * Follows a send that continues after the editor closed: shows its progress, asks before the tab
 * closes mid-send, and keeps a failed message so the error toast can reopen it. Call the returned
 * function with the outcome, and whether the draft the message came from is still there.
 */
export function followSend(
	message: OutgoingMessage
): (error: string | null, draftKept?: boolean) => void {
	const id = toast.loading('Sending…');
	const draftRef = message.state.replacesDraftRef;
	if (draftRef) leavingDrafts.add(draftRef);
	if (sending++ === 0) window.addEventListener('beforeunload', confirmUnload);
	return (error, draftKept = false) => {
		if (--sending === 0) window.removeEventListener('beforeunload', confirmUnload);
		if (!error) {
			const sent = message.state.meeting ? 'Invitation sent' : 'Message sent';
			if (draftKept && draftRef) leavingDrafts.delete(draftRef);
			toast.success(draftKept ? `${sent}, but its draft could not be deleted.` : sent, { id });
			invalidate('mail:list');
			return;
		}
		if (draftRef) leavingDrafts.delete(draftRef);
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
