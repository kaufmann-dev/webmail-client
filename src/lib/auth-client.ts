import { createAuthClient } from 'better-auth/svelte';
import { oauthProviderClient } from '@better-auth/oauth-provider/client';

// oauthProviderClient carries a pending MCP authorization request through sign-in and consent.
export const authClient = createAuthClient({ plugins: [oauthProviderClient()] });
