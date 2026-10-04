import type { Provider } from '../../mail-types';

export interface ProviderConfig {
	imap: { host: string; port: number; secure: boolean };
	smtp: { host: string; port: number; secure: boolean };
	auth: 'password' | 'oauth';
	/** Whether the SMTP server leaves no copy in Sent, so the app must append one. */
	appendToSent: boolean;
	/** Special-use folder that archiving moves messages to. */
	archiveSpecialUse: '\\All' | '\\Archive';
}

export const PROVIDER_CONFIG: Record<Provider, ProviderConfig> = {
	gmail: {
		imap: { host: 'imap.gmail.com', port: 993, secure: true },
		smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
		auth: 'password',
		appendToSent: false,
		// Moving out of INBOX into All Mail removes Gmail's Inbox label, which is Gmail's archive.
		archiveSpecialUse: '\\All'
	},
	purelymail: {
		imap: { host: 'imap.purelymail.com', port: 993, secure: true },
		smtp: { host: 'smtp.purelymail.com', port: 465, secure: true },
		auth: 'password',
		appendToSent: true,
		archiveSpecialUse: '\\Archive'
	},
	microsoft: {
		imap: { host: 'outlook.office365.com', port: 993, secure: true },
		smtp: { host: 'smtp.office365.com', port: 587, secure: false },
		auth: 'oauth',
		appendToSent: false,
		archiveSpecialUse: '\\Archive'
	}
};
