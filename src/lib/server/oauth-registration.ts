/**
 * MCP CLI clients (Claude Code, Codex, …) register `http://localhost:<port>/callback` redirects
 * without `application_type`, which OpenID Dynamic Client Registration defaults to `web`, and web
 * clients may not use loopback redirects. RFC 8252 §7.3 defines loopback redirects as the native-app
 * pattern, so such registrations are treated as `native`. Explicit values are kept.
 */
export function withInferredApplicationType(
	body: Record<string, unknown>
): Record<string, unknown> {
	if (body.application_type !== undefined) return body;
	const uris = body.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0 || !uris.every(isHttpLoopback)) return body;
	return { ...body, application_type: 'native' };
}

function isHttpLoopback(uri: unknown): boolean {
	if (typeof uri !== 'string') return false;
	try {
		const url = new URL(uri);
		return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	} catch {
		return false;
	}
}
