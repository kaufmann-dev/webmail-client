/** A failure whose message is safe and useful to show to the user or an MCP client. */
export class MailError extends Error {
	constructor(
		message: string,
		readonly status = 500
	) {
		super(message);
		this.name = 'MailError';
	}
}

/** The provider rejected the stored credentials; the account needs a new password or sign-in. */
export class MailAuthError extends MailError {
	constructor(message: string) {
		super(message, 502);
		this.name = 'MailAuthError';
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
