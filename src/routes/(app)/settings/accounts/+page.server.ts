import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { ACCOUNT_COLORS } from '#lib/mail-types.js';
import { deleteAccount, moveAccount, updateAccount } from '#lib/server/mail/accounts.js';
import { MailError } from '#lib/server/mail/errors.js';
import type { Actions } from './$types';

const updateSchema = z.object({
	id: z.string().min(1),
	label: z.string().max(100),
	displayName: z.string().max(200),
	color: z.enum(ACCOUNT_COLORS),
	signature: z.string().max(5000),
	password: z.string().max(500).optional()
});

async function guard(id: string, fn: () => Promise<void>) {
	try {
		await fn();
		return { ok: id };
	} catch (error) {
		if (error instanceof MailError) return fail(error.status, { id, error: error.message });
		throw error;
	}
}

export const actions: Actions = {
	update: async ({ request, locals }) => {
		const parsed = updateSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { id: '', error: 'Check the highlighted fields.' });
		const { id, password, ...fields } = parsed.data;
		return guard(id, () =>
			updateAccount(locals.user.id, id, { ...fields, password: password || undefined })
		);
	},
	delete: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		return guard(id, () => deleteAccount(locals.user.id, id));
	},
	move: async ({ request, locals }) => {
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		return guard(id, () =>
			moveAccount(locals.user.id, id, form.get('direction') === 'up' ? -1 : 1)
		);
	}
};
