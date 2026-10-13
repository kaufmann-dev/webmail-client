<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Plus from '@lucide/svelte/icons/plus';
	import AccountSwitcher from '#lib/components/mail/account-switcher.svelte';
	import TooltipButton from '#lib/components/tooltip-button.svelte';
	import { visibleTree, type TreeRow } from '#lib/folder-tree.js';
	import { switchedFolder, viewedRole } from '#lib/mail-scope.js';
	import { FOLDER_ROLES, FOLDER_ROLE_LABELS, type AccountSummary } from '#lib/mail-types.js';
	import { folderDestination, type FolderEntry, type MoveDestination } from '#lib/move-targets.js';

	let {
		accounts,
		folders,
		unread,
		scope,
		folder,
		onnavigate,
		accepts = null,
		ondrop
	}: {
		accounts: AccountSummary[];
		folders: Record<string, FolderEntry[]>;
		unread: Record<string, number | null>;
		scope: string;
		folder: string;
		/** Called when a folder is chosen; switching accounts keeps the sidebar open. */
		onnavigate?: () => void;
		/** While messages are dragged, whether a folder takes them. */
		accepts?: ((destination: MoveDestination) => boolean) | null;
		ondrop?: (destination: MoveDestination) => void;
	} = $props();

	interface FolderLink {
		key: string;
		label: string;
		depth: number;
		unread: number | null;
		destination: MoveDestination;
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

	const account = $derived(accounts.find((a) => a.id === scope) ?? null);
	const role = $derived(viewedRole(scope, folder, folders));
	const totalUnread = $derived(
		Object.values(unread).reduce<number>((sum, count) => sum + (count ?? 0), 0)
	);

	/** The folders of the chosen view: the shared roles across all accounts, or one account's own. */
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
			destination: folderDestination(account.id, entry)
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
			active ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted',
			dropping && 'bg-accent outline-1 -outline-offset-1 outline-foreground outline-dashed'
		];
	}
</script>

{#snippet folderRow(row: TreeRow<FolderLink>)}
	{@const link = row.item}
	<div class="flex min-w-0 items-center" style:padding-left="{link.depth * 0.75}rem">
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
	</div>
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
			{#if customRows.length}
				<div class="flex flex-col">
					<h2 class="px-2 pb-1 text-xs font-medium text-muted-foreground">Folders</h2>
					{#each customRows as row (row.item.key)}
						{@render folderRow(row)}
					{/each}
				</div>
			{/if}
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
