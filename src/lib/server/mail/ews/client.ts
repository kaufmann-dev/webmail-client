import { clearAccountError, recordAccountError } from '../account-status';
import { mailAuth } from '../credentials';
import { errorMessage, MailAuthError, MailError } from '../errors';
import type { MailAccount } from '../types';
import { attr, child, list, parseXml, text, type XmlNode } from './xml';

/** Where and as whom to call Exchange Web Services (Basic authentication over HTTPS). */
export interface EwsTarget {
	server: string;
	user: string;
	pass: string;
}

const REQUEST_TIMEOUT_MS = 120_000;

function envelope(body: string): string {
	return (
		'<?xml version="1.0" encoding="utf-8"?>' +
		'<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"' +
		' xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"' +
		' xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">' +
		// en-US makes AQS read dates as month/day/year and keeps server messages in English.
		'<soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/>' +
		'<t:MailboxCulture>en-US</t:MailboxCulture></soap:Header>' +
		`<soap:Body>${body}</soap:Body></soap:Envelope>`
	);
}

/** Exchange rejected the user name or password. */
export class EwsSignInError extends Error {}

/** The server could not be reached or did not answer in time. */
export class EwsUnreachableError extends Error {}

function failureCode(error: unknown): string {
	const cause = (error as { cause?: { code?: string } }).cause;
	if (cause?.code) return cause.code;
	if (error instanceof Error && error.name === 'TimeoutError') return 'timeout';
	return errorMessage(error);
}

/** The response messages of one EWS operation, in request order. */
export function responseMessages(xml: string): XmlNode[] {
	const body = child(child(parseXml(xml), 'Envelope'), 'Body');
	const fault = child(body, 'Fault');
	if (fault) throw new MailError(`Exchange: ${text(fault.faultstring) || 'request failed'}`, 502);
	const operation = Object.values(body ?? {}).find((value) => typeof value === 'object');
	const messages = child(operation as XmlNode | undefined, 'ResponseMessages');
	return Object.entries(messages ?? {})
		.filter(([name]) => name.endsWith('ResponseMessage'))
		.flatMap(([, value]) => list(value));
}

/** Throws a user-facing error for a failed response message and returns it otherwise. */
export function check(message: XmlNode | undefined): XmlNode {
	if (!message) throw new MailError('Exchange sent an empty response.', 502);
	if (attr(message, 'ResponseClass') !== 'Error') return message;
	const code = text(message.ResponseCode);
	if (code === 'ErrorItemNotFound' || code === 'ErrorInvalidIdMalformed') {
		throw new MailError('This message no longer exists.', 404);
	}
	throw new MailError(`Exchange: ${text(message.MessageText) || code}`, 502);
}

export function failed(message: XmlNode): boolean {
	return attr(message, 'ResponseClass') === 'Error';
}

export async function post(target: EwsTarget, body: string): Promise<XmlNode[]> {
	let response: Response;
	try {
		response = await fetch(`https://${target.server}/EWS/Exchange.asmx`, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml; charset=utf-8',
				Authorization: `Basic ${Buffer.from(`${target.user}:${target.pass}`, 'utf8').toString('base64')}`
			},
			body: envelope(body),
			redirect: 'error',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		throw new EwsUnreachableError(failureCode(error));
	}
	if (response.status === 401) throw new EwsSignInError();
	const xml = await response.text();
	if (!xml.includes('Envelope')) {
		throw new MailError(`Exchange answered with HTTP ${response.status}.`, 502);
	}
	return responseMessages(xml);
}

/** Calls EWS for an account, recording failures that concern the whole account. */
export async function ewsCall(account: MailAccount, body: string): Promise<XmlNode[]> {
	const auth = await mailAuth(account);
	if (!account.server || !('pass' in auth)) {
		throw new MailError(`${account.email} has no Exchange server configured.`, 400);
	}
	try {
		const messages = await post({ server: account.server, user: auth.user, pass: auth.pass }, body);
		await clearAccountError(account);
		return messages;
	} catch (error) {
		let accountError: MailError | null = null;
		if (error instanceof EwsSignInError) {
			accountError = new MailAuthError(`${account.email}: sign-in rejected. Update the password.`);
		} else if (error instanceof EwsUnreachableError) {
			accountError = new MailError(
				`${account.email}: cannot reach the Exchange server (${error.message}).`,
				502
			);
		}
		if (!accountError) throw error;
		await recordAccountError(account, accountError.message);
		throw accountError;
	}
}

/** Signs in before an account is saved, so broken credentials are never stored. */
export async function testConnection(target: EwsTarget): Promise<void> {
	try {
		const [message] = await post(
			target,
			'<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>' +
				'<m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>'
		);
		check(message);
	} catch (error) {
		if (error instanceof EwsSignInError) {
			throw new MailAuthError(
				'Exchange sign-in was rejected. Check the user name (for example DOMAIN\\user) and password.'
			);
		}
		if (error instanceof EwsUnreachableError) {
			throw new MailAuthError(`Cannot reach the Exchange server: ${error.message}`);
		}
		throw error;
	}
}
