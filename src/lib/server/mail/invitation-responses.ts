import { and, eq } from 'drizzle-orm';
import type { Invitation, InvitationResponse } from '../../mail-types';
import { db } from '../db';
import { invitationResponse } from '../db/schema';

/** Records the user's answer to an invitation, replacing an earlier one. */
export async function recordResponse(
	accountId: string,
	uid: string,
	sequence: number,
	response: InvitationResponse
): Promise<void> {
	await db
		.insert(invitationResponse)
		.values({ accountId, uid, sequence, response })
		.onConflictDoUpdate({
			target: [invitationResponse.accountId, invitationResponse.uid],
			set: { sequence, response, respondedAt: new Date() }
		});
}

/**
 * The user's recorded answer to an invitation they were asked to answer; none once the organizer
 * sent a newer version.
 */
export async function ownResponse(
	accountId: string,
	invitation: Invitation
): Promise<InvitationResponse | null> {
	if (invitation.method !== 'request' || invitation.organizedByYou || !invitation.uid) return null;
	const [row] = await db
		.select({ sequence: invitationResponse.sequence, response: invitationResponse.response })
		.from(invitationResponse)
		.where(
			and(eq(invitationResponse.accountId, accountId), eq(invitationResponse.uid, invitation.uid))
		);
	return row && row.sequence >= invitation.sequence ? row.response : null;
}
