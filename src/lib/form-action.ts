import { deserialize } from '$app/forms';

/**
 * Posts to a form action without a `<form>`, for work the UI has already shown as done.
 * Resolves to an error message for the user, or null on success.
 */
export async function postAction(
	url: string,
	fields: Record<string, string | string[]>
): Promise<string | null> {
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
		if (result.type === 'success') return null;
		if (result.type === 'failure' && typeof result.data?.error === 'string') {
			return result.data.error;
		}
	} catch {
		// Network failures and unreadable responses get the generic message.
	}
	return 'The action failed.';
}
