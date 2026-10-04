import { defineEnvVars } from '@sveltejs/kit/env';

// Pass-through validators keep every variable optional at the framework level, so builds and tests
// run without secrets; assertEnv() in hooks.server.ts enforces the required ones at startup.
const optional = { schema: (input: string | undefined) => input };

export const variables = defineEnvVars({
	DATABASE_URL: optional,
	ORIGIN: optional,
	BETTER_AUTH_SECRET: optional,
	POCKET_ID_ISSUER: optional,
	POCKET_ID_CLIENT_ID: optional,
	POCKET_ID_CLIENT_SECRET: optional,
	CREDENTIALS_KEY: optional,
	MICROSOFT_CLIENT_ID: optional,
	MICROSOFT_CLIENT_SECRET: optional
});
