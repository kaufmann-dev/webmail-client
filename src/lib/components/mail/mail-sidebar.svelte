<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import AccountSwitcher from '#lib/components/mail/account-switcher.svelte';
	import type { FolderRequest } from '#lib/components/mail/folder-dialog.svelte';
	import TooltipButton from '#lib/components/tooltip-button.svelte';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { visibleTree, type TreeRow } from '#lib/folder-tree.js';
	import { scopeAccountIds, singleAccount, switchedFolder, viewedRole } from '#lib/mail-scope.js';
	import { FOLDER_ROLES, FOLDER_ROLE_LABELS, type AccountSummary } from '#lib/mail-types.js';
	import { folderDestination, type FolderEntry, type MoveDestination } from '#lib/move-targets.js';

	let {
		accounts,
		folders,
		loading = false,
		unread,
		scope,
		folder,
		onnavigate,
		accepts = null,
		ondrop,
		onfolder
	}: {
		accounts: AccountSummary[];
		folders: Record<string, FolderEntry[]>;
		/** While the folders are still on their way. */
		loading?: boolean;
		unread: Record<string, number | null>;
		scope: string;
		folder: string;
		/** Called when a folder is chosen; switching accounts keeps the sidebar open. */
		onnavigate?: () => void;
		/** While messages are dragged, whether a folder takes them. */
		accepts?: ((destination: MoveDestination) => boolean) | null;
		ondrop?: (destination: MoveDestination) => void;
		/** Asks to create, rename, or delete a folder of the account in view. */
		onfolder?: (request: FolderRequest) => void;
	} = $props();

	interface FolderLink {
		key: string;
		label: string;
		depth: number;
		unread: number | null;
		destination: MoveDestination;
		/** The account's folder; absent for the shared roles across all accounts. */
		entry?: FolderEntry;
	}

	let dropTarget = $state<MoveDestination | null>(null);

	// Collapsed folders (`accountId:path`) are remembered per browser.
	const COLLAPSED_KEY = 'mail.collapsedFolders';
	const collapsed = new SvelteSet<string>();

	onMount(() => {
		try {
			const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
			if (Array.isArray(saved)) for (const key of saved) collapsed.add(String(key));
		} catch {
			// Without storage every folder starts expanded.
		}
	});

	function toggle(key: string) {
		if (collapsed.has(key)) collapsed.delete(key);
		else collapsed.add(key);
		try {
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
		} catch {
			// The choice still holds until the page reloads.
		}
	}

	const sameDestination = (a: MoveDestination | null, b: MoveDestination) =>
		a?.accountId === b.accountId && a?.key === b.key;

	/** Drop handlers for a folder link; inert unless the dragged messages can move there. */
	function droppable(destination: MoveDestination) {
		return {
			ondragover: (event: DragEvent) => {
				if (!accepts?.(destination)) return;
				event.preventDefault();
				if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
				dropTarget = destination;
			},
			ondragleave: (event: DragEvent) => {
				const target = event.currentTarget as HTMLElement;
				if (target.contains(event.relatedTarget as Node | null)) return;
				if (sameDestination(dropTarget, destination)) dropTarget = null;
			},
			ondrop: (event: DragEvent) => {
				dropTarget = null;
				if (!accepts?.(destination)) return;
				event.preventDefault();
				ondrop?.(destination);
			}
		};
	}

	const account = $derived(accounts.find((a) => a.id === singleAccount(scope)) ?? null);
	const role = $derived(viewedRole(scope, folder, folders));
	const totalUnread = $derived(
		scopeAccountIds(scope, accounts).reduce((sum, id) => sum + (unread[id] ?? 0), 0)
	);

	/** The folders of the chosen view: the shared roles across its accounts, or one account's own. */
	const links = $derived.by((): FolderLink[] => {
		if (!account) {
			return FOLDER_ROLES.map((key) => ({
				key,
				label: FOLDER_ROLE_LABELS[key],
				depth: 0,
				unread: key === 'inbox' ? totalUnread : null,
				destination: { accountId: null, key, role: key }
			}));
		}
		return (folders[account.id] ?? []).map((entry) => ({
			key: entry.role ?? entry.path,
			label: entry.role ? FOLDER_ROLE_LABELS[entry.role] : entry.name,
			depth: entry.role ? 0 : entry.depth,
			unread: entry.role === 'inbox' ? unread[account.id] : null,
			destination: folderDestination(account.id, entry),
			entry
		}));
	});
	const roleLinks = $derived(links.filter((link) => link.destination.role));
	const customRows = $derived.by(() => {
		const prefix = `${account?.id}:`;
		const accountCollapsed = new Set(
			[...collapsed].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
		);
		return visibleTree(
			links.filter((link) => !link.destination.role),
			accountCollapsed,
			folder
		);
	});
	const nested = $derived(customRows.some((row) => row.hasChildren));

	function href(scopeValue: string, folderValue: string) {
		return resolve('/(app)/mail/[scope]/[...folder]', { scope: scopeValue, folder: folderValue });
	}

	function linkClass(active: boolean, destination?: MoveDestination) {
		const dropping = destination && accepts && sameDestination(dropTarget, destination);
		return [
			'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
			active ? 'bg-selected font-medium text-selected-foreground' : 'hover:bg-muted',
			dropping && 'bg-accent outline-1 -outline-offset-1 outline-foreground outline-dashed'
		];
	}
