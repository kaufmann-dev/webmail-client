<script lang="ts">
	import { onMount } from 'svelte';
	import { deserialize } from '$app/forms';
	import { goto, invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { navigating, page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Archive from '@lucide/svelte/icons/archive';
	import Mail from '@lucide/svelte/icons/mail';
	import MailOpen from '@lucide/svelte/icons/mail-open';
	import Menu from '@lucide/svelte/icons/menu';
	import Search from '@lucide/svelte/icons/search';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Star from '@lucide/svelte/icons/star';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import MailSidebar from '#lib/components/mail/mail-sidebar.svelte';
	import MessageList from '#lib/components/mail/message-list.svelte';
	import MessageReader from '#lib/components/mail/message-reader.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import {
		FOLDER_ROLE_LABELS,
		isFolderRole,
		LIST_FILTERS,
		type MessagePage
	} from '#lib/mail-types.js';

	let { data } = $props();

	const accountsById = $derived(new Map(data.accounts.map((a) => [a.id, a])));
	const role = $derived(
		isFolderRole(data.folder)
			? data.folder
			: (data.folders[data.scope]?.find((f) => f.path === data.folder)?.role ?? null)
	);
	const title = $derived.by(() => {
		const folderName = role
			? FOLDER_ROLE_LABELS[role]
			: (data.folders[data.scope]?.find((f) => f.path === data.folder)?.name ?? data.folder);
		const scopeName = data.scope === 'all' ? 'All accounts' : accountsById.get(data.scope)?.label;
		return `${folderName} · ${scopeName ?? ''}`;
	});

	// Reset whenever the server sends a fresh list; "Load more" appends locally.
	let messages = $derived(data.list.messages);
	let cursor = $derived(data.list.nextCursor);
	let selected = $derived.by(() => {
		void data.list;
		return new Set<string>();
	});
	let loadingMore = $state(false);
	let sidebarOpen = $state(false);
	let shortcutsOpen = $state(false);
	let confirmDelete = $state<string[] | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);

	const openRef = $derived(page.url.searchParams.get('m'));
	const basePath = $derived(
		resolve('/(app)/mail/[scope]/[...folder]', { scope: data.scope, folder: data.folder })
	);

	function urlWith(changes: Record<string, string | null>): string {
		const entries = Object.entries({
			...Object.fromEntries(page.url.searchParams),
			...changes
		}).filter((entry): entry is [string, string] => entry[1] !== null);
		const query = new URLSearchParams(entries).toString();
		return query ? `${basePath}?${query}` : basePath;
	}

	const hrefFor = (ref: string) => urlWith({ m: ref });
	const closeHref = $derived(urlWith({ m: null }));

	async function loadMore() {
		if (!cursor) return;
		loadingMore = true;
		const params = new URLSearchParams({
			scope: data.scope,
			folder: data.folder,
			filter: data.filter,
			cursor,
			...(data.query ? { q: data.query } : {})
		});
		try {
			const response = await fetch(`/api/messages?${params}`);
			if (!response.ok) throw new Error(await response.text());
			const next: MessagePage = await response.json();
			messages = [...messages, ...next.messages];
			cursor = next.nextCursor;
			for (const failure of next.errors) toast.error(failure.message);
		} catch {
			toast.error('Could not load more messages.');
		} finally {
			loadingMore = false;
		}
	}

	async function act(
		action: 'flag' | 'move' | 'delete',
		refs: string[],
		fields: Record<string, string> = {}
	) {
		if (!refs.length) return;
		const body = new FormData();
		for (const ref of refs) body.append('ref', ref);
		for (const [key, value] of Object.entries(fields)) body.set(key, value);
		const response = await fetch(`?/${action}`, {
			method: 'POST',
			body,
			headers: { 'x-sveltekit-action': 'true' }
		});
		const result = deserialize(await response.text());
		if (result.type === 'failure') {
			toast.error(String(result.data?.error ?? 'The action failed.'));
			return;
		}
		if (result.type === 'error') {
			toast.error('The action failed.');
			return;
		}
		const closesReader =
			openRef !== null && refs.includes(openRef) && (action !== 'flag' || fields.seen === 'false');
		if (closesReader) await goto(closeHref, { replace: true, reset: false });
		await Promise.all([invalidate('mail:list'), invalidate('mail:counts')]);
	}

	const selectedRefs = $derived([...selected]);
	const allSelected = $derived(messages.length > 0 && selected.size === messages.length);

	function openIndex(index: number) {
		const message = messages[index];
		if (message) goto(hrefFor(message.ref), { reset: false });
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target as HTMLElement;
		if (
			target.closest('input, textarea, select, [contenteditable], [role="dialog"], [role="menu"]')
		) {
			return;
		}
		const current = messages.findIndex((m) => m.ref === openRef);
		const compose = (params: Record<string, string>) =>
			goto(`${resolve('/(app)/compose')}?${new URLSearchParams(params)}`);
		switch (event.key) {
			case 'j':
				openIndex(current + 1);
				break;
			case 'k':
				openIndex(Math.max(current - 1, 0));
				break;
			case 'c':
				goto(resolve('/(app)/compose'));
				break;
			case '/':
				searchInput?.focus();
				break;
			case '?':
				shortcutsOpen = true;
				break;
			case 'r':
				if (openRef) compose({ reply: openRef });
				break;
			case 'a':
				if (openRef) compose({ reply: openRef, all: '1' });
				break;
			case 'f':
				if (openRef) compose({ forward: openRef });
				break;
			case 'e':
				if (openRef && role !== 'archive') act('move', [openRef], { target: 'archive' });
				break;
			case '#':
				if (openRef && role !== 'trash') act('move', [openRef], { target: 'trash' });
				break;
			case 'u':
				if (openRef) act('flag', [openRef], { seen: 'false' });
				break;
			default:
				return;
		}
		event.preventDefault();
	}

	onMount(() => {
		// New mail: refresh while the tab is visible, and when it regains focus.
		const refresh = () => {
			if (document.visibilityState === 'visible') {
				invalidate('mail:list');
				invalidate('mail:counts');
			}
		};
		const timer = setInterval(refresh, 60_000);
		window.addEventListener('focus', refresh);
		return () => {
			clearInterval(timer);
			window.removeEventListener('focus', refresh);
		};
	});

	const shortcuts = [
		['j / k', 'Next / previous message'],
		['r', 'Reply'],
		['a', 'Reply all'],
		['f', 'Forward'],
		['e', 'Archive'],
		['#', 'Move to trash'],
		['u', 'Mark unread'],
		['c', 'Compose'],
		['/', 'Search'],
		['?', 'Show shortcuts']
	];
