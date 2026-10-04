import nodemailer from 'nodemailer';
import type { MailAuth } from './credentials';
import { PROVIDER_CONFIG } from './providers';
import type { Provider } from '../../mail-types';

export function createSmtpTransport(provider: Provider, auth: MailAuth) {
	const { host, port, secure } = PROVIDER_CONFIG[provider].smtp;
	return nodemailer.createTransport({
		host,
		port,
		secure,
		requireTLS: !secure,
		connectionTimeout: 20_000,
		greetingTimeout: 20_000,
		socketTimeout: 60_000,
		auth:
			'accessToken' in auth
				? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken }
				: { user: auth.user, pass: auth.pass }
	});
}