</script>

{#snippet folderRow(row: TreeRow<FolderLink>)}
	{@const link = row.item}
	<div class="group flex min-w-0 items-center" style:padding-left="{link.depth * 0.75}rem">
		{#if row.hasChildren}
			{@const action = row.expanded ? 'Collapse' : 'Expand'}
			<TooltipButton
				variant="ghost"
				size="icon-xs"
				class="shrink-0"
				tooltip="{action} {link.label}"
				aria-expanded={row.expanded}
				onclick={() => toggle(`${account?.id}:${link.key}`)}
			>
				<ChevronRight class={row.expanded ? 'rotate-90' : ''} />
				<span class="sr-only">{action} {link.label}</span>
			</TooltipButton>
		{:else if nested}
			<span class="w-6 shrink-0" aria-hidden="true"></span>
		{/if}
		{@render folderLink(link, 0)}
		{#if account && link.entry && onfolder}
			{@render folderMenu(account.id, link.entry)}
		{/if}
	</div>
{/snippet}

{#snippet folderMenu(accountId: string, entry: FolderEntry)}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<TooltipButton
					{...props}
					variant="ghost"
					size="icon-xs"
					class="shrink-0 lg:hidden lg:group-focus-within:inline-flex lg:group-hover:inline-flex lg:aria-expanded:inline-flex"
					tooltip="Folder actions"
				>
					<Ellipsis />
					<span class="sr-only">Actions for {entry.name}</span>
				</TooltipButton>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="start" class="w-max">
			<DropdownMenu.Item onSelect={() => onfolder?.({ kind: 'create', accountId, parent: entry })}>
				<FolderPlus />
				New subfolder
			</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => onfolder?.({ kind: 'rename', accountId, folder: entry })}>
				<Pencil />
				Rename
			</DropdownMenu.Item>
			<DropdownMenu.Item
				variant="destructive"
				onSelect={() => onfolder?.({ kind: 'delete', accountId, folder: entry })}
			>
				<Trash2 />
				Delete
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#snippet folderLink(link: FolderLink, depth = link.depth)}
	{@const active = folder === link.key}
	<a
		href={href(scope, link.key)}
		class={[linkClass(active, link.destination), 'flex-1']}
		{...droppable(link.destination)}
		style:padding-left="{0.5 + depth * 0.75}rem"
		aria-current={active ? 'page' : undefined}
		onclick={onnavigate}
	>
		<span class="min-w-0 flex-1 truncate">{link.label}</span>
		{#if link.unread}
			<span class="tabular text-xs">{link.unread}<span class="sr-only"> unread</span></span>
		{/if}
	</a>
{/snippet}

<nav aria-label="Mailboxes" class="flex flex-col gap-4 p-2">
	{#if accounts.length}
		<AccountSwitcher
			{accounts}
			{unread}
			{scope}
			hrefFor={(target) => href(target, switchedFolder(role, target, folders))}
		/>

		{#if links.length}
			<div class="flex flex-col">
				{#each roleLinks as link (link.key)}
					{@render folderLink(link)}
				{/each}
			</div>
			{#if customRows.length || (account && onfolder)}
				<div class="flex flex-col">
					<div class="flex items-center justify-between pb-1 pl-2">
						<h2 class="text-xs font-medium text-muted-foreground">Folders</h2>
						{#if account && onfolder}
							{@const accountId = account.id}
							<TooltipButton
								variant="ghost"
								size="icon-xs"
								tooltip="New folder"
								onclick={() => onfolder({ kind: 'create', accountId, parent: null })}
							>
								<Plus />
								<span class="sr-only">New folder</span>
							</TooltipButton>
						{/if}
					</div>
					{#each customRows as row (row.item.key)}
						{@render folderRow(row)}
					{/each}
				</div>
			{/if}
		{:else if loading}
			<Spinner aria-label="Loading folders" class="mx-2" />
		{:else}
			<p class="px-2 text-sm text-muted-foreground">
				The folders could not be loaded.
				<a
					href={resolve('/(app)/settings/accounts')}
					class="text-foreground underline underline-offset-2"
					onclick={onnavigate}>Check the account</a
				>.
			</p>
		{/if}
	{:else}
		<a href={resolve('/(app)/settings/accounts/new')} class={linkClass(false)} onclick={onnavigate}>
			<Plus class="size-4" />
			Add account
		</a>
	{/if}
</nav>
