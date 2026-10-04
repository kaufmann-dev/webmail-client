import { fail } from '@sveltejs/kit';
import {
	grantsFromForm,
	listConnectedApps,
	revokeConnectedApp,
	setClientAccess
} from '#lib/server/mcp/connected-apps.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
	apps: await listConnectedApps(locals.user.id)
});

function clientIdFrom(form: FormData) {
	const clientId = String(form.get('clientId') ?? '');
	return clientId || null;
}

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const form = await request.formData();
		const clientId = clientIdFrom(form);
		if (!clientId) return fail(400, { error: 'Unknown app.' });
		await setClientAccess(locals.user.id, clientId, grantsFromForm(form));
		return { saved: clientId };
	},
	revoke: async ({ request, locals }) => {
		const clientId = clientIdFrom(await request.formData());
		if (!clientId) return fail(400, { error: 'Unknown app.' });
		await revokeConnectedApp(locals.user.id, clientId);
		return { revoked: clientId };
	}
};
