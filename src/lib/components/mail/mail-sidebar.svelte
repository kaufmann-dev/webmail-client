<script lang="ts">
	import { resolve } from '$app/paths';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Plus from '@lucide/svelte/icons/plus';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
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
		onnavigate?: () => void;
		/** While messages are dragged, whether a folder takes them. */
		accepts?: ((destination: MoveDestination) => boolean) | null;
		ondrop?: (destination: MoveDestination) => void;
	} = $props();

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

	const totalUnread = $derived(
		Object.values(unread).reduce<number>((sum, count) => sum + (count ?? 0), 0)
	);

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

<nav aria-label="Folders" class="flex flex-col gap-4 p-2">
	<div class="flex flex-col">
		<h2 class="px-2 pb-1 text-xs font-medium text-muted-foreground">All accounts</h2>
		{#each FOLDER_ROLES as role (role)}
			{@const active = scope === 'all' && folder === role}
			{@const destination = { accountId: null, key: role, role }}
			<a
				href={href('all', role)}
				class={linkClass(active, destination)}
				{...droppable(destination)}
				aria-current={active ? 'page' : undefined}
				onclick={onnavigate}
			>
				<span class="min-w-0 flex-1 truncate">{FOLDER_ROLE_LABELS[role]}</span>
				{#if role === 'inbox' && totalUnread > 0}
					<span class="tabular text-xs" aria-label="{totalUnread} unread">{totalUnread}</span>
				{/if}
			</a>
		{/each}
	</div>

	{#each accounts as account (account.id)}
		<div class="flex flex-col">
			<h2 class="flex min-w-0 items-center gap-2 px-2 pb-1 text-xs font-medium">
				<AccountSwatch color={account.color} />
				<span class="min-w-0 flex-1 truncate" title={account.email}>{account.label}</span>
				{#if account.lastError}
					<a
						href={resolve('/(app)/settings/accounts')}
						title={account.lastError}
						class="text-destructive"
					>
						<AlertTriangle class="size-3.5" />
						<span class="sr-only">Account problem: {account.lastError}</span>
					</a>
				{/if}
			</h2>
			{#each folders[account.id] ?? [] as entry (entry.path)}
				{@const key = entry.role ?? entry.path}
				{@const active = scope === account.id && folder === key}
				{@const destination = folderDestination(account.id, entry)}
				<a
					href={href(account.id, key)}
					class={linkClass(active, destination)}
					{...droppable(destination)}
					style:padding-left="{0.5 + (entry.role ? 0 : entry.depth) * 0.75}rem"
					aria-current={active ? 'page' : undefined}
					onclick={onnavigate}
				>
					<span class="min-w-0 flex-1 truncate">
						{entry.role ? FOLDER_ROLE_LABELS[entry.role] : entry.name}
					</span>
					{#if entry.role === 'inbox' && unread[account.id]}
						<span class="tabular text-xs" aria-label="{unread[account.id]} unread">
							{unread[account.id]}
						</span>
					{/if}
				</a>
			{:else}
				<p class="px-2 py-1.5 text-xs text-muted-foreground">Folders unavailable</p>
			{/each}
		</div>
	{/each}

	<a href={resolve('/(app)/settings/accounts/new')} class={linkClass(false)} onclick={onnavigate}>
		<Plus class="size-4" />
		Add account
	</a>
</nav>