</script>

<svelte:window {onkeydown} />
<svelte:head><title>{title} · Mail</title></svelte:head>

{#snippet sidebar(onnavigate?: () => void)}
	<MailSidebar
		accounts={data.accounts}
		folders={data.folders}
		unread={data.unread}
		scope={data.scope}
		folder={data.folder}
		{onnavigate}
	/>
{/snippet}

<div class="grid min-h-0 flex-1 lg:grid-cols-[14rem_minmax(20rem,26rem)_1fr]">
	<aside class="hidden min-h-0 overflow-y-auto border-r lg:block">
		{@render sidebar()}
	</aside>

	<section
		aria-label="Message list"
		class={['min-h-0 flex-col border-r', openRef ? 'hidden lg:flex' : 'flex']}
	>
		<div class="flex flex-col gap-2 border-b p-2">
			<div class="flex items-center gap-2">
				<Button
					variant="ghost"
					size="sm"
					class="lg:hidden"
					aria-label="Folders"
					onclick={() => (sidebarOpen = true)}
				>
					<Menu />
				</Button>
				<h1 class="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
				{#if navigating.to}
					<Spinner aria-label="Loading" />
				{/if}
			</div>
			<form method="GET" action={basePath} class="flex gap-1" role="search">
				{#if data.filter !== 'all'}<input type="hidden" name="filter" value={data.filter} />{/if}
				<Input
					bind:ref={searchInput}
					type="search"
					name="q"
					value={data.query}
					placeholder="Search this folder"
					aria-label="Search this folder"
					class="h-8"
				/>
				<Button type="submit" variant="outline" size="sm" aria-label="Search">
					<Search />
				</Button>
				{#if data.query}
					<Button
						href={urlWith({ q: null, m: null })}
						variant="ghost"
						size="sm"
						aria-label="Clear search"
					>
						<X />
					</Button>
				{/if}
			</form>
			<div class="flex flex-wrap items-center gap-2">
				<Checkbox
					checked={allSelected}
					indeterminate={selected.size > 0 && !allSelected}
					onCheckedChange={(checked) =>
						(selected = checked ? new Set(messages.map((m) => m.ref)) : new Set())}
					aria-label="Select all messages"
					disabled={!messages.length}
				/>
				{#if selected.size}
					<span class="text-xs text-muted-foreground">{selected.size} selected</span>
					<div class="flex flex-wrap gap-0.5">
						<Button
							variant="ghost"
							size="sm"
							title="Mark read"
							onclick={() => act('flag', selectedRefs, { seen: 'true' })}
						>
							<MailOpen /><span class="sr-only">Mark read</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							title="Mark unread"
							onclick={() => act('flag', selectedRefs, { seen: 'false' })}
						>
							<Mail /><span class="sr-only">Mark unread</span>
						</Button>
						<Button
							variant="ghost"
							size="sm"
							title="Star"
							onclick={() => act('flag', selectedRefs, { flagged: 'true' })}
						>
							<Star /><span class="sr-only">Star</span>
						</Button>
						{#if role !== 'archive'}
							<Button
								variant="ghost"
								size="sm"
								title="Archive"
								onclick={() => act('move', selectedRefs, { target: 'archive' })}
							>
								<Archive /><span class="sr-only">Archive</span>
							</Button>
						{/if}
						{#if role !== 'spam'}
							<Button
								variant="ghost"
								size="sm"
								title="Report spam"
								onclick={() => act('move', selectedRefs, { target: 'spam' })}
							>
								<ShieldAlert /><span class="sr-only">Report spam</span>
							</Button>
						{/if}
						{#if role === 'trash' || role === 'spam'}
							<Button
								variant="ghost"
								size="sm"
								class="text-destructive"
								onclick={() => (confirmDelete = selectedRefs)}
							>
								<Trash2 />Delete forever
							</Button>
						{:else}
							<Button
								variant="ghost"
								size="sm"
								title="Move to trash"
								onclick={() => act('move', selectedRefs, { target: 'trash' })}
							>
								<Trash2 /><span class="sr-only">Move to trash</span>
							</Button>
						{/if}
					</div>
				{:else}
					<nav aria-label="Filter" class="flex gap-1 text-xs">
						{#each LIST_FILTERS as filter (filter)}
							<a
								href={urlWith({ filter: filter === 'all' ? null : filter, m: null })}
								aria-current={data.filter === filter ? 'page' : undefined}
								class={[
									'px-2 py-1 capitalize',
									data.filter === filter
										? 'bg-accent font-medium'
										: 'text-muted-foreground hover:text-foreground'
								]}>{filter}</a
							>
						{/each}
					</nav>
				{/if}
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto">
			{#each data.list.errors as failure (failure.accountId)}
				<p class="border-b bg-muted px-3 py-2 text-sm wrap-anywhere" role="status">
					{failure.message}
				</p>
			{/each}
			{#if !data.accounts.length}
				<div class="flex flex-col items-start gap-3 p-6">
					<p class="font-medium">No mail accounts yet</p>
					<p class="text-sm text-muted-foreground">
						Connect Gmail, Purelymail, or Microsoft 365 accounts to read them here.
					</p>
					<Button href={resolve('/(app)/settings/accounts/new')}>Add account</Button>
				</div>
			{:else if !messages.length}
				<p class="p-6 text-sm text-muted-foreground">
					{data.query
						? `No messages match “${data.query}”.`
						: data.filter !== 'all'
							? `No ${data.filter} messages here.`
							: 'This folder is empty.'}
				</p>
			{:else}
				<MessageList
					{messages}
					accounts={accountsById}
					{openRef}
					{selected}
					onselectionchange={(next) => (selected = next)}
					showAccount={data.scope === 'all'}
					showRecipient={role === 'sent' || role === 'drafts'}
					{hrefFor}
				/>
				{#if cursor}
					<div class="p-3">
						<Button variant="outline" class="w-full" onclick={loadMore} disabled={loadingMore}>
							{#if loadingMore}<Spinner aria-label="Loading more messages" />{/if}
							Load more
						</Button>
					</div>
				{/if}
			{/if}
		</div>
	</section>

	<section
		aria-label="Reading pane"
		class={['min-h-0 flex-col', openRef ? 'flex' : 'hidden lg:flex']}
	>
		{#if data.message}
			{#key data.message.ref}
				<MessageReader
					message={data.message}
					account={accountsById.get(data.message.accountId)}
					folders={data.folders[data.message.accountId] ?? []}
					{role}
					{closeHref}
					{hrefFor}
					onaction={(action, fields) => act(action, [data.message!.ref], fields)}
					ondeleteforever={() => (confirmDelete = [data.message!.ref])}
				/>
			{/key}
		{:else if data.messageError}
			<div class="flex flex-col items-start gap-3 p-6">
				<p class="text-sm wrap-anywhere">{data.messageError}</p>
				<Button href={closeHref} variant="outline" size="sm">Back to the list</Button>
			</div>
		{:else}
			<p class="m-auto p-6 text-sm text-muted-foreground">
				Select a message to read it. Press <Kbd>?</Kbd> for keyboard shortcuts.
			</p>
		{/if}
	</section>
</div>

<Sheet.Root bind:open={sidebarOpen}>
	<Sheet.Content side="left" class="w-72 overflow-y-auto p-0">
		<Sheet.Header class="border-b">
			<Sheet.Title>Folders</Sheet.Title>
		</Sheet.Header>
		{@render sidebar(() => (sidebarOpen = false))}
	</Sheet.Content>
</Sheet.Root>

<AlertDialog.Root
	open={confirmDelete !== null}
	onOpenChange={(open) => {
		if (!open) confirmDelete = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				Delete {confirmDelete?.length === 1 ? 'this message' : `${confirmDelete?.length} messages`} forever?
			</AlertDialog.Title>
			<AlertDialog.Description>This cannot be undone.</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-white hover:bg-destructive/90"
				onclick={() => {
					const refs = confirmDelete ?? [];
					confirmDelete = null;
					act('delete', refs);
				}}>Delete forever</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>

<Dialog.Root bind:open={shortcutsOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Keyboard shortcuts</Dialog.Title>
		</Dialog.Header>
		<dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
			{#each shortcuts as [key, label] (key)}
				<dt><Kbd>{key}</Kbd></dt>
				<dd>{label}</dd>
			{/each}
		</dl>
	</Dialog.Content>
</Dialog.Root>
