<script lang="ts">
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		ACCESS_LEVELS,
		ACCESS_LEVEL_DESCRIPTIONS,
		ACCESS_LEVEL_LABELS,
		MAX_AGE_DAYS,
		type AccessLevel,
		type AccountGrant,
		type AccountSummary
	} from '#lib/mail-types.js';

	let {
		accounts,
		access,
		idPrefix
	}: {
		accounts: AccountSummary[];
		access: Record<string, AccountGrant>;
		idPrefix: string;
	} = $props();

	// The limits only apply to granted accounts, so they show once a level is chosen.
	// svelte-ignore state_referenced_locally
	let levels = $state<Record<string, AccessLevel | 'none'>>(
		Object.fromEntries(accounts.map((a) => [a.id, access[a.id]?.level ?? 'none']))
	);
</script>

<div class="flex flex-col divide-y rounded-lg border">
	{#each accounts as account (account.id)}
		{@const id = `${idPrefix}-${account.id}`}
		{@const grant = access[account.id]}
		<div class="flex flex-col gap-2 p-3">
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				<label for={id} class="flex min-w-0 flex-1 basis-48 items-center gap-2">
					<AccountSwatch color={account.color} />
					<span class="flex min-w-0 flex-col">
						<span class="truncate text-sm font-medium">{account.label}</span>
						<span class="truncate text-xs text-muted-foreground">{account.email}</span>
					</span>
				</label>
				<NativeSelect {id} name="access:{account.id}" bind:value={levels[account.id]} class="w-48">
					<NativeSelectOption value="none">No access</NativeSelectOption>
					{#each ACCESS_LEVELS as level (level)}
						<NativeSelectOption value={level}>{ACCESS_LEVEL_LABELS[level]}</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
			{#if (levels[account.id] ?? 'none') !== 'none'}
				<div class="flex flex-wrap items-center gap-x-6 gap-y-2 pl-4.5">
					<div class="flex items-center gap-2">
						<label for="{id}-age" class="text-sm text-muted-foreground">Messages</label>
						<NativeSelect
							id="{id}-age"
							name="maxAge:{account.id}"
							value={grant?.maxAgeDays ? String(grant.maxAgeDays) : ''}
							size="sm"
							class="w-36"
						>
							<NativeSelectOption value="">Any age</NativeSelectOption>
							{#each MAX_AGE_DAYS as days (days)}
								<NativeSelectOption value={String(days)}>Last {days} days</NativeSelectOption>
							{/each}
						</NativeSelect>
					</div>
					<div class="flex items-center gap-2">
						<Checkbox
							id="{id}-attachments"
							name="attachments:{account.id}"
							checked={grant?.allowAttachments ?? true}
						/>
						<label for="{id}-attachments" class="text-sm text-muted-foreground"
							>Allow attachments</label
						>
					</div>
				</div>
			{/if}
		</div>
	{/each}
</div>
<dl class="mt-2 grid gap-1 text-xs text-muted-foreground">
	{#each ACCESS_LEVELS as level (level)}
		<div>
			<dt class="inline font-medium">{ACCESS_LEVEL_LABELS[level]}:</dt>
			<dd class="inline">{ACCESS_LEVEL_DESCRIPTIONS[level]}</dd>
		</div>
	{/each}
	<div>
		<dt class="inline font-medium">Limits:</dt>
		<dd class="inline">
			Older messages, and attachments when not allowed, stay hidden from the app, even when it
			reads, replies to, or forwards a message.
		</dd>
	</div>
</dl>
