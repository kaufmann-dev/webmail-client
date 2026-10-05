<script lang="ts">
	import { toast } from 'svelte-sonner';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import { Button } from '#lib/components/ui/button/index.js';
	import { eventWhen, formatAddress, senderName } from '#lib/format.js';
	import {
		INVITATION_RESPONSES,
		type AttendeeStatus,
		type Invitation,
		type InvitationResponse
	} from '#lib/mail-types.js';

	let {
		invitation,
		onrespond
	}: {
		invitation: Invitation;
		/** Sends the answer to the organizer; resolves to an error message or null. */
		onrespond: (response: InvitationResponse) => Promise<string | null>;
	} = $props();

	const LABELS: Record<InvitationResponse, string> = {
		accepted: 'Accept',
		tentative: 'Maybe',
		declined: 'Decline'
	};

	const STATUS_TEXT: Record<AttendeeStatus, string> = {
		accepted: 'accepted',
		tentative: 'tentatively accepted',
		declined: 'declined',
		delegated: 'delegated',
		'needs-action': 'has not answered'
	};

	const isResponse = (status: AttendeeStatus | null): status is InvitationResponse =>
		(INVITATION_RESPONSES as readonly (string | null)[]).includes(status);

	// The answer sent from here; until then, the one the invitation already records.
	let sent = $state<InvitationResponse | null>(null);
	let sending = $state(false);
	const chosen = $derived(sent ?? (isResponse(invitation.ownStatus) ? invitation.ownStatus : null));

	async function respond(response: InvitationResponse) {
		const previous = sent;
		sent = response;
		sending = true;
		const error = await onrespond(response);
		sending = false;
		if (error) {
			sent = previous;
			toast.error(error);
		}
	}
</script>

<section aria-label="Invitation" class="flex flex-col gap-2 rounded-md border p-3 text-sm">
	<div class="flex items-start gap-2">
		<CalendarDays class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
		<div class="flex min-w-0 flex-col gap-0.5">
			<span class="font-medium break-words">{invitation.title || '(no title)'}</span>
			<span>{eventWhen(invitation)}{invitation.recurring ? ' · Repeats' : ''}</span>
			{#if invitation.location}
				<span class="break-words text-muted-foreground">{invitation.location}</span>
			{/if}
			{#if invitation.organizer}
				<span class="break-words text-muted-foreground"
					>Organizer: {formatAddress(invitation.organizer)}</span
				>
			{/if}
		</div>
	</div>

	{#if invitation.method === 'request'}
		<div class="flex flex-wrap gap-2" role="group" aria-label="Your answer">
			{#each INVITATION_RESPONSES as response (response)}
				<Button
					variant={chosen === response ? 'secondary' : 'outline'}
					size="sm"
					aria-pressed={chosen === response}
					disabled={sending}
					title="Send “{LABELS[response]}” to the organizer"
					onclick={() => respond(response)}>{LABELS[response]}</Button
				>
			{/each}
		</div>
	{:else if invitation.method === 'cancel'}
		<p class="font-medium">This event was cancelled.</p>
	{:else if invitation.method === 'reply'}
		{#each invitation.attendees as attendee (attendee.address)}
			<p>{senderName(attendee)} {STATUS_TEXT[attendee.status]}.</p>
		{/each}
	{/if}
</section>
