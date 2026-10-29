import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { sentMeeting } from '../db/schema';

export interface SentMeetingVersion {
	sequence: number;
	messageId: string;
	canceled: boolean;
}

/** Records the newest version of a meeting the user sent, replacing the one before. */
export async function recordSentMeeting(
	accountId: string,
	uid: string,
	version: SentMeetingVersion
): Promise<void> {
	await db
		.insert(sentMeeting)
		.values({ accountId, uid, ...version })
		.onConflictDoUpdate({
			target: [sentMeeting.accountId, sentMeeting.uid],
			set: { ...version, sentAt: new Date() }
		});
}

/** The newest version of a meeting sent from this app, if it changed or canceled it. */
export async function latestSentMeeting(
	accountId: string,
	uid: string
): Promise<SentMeetingVersion | null> {
	const [row] = await db
		.select({
			sequence: sentMeeting.sequence,
			messageId: sentMeeting.messageId,
			canceled: sentMeeting.canceled
		})
		.from(sentMeeting)
		.where(and(eq(sentMeeting.accountId, accountId), eq(sentMeeting.uid, uid)));
	return row ?? null;
}
