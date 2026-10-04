const FORM_CONTENT_TYPES = [
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
];
const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * SvelteKit's built-in CSRF check, minus Better Auth's routes. OAuth clients post
 * `application/x-www-form-urlencoded` token requests without an Origin header, and Better Auth
 * applies its own origin checks to its cookie-authenticated endpoints.
 */
export function isForbiddenCrossSiteForm(request: Request, url: URL): boolean {
	if (url.pathname.startsWith('/api/auth/') || !UNSAFE_METHODS.includes(request.method)) {
		return false;
	}
	const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
	return FORM_CONTENT_TYPES.includes(type) && request.headers.get('origin') !== url.origin;
}
