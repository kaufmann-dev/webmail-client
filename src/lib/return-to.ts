/** Accepts only same-origin paths, so a login link cannot redirect elsewhere. */
export function safeReturnTo(value: string | null | undefined): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\'))
		return '/';
	if (value.startsWith('/login') || value.startsWith('/api/')) return '/';
	return value;
}
