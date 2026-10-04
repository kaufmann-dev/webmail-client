import { describe, expect, it } from 'vitest';
import { isForbiddenCrossSiteForm } from './csrf';

const url = (path: string) => new URL(`https://mail.example.com${path}`);
const post = (headers: Record<string, string>) =>
	new Request('https://x.test', { method: 'POST', headers });
const form = { 'content-type': 'application/x-www-form-urlencoded' };

describe('isForbiddenCrossSiteForm', () => {
	it('blocks cross-site and origin-less form posts to app routes', () => {
		expect(
			isForbiddenCrossSiteForm(post({ ...form, origin: 'https://evil.test' }), url('/?/create'))
		).toBe(true);
		expect(isForbiddenCrossSiteForm(post(form), url('/settings?/revoke'))).toBe(true);
	});

	it('allows same-origin forms, JSON, and OAuth token requests', () => {
		expect(
			isForbiddenCrossSiteForm(
				post({ ...form, origin: 'https://mail.example.com' }),
				url('/?/create')
			)
		).toBe(false);
		expect(
			isForbiddenCrossSiteForm(post({ 'content-type': 'application/json' }), url('/mcp'))
		).toBe(false);
		expect(isForbiddenCrossSiteForm(post(form), url('/api/auth/oauth2/token'))).toBe(false);
	});
});
