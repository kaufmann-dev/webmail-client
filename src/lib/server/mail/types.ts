import type { mailAccount } from '../db/schema';

/** A mail account row, including its encrypted secret. Never send it to the browser. */
export type MailAccount = typeof mailAccount.$inferSelect;
