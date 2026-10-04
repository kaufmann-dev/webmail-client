<script lang="ts">
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
		hrefFor
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
	} = $props();

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
			class={[
				'flex items-stretch',
				open
					? 'bg-accent shadow-[inset_3px_0_0_var(--color-primary)]'
					: selected.has(message.ref)
						? 'bg-accent/50'
						: 'hover:bg-muted'
			]}
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
				class="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 focus-visible:outline-offset-[-2px]"
				aria-current={open ? 'true' : undefined}
				data-ref={message.ref}
			>
				<div class="flex min-w-0 items-center gap-2">
					{#if unread}
						<span class="size-2 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
						<span class="sr-only">Unread.</span>
					{/if}
					<span
						class={[
							'min-w-0 flex-1 truncate text-sm',
							unread ? 'font-semibold text-foreground' : 'text-foreground/85'
						]}
					>
						{counterpart(message)}
					</span>
					{#if message.hasAttachments}
						<Paperclip
							class="size-3.5 shrink-0 text-muted-foreground"
							aria-label="Has attachments"
						/>
					{/if}
					{#if message.starred}
						<Star class="size-3.5 shrink-0 fill-star text-star" aria-label="Starred" />
					{/if}
					<time
						datetime={message.date}
						class={[
							'tabular shrink-0 text-xs',
							unread ? 'font-semibold text-primary' : 'text-muted-foreground'
						]}
					>
						{listDate(message.date)}
					</time>
				</div>
				<div class="flex min-w-0 items-center gap-2">
					<span
						class={[
							'min-w-0 flex-1 truncate text-sm',
							unread ? 'font-medium text-foreground' : 'text-muted-foreground'
						]}
					>
						{#if message.draft}<span class="font-medium text-destructive"
								>Draft ·
							</span>{/if}{message.subject || '(no subject)'}
					</span>
					{#if showAccount && account}
						<span class="flex max-w-32 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
							<AccountSwatch color={account.color} />
							<span class="truncate">{account.label}</span>
						</span>
					{/if}
				</div>
			</a>
		</li>
	{/each}
</ul>
