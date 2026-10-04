<script lang="ts">
	import { resolve } from '$app/paths';
	import Archive from '@lucide/svelte/icons/archive';
	import FilePen from '@lucide/svelte/icons/file-pen';
	import Folder from '@lucide/svelte/icons/folder';
	import Inbox from '@lucide/svelte/icons/inbox';
	import Plus from '@lucide/svelte/icons/plus';
	import Send from '@lucide/svelte/icons/send';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
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

	const ROLE_ICONS: Record<FolderRole, typeof Folder> = {
		inbox: Inbox,
		drafts: FilePen,
		sent: Send,
		archive: Archive,
		spam: ShieldAlert,
		trash: Trash2
	};

	function linkClass(active: boolean) {
		return [
			'flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-sm focus-visible:outline-offset-0',
			active
				? 'bg-accent font-medium text-accent-foreground'
				: 'text-foreground/85 hover:bg-foreground/5 hover:text-foreground'
		];
	}
</script>

{#snippet folderLink(
	href: string,
	label: string,
	role: FolderRole | null,
	active: boolean,
	count: number,
	indent: number
)}
	{@const Icon = role ? ROLE_ICONS[role] : Folder}
	<a
		{href}
		class={linkClass(active)}
		style:padding-left="{0.5 + indent * 0.75}rem"
		aria-current={active ? 'page' : undefined}
		onclick={onnavigate}
	>
		<Icon class={['size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground']} />
		<span class="min-w-0 flex-1 truncate">{label}</span>
		{#if count > 0}
			<span
				class="tabular rounded-full bg-primary px-1.5 text-xs leading-5 font-semibold text-primary-foreground"
				aria-label="{count} unread">{count}</span
			>
		{/if}
	</a>
{/snippet}

<nav aria-label="Folders" class="flex flex-col gap-5 p-2">
	<div class="flex flex-col gap-px">
		<h2 class="px-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
			All accounts
		</h2>
		{#each FOLDER_ROLES as role (role)}
			{@render folderLink(
				href('all', role),
				FOLDER_ROLE_LABELS[role],
				role,
				scope === 'all' && folder === role,
				role === 'inbox' ? totalUnread : 0,
				0
			)}
		{/each}
	</div>

	{#each accounts as account (account.id)}
		<div class="flex flex-col gap-px">
			<h2 class="flex min-w-0 items-center gap-2 px-2 pb-1 text-xs font-semibold">
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
				{@render folderLink(
					href(account.id, key),
					entry.role ? FOLDER_ROLE_LABELS[entry.role] : entry.name,
					entry.role,
					scope === account.id && folder === key,
					entry.role === 'inbox' ? (unread[account.id] ?? 0) : 0,
					entry.role ? 0 : entry.depth
				)}
			{:else}
				<p class="px-2 py-1.5 text-xs text-muted-foreground">Folders unavailable</p>
			{/each}
		</div>
	{/each}

	<a href={resolve('/(app)/settings/accounts/new')} class={linkClass(false)} onclick={onnavigate}>
		<Plus class="size-4 text-muted-foreground" />
		Add account
	</a>
</nav>
