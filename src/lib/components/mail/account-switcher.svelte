<script lang="ts">
	import { resolve } from '$app/paths';
	import AlertTriangle from '@lucide/svelte/icons/triangle-alert';
	import Check from '@lucide/svelte/icons/check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Mails from '@lucide/svelte/icons/mails';
	import Plus from '@lucide/svelte/icons/plus';
	import Settings from '@lucide/svelte/icons/settings';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { PROVIDER_LABELS, type AccountSummary } from '#lib/mail-types.js';

	let {
		accounts,
		unread,
		scope,
		hrefFor
	}: {
		accounts: AccountSummary[];
		unread: Record<string, number | null>;
		/** `all`, or the ID of the account being viewed. */
		scope: string;
		/** Where switching to a scope leads. */
		hrefFor: (scope: string) => string;
	} = $props();

	const current = $derived(accounts.find((account) => account.id === scope) ?? null);
	const totalUnread = $derived(
		Object.values(unread).reduce<number>((sum, count) => sum + (count ?? 0), 0)
	);
	const failing = $derived(
		current ? current.lastError !== null : accounts.some((a) => a.lastError !== null)
	);

	/** The second line: the address, unless the label already is the address. */
	function detail(account: AccountSummary): string {
		return account.label === account.email ? PROVIDER_LABELS[account.provider] : account.email;
	}
</script>

{#snippet mark(account: AccountSummary | null)}
	<span class="flex size-4 shrink-0 items-center justify-center">
		{#if account}
			<AccountSwatch color={account.color} />
		{:else}
			<Mails class="size-4 text-muted-foreground" />
		{/if}
	</span>
{/snippet}

{#snippet option(account: AccountSummary | null)}
	{@const id = account?.id ?? 'all'}
	{@const active = scope === id}
	{@const count = account ? unread[account.id] : totalUnread}
	<DropdownMenu.Item class="items-start">
		{#snippet child({ props })}
			<!-- Focus returns to the switcher instead of the page start, so the new folders come next. -->
			<a
				{...props}
				href={hrefFor(id)}
				aria-current={active ? 'page' : undefined}
				data-sveltekit-reset="false"
			>
				<span class="flex h-5 items-center">{@render mark(account)}</span>
				<span class="flex min-w-0 flex-1 flex-col">
					<span class={['truncate', active && 'font-medium']}>
						{account?.label ?? 'All accounts'}
					</span>
					{#if account && account.label !== account.email}
						<span class="truncate text-xs text-muted-foreground">{account.email}</span>
					{/if}
				</span>
				<span class="flex h-5 shrink-0 items-center gap-2">
					{#if account?.lastError}
						<AlertTriangle class="size-3.5 text-destructive" />
						<span class="sr-only">Connection problem.</span>
					{/if}
					{#if count}
						<span class="tabular text-xs text-muted-foreground">
							{count}<span class="sr-only"> unread</span>
						</span>
					{/if}
					<Check class={['size-4', !active && 'invisible']} />
				</span>
			</a>
		{/snippet}
	</DropdownMenu.Item>
{/snippet}

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class="flex w-full min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left hover:bg-accent/60 aria-expanded:bg-accent"
			>
				{@render mark(current)}
				<span
					class="flex min-w-0 flex-1 flex-col"
					title={current ? `${current.label}\n${current.email}` : undefined}
				>
					<span class="sr-only">Switch account. Showing</span>
					<span class="truncate text-sm font-medium">{current?.label ?? 'All accounts'}</span>
					<span class="truncate text-xs text-muted-foreground">
						{#if current}
							{detail(current)}
						{:else}
							{accounts.length === 1 ? '1 account' : `${accounts.length} accounts`}
						{/if}
					</span>
				</span>
				{#if failing}
					<AlertTriangle class="size-3.5 shrink-0 text-destructive" />
					<span class="sr-only">Connection problem.</span>
				{/if}
				<ChevronsUpDown class="size-4 shrink-0 text-muted-foreground" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content
		class="w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-(--bits-dropdown-menu-anchor-width)"
	>
		{@render option(null)}
		<DropdownMenu.Separator />
		<DropdownMenu.Group aria-label="Accounts">
			{#each accounts as account (account.id)}
				{@render option(account)}
			{/each}
		</DropdownMenu.Group>
		<DropdownMenu.Separator />
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a {...props} href={resolve('/(app)/settings/accounts/new')}>
					<Plus />
					Add account
				</a>
			{/snippet}
		</DropdownMenu.Item>
		<DropdownMenu.Item>
			{#snippet child({ props })}
				<a {...props} href={resolve('/(app)/settings/accounts')}>
					<Settings />
					Manage accounts
				</a>
			{/snippet}
		</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
