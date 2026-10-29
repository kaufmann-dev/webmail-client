import { deserialize } from '$app/forms';

/** The outcome of `postAction`: an error message for the user, or the action's data. */
export type ActionOutcome =
	{ error: string; data: null } | { error: null; data: Record<string, unknown> };

/**
 * Posts to a form action without a `<form>`, for work the UI has already shown as done.
 * Resolves to an error message for the user, or to the action's data on success.
 */
export async function postAction(
	url: string,
	fields: Record<string, string | string[]>
): Promise<ActionOutcome> {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) {
		for (const item of [value].flat()) body.append(name, item);
	}
	try {
		const response = await fetch(url, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		if (result.type === 'success') return { error: null, data: result.data ?? {} };
		if (result.type === 'failure' && typeof result.data?.error === 'string') {
			return { error: result.data.error, data: null };
		}
	} catch {
		// Network failures and unreadable responses get the generic message.
	}
	return { error: 'The action failed.', data: null };
}
