import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { DATABASE_URL } from '$app/env/private';

const client = postgres(DATABASE_URL ?? '', { onnotice: () => {} });

// adapter-node emits this after the HTTP server closes; open pool sockets would keep the process alive.
process.on('sveltekit:shutdown', () => void client.end({ timeout: 5 }));

export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
