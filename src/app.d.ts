// See https://svelte.dev/docs/kit/types#app.d.ts
import type { auth } from '#lib/server/auth.js';

type Session = typeof auth.$Infer.Session;

declare global {
	namespace App {
		interface Locals {
			/** Set for every route except the public ones listed in hooks.server.ts. */
			user: Session['user'];
		}
	}
}

export {};
