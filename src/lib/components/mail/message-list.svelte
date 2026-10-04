<script lang="ts">
	import { flushSync } from 'svelte';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Star from '@lucide/svelte/icons/star';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { listDate, senderName } from '#lib/format.js';
	import type { AccountSummary, MessageSummary } from '#lib/mail-types.js';

	let {
		messages,
		accounts,
		openRef,
		selected,
		onselectionchange,
		showAccount,
		showRecipient,
		hrefFor,
		ondragstart,
		ondragend
	}: {
		messages: MessageSummary[];
		accounts: Map<string, AccountSummary>;
		openRef: string | null;
		selected: Set<string>;
		onselectionchange: (next: Set<string>) => void;
		showAccount: boolean;
		/** Sent and Drafts show who a message went to rather than who sent it. */
		showRecipient: boolean;
		hrefFor: (ref: string) => string;
		/** Dragging a selected message drags the whole selection. */
		ondragstart: (refs: string[]) => void;
		ondragend: () => void;
	} = $props();

	let dragLabel = $state<HTMLElement | null>(null);
	let dragCount = $state(0);

	function startDrag(event: DragEvent, message: MessageSummary) {
		const refs = selected.has(message.ref) ? [...selected] : [message.ref];
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', message.subject || '(no subject)');
			if (refs.length > 1 && dragLabel) {
				dragCount = refs.length;
				// The drag image is captured now, so the label must already show the count.
				flushSync();
				event.dataTransfer.setDragImage(dragLabel, 0, 0);
			}
		}
		ondragstart(refs);
	}

	function toggle(ref: string, checked: boolean) {
		const others = [...selected].filter((r) => r !== ref);
		onselectionchange(new Set(checked ? [...others, ref] : others));
	}

	function counterpart(message: MessageSummary): string {
		if (!showRecipient) return senderName(message.from);
		const first = message.to[0];
		if (!first) return '(no recipients)';
		const more = message.to.length > 1 ? ` +${message.to.length - 1}` : '';
		return `To: ${first.name || first.address}${more}`;
	}
</script>

<ul class="divide-y" aria-label="Messages">
	{#each messages as message (message.ref)}
		{@const account = accounts.get(message.accountId)}
		{@const open = message.ref === openRef}
		{@const unread = message.unread && !open}
		<li
			class={['flex items-stretch', open ? 'bg-accent' : 'hover:bg-accent/50']}
			draggable="true"
			ondragstart={(event) => startDrag(event, message)}
			{ondragend}
		>
			<div class="flex items-start pt-3 pl-3">
				<Checkbox
					checked={selected.has(message.ref)}
					onCheckedChange={(checked) => toggle(message.ref, checked === true)}
					aria-label="Select message: {message.subject || '(no subject)'}"
				/>
			</div>
			<a
				href={hrefFor(message.ref)}
				class="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2"
				aria-current={open ? 'true' : undefined}
				data-ref={message.ref}
				draggable="false"
			>
				<div class="flex min-w-0 items-center gap-2">
					{#if unread}
						<span class="size-2 shrink-0 rounded-full bg-foreground" aria-hidden="true"></span>
						<span class="sr-only">Unread.</span>
					{/if}
					<span class={['min-w-0 flex-1 truncate text-sm', unread && 'font-semibold']}>
						{counterpart(message)}
					</span>
					{#if message.hasAttachments}
						<Paperclip
							class="size-3.5 shrink-0 text-muted-foreground"
							aria-label="Has attachments"
						/>
					{/if}
					{#if message.starred}
						<Star class="size-3.5 shrink-0 fill-current" aria-label="Starred" />
					{/if}
					<time datetime={message.date} class="tabular shrink-0 text-xs text-muted-foreground">
						{listDate(message.date)}
					</time>
				</div>
				<div class="flex min-w-0 items-center gap-2">
					<span
						class={[
							'min-w-0 flex-1 truncate text-sm',
							unread ? 'font-medium' : 'text-muted-foreground'
						]}
					>
						{#if message.draft}<span class="text-destructive"
								>Draft ·
							</span>{/if}{message.subject || '(no subject)'}
					</span>
					{#if showAccount && account}
						<span class="flex max-w-32 shrink-0 items-center gap-1 text-xs text-muted-foreground">
							<AccountSwatch color={account.color} />
							<span class="truncate">{account.label}</span>
						</span>
					{/if}
				</div>
			</a>
		</li>
	{/each}
</ul>

<!-- Drag image for several messages; off screen but rendered, as browsers require. -->
<div
	bind:this={dragLabel}
	class="fixed -top-96 left-0 rounded-md border bg-background px-2 py-1 text-sm"
	aria-hidden="true"
>
	{dragCount} messages
</div>
