<script lang="ts">
	import { resolve } from '$app/paths';
	import Archive from '@lucide/svelte/icons/archive';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Download from '@lucide/svelte/icons/download';
	import Forward from '@lucide/svelte/icons/forward';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Mail from '@lucide/svelte/icons/mail';
	import Reply from '@lucide/svelte/icons/reply';
	import ReplyAll from '@lucide/svelte/icons/reply-all';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Star from '@lucide/svelte/icons/star';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import InvitationCard from '#lib/components/mail/invitation-card.svelte';
	import MessageBody from '#lib/components/mail/message-body.svelte';
	import MoveMenu from '#lib/components/mail/move-menu.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { fileSize, formatAddress, longDate, senderName } from '#lib/format.js';
	import type {
		AccountSummary,
		FolderRole,
		InvitationResponse,
		MessageDetail,
		MessageSummary
	} from '#lib/mail-types.js';
	import type { MoveDestination } from '#lib/move-targets.js';

	let {
		message,
		account,
		destinations,
		role,
		closeHref,
		hrefFor,
		onaction,
		onrespond,
		ondeleteforever
	}: {
		/** A listed summary shows the header and toolbar while the full message loads. */
		message: MessageSummary | MessageDetail;
		/** Passed in the all-accounts view only; a single account's view already names it. */
		account: AccountSummary | undefined;
		destinations: MoveDestination[];
		/** Role of the folder being viewed, which decides Trash vs. Delete forever and Spam vs. Not spam. */
		role: FolderRole | null;
		closeHref: string;
		hrefFor: (ref: string) => string;
		onaction: (action: 'flag' | 'move', fields: Record<string, string>) => void;
		/** Answers the message's invitation; resolves to an error message or null. */
		onrespond: (response: InvitationResponse) => Promise<string | null>;
		ondeleteforever: () => void;
	} = $props();

	const detail = $derived('html' in message ? message : null);
	// A label that is one of the recipients' addresses already names the account.
	const namedAccount = $derived.by(() => {
		const label = account?.label.toLowerCase();
		const recipients = [...message.to, ...(detail?.cc ?? []), ...(detail?.bcc ?? [])];
		return recipients.some((r) => r.address.toLowerCase() === label) ? undefined : account;
	});
	// Remote images load at once, except in Spam, where loading them confirms the address to spammers.
	let loadRemote = $state(false);
	const allowRemote = $derived(role !== 'spam' || loadRemote);
	let thread = $state<MessageSummary[] | null>(null);
	let threadState = $state<'idle' | 'loading' | 'error'>('idle');

	const compose = (params: Record<string, string>) =>
		`${resolve('/(app)/compose')}?${new URLSearchParams(params)}`;

	async function loadThread() {
		threadState = 'loading';
		try {
			const response = await fetch(`/api/messages/${message.ref}/thread`);
			if (!response.ok) throw new Error(await response.text());
			thread = await response.json();
			threadState = 'idle';
		} catch {
			threadState = 'error';
		}
	}
</script>

