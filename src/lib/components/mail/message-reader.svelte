<script lang="ts">
	import { resolve } from '$app/paths';
	import Archive from '@lucide/svelte/icons/archive';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Download from '@lucide/svelte/icons/download';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import Forward from '@lucide/svelte/icons/forward';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Mail from '@lucide/svelte/icons/mail';
	import Reply from '@lucide/svelte/icons/reply';
	import ReplyAll from '@lucide/svelte/icons/reply-all';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Star from '@lucide/svelte/icons/star';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import MessageBody from '#lib/components/mail/message-body.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { fileSize, formatAddress, longDate, senderName } from '#lib/format.js';
	import {
		FOLDER_ROLE_LABELS,
		type AccountSummary,
		type FolderRole,
		type MessageDetail,
		type MessageSummary
	} from '#lib/mail-types.js';

	interface FolderEntry {
		path: string;
		name: string;
		role: FolderRole | null;
	}

	let {
		message,
		account,
		folders,
		role,
		closeHref,
		hrefFor,
		onaction,
		ondeleteforever
	}: {
		/** A listed summary shows the header and toolbar while the full message loads. */
		message: MessageSummary | MessageDetail;
		account: AccountSummary | undefined;
		folders: FolderEntry[];
		/** Role of the folder being viewed, which decides Trash vs. Delete forever and Spam vs. Not spam. */
		role: FolderRole | null;
		closeHref: string;
		hrefFor: (ref: string) => string;
		onaction: (action: 'flag' | 'move', fields: Record<string, string>) => void;
		ondeleteforever: () => void;
	} = $props();

	const detail = $derived('html' in message ? message : null);
	let allowRemote = $state(false);
	let thread = $state<MessageSummary[] | null>(null);
	let threadState = $state<'idle' | 'loading' | 'error'>('idle');

	const compose = (params: Record<string, string>) =>
		`${resolve('/(app)/compose')}?${new URLSearchParams(params)}`;

	const moveTargets = $derived(folders.filter((f) => f.role !== 'drafts'));

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

<article class="flex min-h-0 flex-col" aria-label="Message">
	<div class="flex flex-wrap items-center gap-1 border-b p-2">
		<Button href={closeHref} variant="ghost" size="sm" class="lg:hidden">
			<ArrowLeft />
			Back
		</Button>
		<Button href={compose({ reply: message.ref })} variant="ghost" size="sm" title="Reply (r)">
			<Reply />
			Reply
		</Button>
		<Button
			href={compose({ reply: message.ref, all: '1' })}
			variant="ghost"
			size="sm"
			title="Reply all (a)"
		>
			<ReplyAll />
			<span class="hidden sm:inline">Reply all</span>
			<span class="sr-only sm:hidden">Reply all</span>
		</Button>
		<Button href={compose({ forward: message.ref })} variant="ghost" size="sm" title="Forward (f)">
			<Forward />
			<span class="hidden sm:inline">Forward</span>
			<span class="sr-only sm:hidden">Forward</span>
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
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" title="Move to folder">
						<FolderInput />
						<span class="sr-only">Move to folder</span>
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="max-h-80 max-w-72 overflow-y-auto">
				{#each moveTargets as folder (folder.path)}
					<DropdownMenu.Item
						onSelect={() => onaction('move', { target: folder.role ?? folder.path })}
					>
						<span class="truncate"
							>{folder.role ? FOLDER_ROLE_LABELS[folder.role] : folder.path}</span
						>
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		{#if role === 'spam'}
			<Button variant="ghost" size="sm" onclick={() => onaction('move', { target: 'inbox' })}>
				<Inbox />
				Not spam
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
		<span class="flex-1"></span>
		{#if role === 'trash' || role === 'spam'}
			<Button variant="ghost" size="sm" class="text-destructive" onclick={ondeleteforever}>
				<Trash2 />
				Delete forever
			</Button>
		{:else}
			<Button
				variant="ghost"
				size="sm"
				title="Move to trash (#)"
				onclick={() => onaction('move', { target: 'trash' })}
			>
				<Trash2 />
				<span class="sr-only">Move to trash</span>
			</Button>
		{/if}
	</div>

	<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
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
					{#if account}
						<span class="flex items-center gap-1">
							<AccountSwatch color={account.color} />
							{account.label}
						</span>
					{/if}
				</div>
			</div>
		</header>

		{#if detail}
			{#if detail.hasRemoteImages && !allowRemote}
				<div class="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
					<span class="flex-1">Remote images are blocked to keep senders from tracking you.</span>
					<Button variant="outline" size="sm" onclick={() => (allowRemote = true)}
						>Load images</Button
					>
				</div>
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
