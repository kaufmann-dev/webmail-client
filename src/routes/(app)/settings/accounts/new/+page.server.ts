import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { createPasswordAccount } from '#lib/server/mail/accounts.js';
import { microsoftConfigured } from '#lib/server/env.js';
import { MailError } from '#lib/server/mail/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => ({
	microsoftAvailable: microsoftConfigured(),
	microsoftError: url.searchParams.get('error')
});

const schema = z.object({
	provider: z.enum(['gmail', 'purelymail']),
	email: z.email(),
	displayName: z.string().max(200).default(''),
	password: z.string().min(1).max(500)
});

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const form = Object.fromEntries(await request.formData());
		const parsed = schema.safeParse(form);
		const values = {
			provider: String(form.provider ?? ''),
			email: String(form.email ?? ''),
			displayName: String(form.displayName ?? '')
		};
		if (!parsed.success) {
			return fail(400, { ...values, error: 'Enter a valid email address and password.' });
		}
		try {
			await createPasswordAccount(locals.user.id, parsed.data);
		} catch (error) {
			if (error instanceof MailError)
				return fail(error.status, { ...values, error: error.message });
			throw error;
		}
		redirect(303, '/settings/accounts?connected=1');
	}
};