<article class="@container flex min-h-0 flex-col" aria-label="Message">
	<!-- In a narrow reader the labels hide and the buttons tighten, so the toolbar keeps one row. -->
	<div
		class="flex flex-wrap items-center gap-0.5 border-b p-2 @max-2xl:[&>[data-slot=button]]:px-1.5"
	>
		<Button href={closeHref} variant="ghost" size="sm" class="lg:hidden" title="Back">
			<ArrowLeft />
			<span class="sr-only">Back</span>
		</Button>
		<Button href={compose({ reply: message.ref })} variant="ghost" size="sm" title="Reply (r)">
			<Reply />
			<span class="@max-2xl:sr-only">Reply</span>
		</Button>
		<Button
			href={compose({ reply: message.ref, all: '1' })}
			variant="ghost"
			size="sm"
			title="Reply all (a)"
		>
			<ReplyAll />
			<span class="@max-2xl:sr-only">Reply all</span>
		</Button>
		<Button href={compose({ forward: message.ref })} variant="ghost" size="sm" title="Forward (f)">
			<Forward />
			<span class="@max-2xl:sr-only">Forward</span>
		</Button>
		<span class="mx-1 h-5 w-px bg-border" aria-hidden="true"></span>
		{#if role !== 'archive'}
			<Button
				variant="ghost"
				size="sm"
				title="Archive (e)"
				onclick={() => onaction('move', { target: 'archive' })}
			>
				<Archive />
				<span class="sr-only">Archive</span>
			</Button>
		{/if}
		<Button
			variant="ghost"
			size="sm"
			title="Mark unread (u)"
			onclick={() => onaction('flag', { seen: 'false' })}
		>
			<Mail />
			<span class="sr-only">Mark unread</span>
		</Button>
		<Button
			variant="ghost"
			size="sm"
			title={message.starred ? 'Unstar' : 'Star'}
			aria-pressed={message.starred}
			onclick={() => onaction('flag', { flagged: String(!message.starred) })}
		>
			<Star class={message.starred ? 'fill-current' : ''} />
			<span class="sr-only">{message.starred ? 'Unstar' : 'Star'}</span>
		</Button>
		<MoveMenu {destinations} onmove={(target) => onaction('move', { target })} />
		{#if role === 'spam'}
			<Button
				variant="ghost"
				size="sm"
				title="Not spam"
				onclick={() => onaction('move', { target: 'inbox' })}
			>
				<Inbox />
				<span class="sr-only">Not spam</span>
			</Button>
		{:else}
			<Button
				variant="ghost"
				size="sm"
				title="Report spam"
				onclick={() => onaction('move', { target: 'spam' })}
			>
				<ShieldAlert />
				<span class="sr-only">Report spam</span>
			</Button>
		{/if}
		{#if role === 'trash' || role === 'spam'}
			<Button
				variant="ghost"
				size="sm"
				class="ml-auto text-destructive"
				title="Delete forever"
				onclick={ondeleteforever}
			>
				<Trash2 />
				<span class="sr-only">Delete forever</span>
			</Button>
		{:else}
			<Button
				variant="ghost"
				size="sm"
				class="ml-auto"
				title="Move to trash (#)"
				onclick={() => onaction('move', { target: 'trash' })}
			>
				<Trash2 />
				<span class="sr-only">Move to trash</span>
			</Button>
		{/if}
	</div>

	<div class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
		<header class="flex flex-col gap-2">
			<h1 class="text-xl font-semibold break-words">{message.subject || '(no subject)'}</h1>
			<div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-sm">
				<div class="flex min-w-0 flex-col gap-0.5">
					<span class="font-medium break-words">
						{senderName(message.from)}
						{#if message.from?.name}
							<span class="font-normal text-muted-foreground">&lt;{message.from.address}&gt;</span>
						{/if}
					</span>
					{#if message.to.length}
						<span class="break-words text-muted-foreground"
							>To: {message.to.map(formatAddress).join(', ')}</span
						>
					{/if}
					{#if detail?.cc.length}
						<span class="break-words text-muted-foreground"
							>Cc: {detail.cc.map(formatAddress).join(', ')}</span
						>
					{/if}
					{#if detail?.bcc.length}
						<span class="break-words text-muted-foreground"
							>Bcc: {detail.bcc.map(formatAddress).join(', ')}</span
						>
					{/if}
				</div>
				<div class="flex flex-col items-end gap-0.5 text-muted-foreground">
					<time datetime={message.date}>{longDate(message.date)}</time>
					{#if namedAccount}
						<span class="flex items-center gap-1">
							<AccountSwatch color={namedAccount.color} />
							{namedAccount.label}
						</span>
					{/if}
				</div>
			</div>
		</header>

		{#if detail}
			{#if detail.hasRemoteImages && !allowRemote}
				<div class="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
					<span class="flex-1"
						>Remote images are blocked in Spam to keep senders from tracking you.</span
					>
					<Button variant="outline" size="sm" onclick={() => (loadRemote = true)}
						>Load images</Button
					>
				</div>
			{/if}

			{#if detail.invitation}
				<InvitationCard invitation={detail.invitation} {onrespond} />
			{/if}

			<MessageBody html={detail.html} {allowRemote} />

			{#if detail.attachments.length}
				<section aria-labelledby="attachments-heading" class="flex flex-col gap-2">
					<h2 id="attachments-heading" class="text-sm font-medium">
						{detail.attachments.length} attachment{detail.attachments.length === 1 ? '' : 's'}
					</h2>
					<ul class="flex flex-wrap gap-2">
						{#each detail.attachments as attachment (attachment.partId)}
							<li>
								<a
									href="/api/messages/{message.ref}/attachments/{attachment.partId}"
									download={attachment.filename}
									class="flex max-w-72 items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
								>
									<Download class="size-4 shrink-0" />
									<span class="min-w-0 truncate">{attachment.filename}</span>
									<span class="shrink-0 text-xs text-muted-foreground"
										>{fileSize(attachment.size)}</span
									>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<section aria-label="Conversation" class="flex flex-col gap-2 border-t pt-4">
				{#if thread}
					<h2 class="text-sm font-medium">Conversation ({thread.length})</h2>
					<ol class="flex flex-col">
						{#each thread as item (item.ref)}
							<li>
								<a
									href={hrefFor(item.ref)}
									class={[
										'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent',
										item.messageId === message.messageId && 'font-medium'
									]}
								>
									<span class="min-w-0 flex-1 truncate"
										>{senderName(item.from)}: {item.subject}</span
									>
									<time datetime={item.date} class="shrink-0 text-xs text-muted-foreground">
										{longDate(item.date)}
									</time>
								</a>
							</li>
						{/each}
					</ol>
				{:else}
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onclick={loadThread}
							disabled={threadState === 'loading'}
						>
							{#if threadState === 'loading'}<Spinner aria-label="Loading conversation" />{/if}
							Show conversation
						</Button>
						{#if threadState === 'error'}
							<span class="text-sm text-destructive">The conversation could not be loaded.</span>
						{/if}
					</div>
				{/if}
			</section>
		{:else}
			<Spinner aria-label="Loading message" class="mx-auto" />
		{/if}
	</div>
</article>
