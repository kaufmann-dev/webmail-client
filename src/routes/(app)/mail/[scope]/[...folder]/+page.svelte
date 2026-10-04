<script lang="ts">
	import { onMount } from 'svelte';
	import { afterNavigate, goto, invalidate } from '$app/navigation';
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
	import { postAction } from '#lib/form-action.js';
	import {
		FOLDER_ROLE_LABELS,
		isFolderRole,
		LIST_FILTERS,
		type MessageDetail,
		type MessagePage,
		type MessageSummary
	} from '#lib/mail-types.js';

	let { data } = $props();

	// Held as stable references: opening a message replaces `data` but not these.
	const list = $derived(data.list);
	const serverUnread = $derived(data.unread);
	const opened = $derived(data.message);

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

	// While another folder or filter loads, it is highlighted already.
	const target = $derived(navigating.to?.route.id === page.route.id ? navigating.to : null);
	const activeScope = $derived(target?.params?.scope ?? data.scope);
	const activeFolder = $derived(target ? target.params?.folder || 'inbox' : data.folder);
	const activeFilter = $derived.by(() => {
		if (!target) return data.filter;
		const filter = target.url.searchParams.get('filter');
		return LIST_FILTERS.find((f) => f === filter) ?? 'all';
	});

	// Reset whenever the server sends a fresh list; "Load more" appends locally.
	let loaded = $derived(list.messages);
	let cursor = $derived(list.nextCursor);
	let selected = $derived.by(() => {
		void list;
		return new Set<string>();
	});
	let loadingMore = $state(false);
	let sidebarOpen = $state(false);
	let shortcutsOpen = $state(false);
	let confirmDelete = $state<string[] | null>(null);
	let searchInput = $state<HTMLInputElement | null>(null);

	type MailAction = 'flag' | 'move' | 'delete';
	type Flags = Partial<Pick<MessageSummary, 'unread' | 'starred'>>;

	interface Change {
		refs: Set<string>;
		remove: boolean;
		flags: Flags;
		/** Inbox unread count changes by account. */
		unread: Record<string, number>;
		/** `refreshes` when the server finished it; null while it runs. */
		done: number | null;
	}

	/**
	 * Actions show at once and run in the background. A finished change stays applied until data
	 * requested after it finished arrives, so a refresh already on its way cannot undo it.
	 */
	let changes = $state.raw<Change[]>([]);
	const refreshes = { count: 0 };
	const listSerial = $derived.by(() => {
		void list;
		return refreshes.count;
	});
	const countsSerial = $derived.by(() => {
		void serverUnread;
		return refreshes.count;
	});
	const running = $derived(changes.filter((c) => c.done === null));
	// The open message's detail is not reloaded, so its own changes stay until another opens.
	let openChanges = $derived.by(() => {
		void opened;
		return [] as Change[];
	});

	function refresh(...ids: string[]) {
		refreshes.count++;
		for (const id of ids) invalidate(id);
	}

	function unsettled(serial: number) {
		return changes.filter((c) => c.done === null || c.done >= serial);
	}

	function withFlags<T extends MessageSummary>(message: T, applied: Change[]): T {
		let result = message;
		for (const change of applied) {
			if (change.refs.has(message.ref)) result = { ...result, ...change.flags };
		}
		return result;
	}

	const messages = $derived.by(() => {
		const applied = unsettled(listSerial);
		const gone = new Set(applied.filter((c) => c.remove).flatMap((c) => [...c.refs]));
		return loaded.filter((m) => !gone.has(m.ref)).map((m) => withFlags(m, applied));
	});

	const unread = $derived.by(() => {
		const counts = { ...serverUnread };
		for (const change of unsettled(countsSerial)) {
			for (const [id, delta] of Object.entries(change.unread)) {
				const count = counts[id];
				if (count != null) counts[id] = Math.max(0, count + delta);
			}
		}
		return counts;
	});

	const openRef = $derived(page.url.searchParams.get('m'));
	// A message being put away disappears before the navigation that closes it finishes.
	let closing = $state<string | null>(null);
	const shownRef = $derived(openRef === closing ? null : openRef);
	const shownSummary = $derived(messages.find((m) => m.ref === shownRef));
	const basePath = $derived(
		resolve('/(app)/mail/[scope]/[...folder]', { scope: data.scope, folder: data.folder })
	);

	function urlWith(updates: Record<string, string | null>): string {
		const entries = Object.entries({
			...Object.fromEntries(page.url.searchParams),
			...updates
		}).filter((entry): entry is [string, string] => entry[1] !== null);
		const query = new URLSearchParams(entries).toString();
		return query ? `${basePath}?${query}` : basePath;
	}

	const hrefFor = (ref: string) => urlWith({ m: ref });
	const closeHref = $derived(urlWith({ m: null }));

	async function loadMore() {
		if (!cursor) return;
		const base = list;
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
			// A fresh list arrived meanwhile and starts over from the newest messages.
			if (list !== base) return;
			loaded = [...loaded, ...next.messages];
			cursor = next.nextCursor;
			for (const failure of next.errors) toast.error(failure.message);
		} catch {
			toast.error('Could not load more messages.');
		} finally {
			loadingMore = false;
		}
	}

	/** Shows an action at once, runs it in the background, and undoes it if the server fails. */
	async function act(action: MailAction, refs: string[], fields: Record<string, string> = {}) {
		if (!refs.length) return;
		const targets = new Set(refs);
		const remove = action !== 'flag';
		const flags: Flags = {};
		if (fields.seen) flags.unread = fields.seen === 'false';
		if (fields.flagged) flags.starred = fields.flagged === 'true';
		const unreadDelta: Record<string, number> = {};
		if (role === 'inbox') {
			for (const message of messages) {
				if (!targets.has(message.ref)) continue;
				const after = !remove && (flags.unread ?? message.unread);
				if (after === message.unread) continue;
				unreadDelta[message.accountId] = (unreadDelta[message.accountId] ?? 0) + (after ? 1 : -1);
			}
		}
		const change: Change = { refs: targets, remove, flags, unread: unreadDelta, done: null };
		const oldest = Math.min(listSerial, countsSerial);
		changes = [...changes.filter((c) => c.done === null || c.done >= oldest), change];
		if (remove) selected = new Set([...selected].filter((ref) => !targets.has(ref)));
		if (shownRef && targets.has(shownRef)) {
			if (!remove) openChanges = [...openChanges, change];
			// Moving, deleting, or marking unread puts the open message away.
			if (remove || flags.unread) {
				closing = shownRef;
				goto(closeHref, { replace: true, reset: false });
			}
		}

		const error = await postAction(`${basePath}?/${action}`, { ...fields, ref: refs });
		if (error) {
			toast.error(error);
			changes = changes.filter((c) => c !== change);
			openChanges = openChanges.filter((c) => c !== change);
			refresh('mail:list', 'mail:counts');
			return;
		}
		change.done = refreshes.count;
		changes = [...changes];
		if (remove) refresh('mail:list', 'mail:counts');
		else refresh('mail:counts');
	}

	/** Opening a message marks it read, in the background like any other action. */
	function markOpenedRead() {
		const ref = openRef;
		if (!ref) return;
		const listed = messages.find((m) => m.ref === ref);
		if (listed) {
			if (listed.unread) act('flag', [ref], { seen: 'true' });
			return;
		}
		opened?.then(
			(result) => {
				if (result.detail?.unread && openRef === ref) act('flag', [ref], { seen: 'true' });
			},
			() => {}
		);
	}

	afterNavigate(() => {
		closing = null;
		markOpenedRead();
	});

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
		const current = messages.findIndex((m) => m.ref === shownRef);
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
				if (shownRef) compose({ reply: shownRef });
				break;
			case 'a':
				if (shownRef) compose({ reply: shownRef, all: '1' });
				break;
			case 'f':
				if (shownRef) compose({ forward: shownRef });
				break;
			case 'e':
				if (shownRef && role !== 'archive') act('move', [shownRef], { target: 'archive' });
				break;
			case '#':
				if (shownRef && role !== 'trash') act('move', [shownRef], { target: 'trash' });
				break;
			case 'u':
				if (shownRef) act('flag', [shownRef], { seen: 'false' });
				break;
			default:
				return;
		}
		event.preventDefault();
	}

	onMount(() => {
		// New mail: refresh while the tab is visible, and when it regains focus.
		const onRefresh = () => {
			if (document.visibilityState === 'visible') refresh('mail:list', 'mail:counts');
		};
		const timer = setInterval(onRefresh, 60_000);
		window.addEventListener('focus', onRefresh);
		return () => {
			clearInterval(timer);
			window.removeEventListener('focus', onRefresh);
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
		{unread}
		scope={activeScope}
		folder={activeFolder}
		{onnavigate}
	/>
{/snippet}

{#snippet reader(message: MessageSummary | MessageDetail)}
	<MessageReader
		{message}
		account={accountsById.get(message.accountId)}
		folders={data.folders[message.accountId] ?? []}
		{role}
		{closeHref}
		{hrefFor}
		onaction={(action, fields) => act(action, [message.ref], fields)}
		ondeleteforever={() => (confirmDelete = [message.ref])}
	/>
{/snippet}

{#snippet unavailable(error: string)}
	<div class="flex flex-col items-start gap-3 p-6">
		<p class="text-sm wrap-anywhere">{error}</p>
		<Button href={closeHref} variant="outline" size="sm">Back to the list</Button>
	</div>
{/snippet}

<div class="grid min-h-0 flex-1 lg:grid-cols-[14rem_minmax(20rem,26rem)_1fr]">
	<aside class="hidden min-h-0 overflow-y-auto border-r lg:block">
		{@render sidebar()}
	</aside>

	<section
		aria-label="Message list"
		class={['min-h-0 flex-col border-r', shownRef ? 'hidden lg:flex' : 'flex']}
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
								aria-current={activeFilter === filter ? 'page' : undefined}
								class={[
									'px-2 py-1 capitalize',
									activeFilter === filter
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
					openRef={shownRef}
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
		class={['min-h-0 flex-col', shownRef ? 'flex' : 'hidden lg:flex']}
	>
		{#if shownRef && opened}
			<!-- The listed summary stands in until the body arrives. -->
			{#await opened}
				{#if shownSummary}
					{@render reader(shownSummary)}
				{:else}
					<Spinner aria-label="Loading message" class="m-auto" />
				{/if}
			{:then result}
				{#if result.detail}
					{#key result.detail.ref}
						{@render reader(withFlags(result.detail, [...running, ...openChanges]))}
					{/key}
				{:else}
					{@render unavailable(result.error)}
				{/if}
			{:catch}
				{@render unavailable('The message could not be loaded.')}
			{/await}
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
