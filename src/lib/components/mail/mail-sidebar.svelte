<script lang="ts">
	import { resolve } from '$app/paths';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Plus from '@lucide/svelte/icons/plus';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import {
		FOLDER_ROLES,
		FOLDER_ROLE_LABELS,
		type AccountSummary,
		type FolderRole
	} from '#lib/mail-types.js';

	interface FolderEntry {
		path: string;
		name: string;
		depth: number;
		role: FolderRole | null;
	}

	let {
		accounts,
		folders,
		unread,
		scope,
		folder,
		onnavigate
	}: {
		accounts: AccountSummary[];
		folders: Record<string, FolderEntry[]>;
		unread: Record<string, number | null>;
		scope: string;
		folder: string;
		onnavigate?: () => void;
	} = $props();

	const totalUnread = $derived(
		Object.values(unread).reduce<number>((sum, count) => sum + (count ?? 0), 0)
	);

	function href(scopeValue: string, folderValue: string) {
		return resolve('/(app)/mail/[scope]/[...folder]', { scope: scopeValue, folder: folderValue });
	}

	function linkClass(active: boolean) {
		return [
			'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm',
			active ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-accent/60'
		];
	}
</script>

<nav aria-label="Folders" class="flex flex-col gap-4 p-2">
	<div class="flex flex-col">
		<h2 class="px-2 pb-1 text-xs font-medium text-muted-foreground">All accounts</h2>
		{#each FOLDER_ROLES as role (role)}
			{@const active = scope === 'all' && folder === role}
			<a
				href={href('all', role)}
				class={linkClass(active)}
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
				<a
					href={href(account.id, key)}
					class={linkClass(active)}
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
