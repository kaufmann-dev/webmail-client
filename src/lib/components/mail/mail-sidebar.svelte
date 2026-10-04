<script lang="ts">
	import { resolve } from '$app/paths';
	import Plus from '@lucide/svelte/icons/plus';
	import AccountSwitcher from '#lib/components/mail/account-switcher.svelte';
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
	const customLinks = $derived(links.filter((link) => !link.destination.role));

	function href(scopeValue: string, folderValue: string) {
		return resolve('/(app)/mail/[scope]/[...folder]', { scope: scopeValue, folder: folderValue });
	}

	function linkClass(active: boolean, destination?: MoveDestination) {
		const dropping = destination && accepts && sameDestination(dropTarget, destination);
		return [
			'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
			active ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/60',
			dropping && 'bg-accent outline-1 -outline-offset-1 outline-foreground outline-dashed'
		];
	}
</script>

{#snippet folderLink(link: FolderLink)}
	{@const active = folder === link.key}
	<a
		href={href(scope, link.key)}
		class={linkClass(active, link.destination)}
		{...droppable(link.destination)}
		style:padding-left="{0.5 + link.depth * 0.75}rem"
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
			{#if customLinks.length}
				<div class="flex flex-col">
					<h2 class="px-2 pb-1 text-xs font-medium text-muted-foreground">Folders</h2>
					{#each customLinks as link (link.key)}
						{@render folderLink(link)}
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
