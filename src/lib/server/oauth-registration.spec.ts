import { describe, expect, it } from 'vitest';
import { withInferredApplicationType } from './oauth-registration';

describe('withInferredApplicationType', () => {
	it('treats loopback-only http redirects as a native app', () => {
		for (const uri of [
			'http://localhost:3334/callback',
			'http://127.0.0.1:8765/cb',
			'http://[::1]:9/cb'
		]) {
			expect(withInferredApplicationType({ redirect_uris: [uri] }).application_type).toBe('native');
		}
	});

	it('keeps web clients, explicit values, and mixed redirect sets unchanged', () => {
		const web = { redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };
		expect(withInferredApplicationType(web)).toBe(web);
		const explicit: Record<string, unknown> = {
			redirect_uris: ['http://localhost:1/cb'],
			application_type: 'web'
		};
		expect(withInferredApplicationType(explicit)).toBe(explicit);
		const mixed = { redirect_uris: ['http://localhost:1/cb', 'https://example.com/cb'] };
		expect(withInferredApplicationType(mixed)).toBe(mixed);
		expect(withInferredApplicationType({})).toEqual({});
	});
});
