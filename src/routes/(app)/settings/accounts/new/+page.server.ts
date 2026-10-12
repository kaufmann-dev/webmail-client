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

const common = {
	email: z.email(),
	displayName: z.string().max(200).default(''),
	password: z.string().min(1).max(500)
};

const schema = z.discriminatedUnion('provider', [
	z.object({ provider: z.enum(['gmail', 'purelymail']), ...common }),
	z.object({
		provider: z.literal('exchange'),
		...common,
		// A host name (optionally with a port), without scheme or path.
		server: z
			.string()
			.trim()
			.toLowerCase()
			.regex(/^[a-z0-9.-]+(:\d{1,5})?$/),
		username: z.string().trim().max(200).default('')
	})
]);

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const form = Object.fromEntries(await request.formData());
		const parsed = schema.safeParse(form);
		const values = {
			provider: String(form.provider ?? ''),
			email: String(form.email ?? ''),
			displayName: String(form.displayName ?? ''),
			server: String(form.server ?? ''),
			username: String(form.username ?? '')
		};
		if (!parsed.success) {
			const error =
				values.provider === 'exchange'
					? 'Enter a valid email address, server host name, and password.'
					: 'Enter a valid email address and password.';
			return fail(400, { ...values, error });
		}
		const input = parsed.data;
		try {
			await createPasswordAccount(locals.user.id, {
				provider: input.provider,
				email: input.email,
				displayName: input.displayName,
				password: input.password,
				exchange:
					input.provider === 'exchange'
						? { server: input.server, username: input.username || null }
						: undefined
			});
		} catch (error) {
			if (error instanceof MailError)
				return fail(error.status, { ...values, error: error.message });
			throw error;
		}
		redirect(303, '/settings/accounts?connected=1');
	}
};
