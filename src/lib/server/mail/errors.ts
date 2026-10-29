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

/**
 * The message is not where its ref points: deleted, moved elsewhere, or its folder was recreated.
 * MCP tools look such a message up again by its Message-ID.
 */
export class MessageGoneError extends MailError {
	constructor(message = 'This message no longer exists.', status = 404) {
		super(message, status);
		this.name = 'MessageGoneError';
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
