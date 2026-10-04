<script lang="ts">
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import {
		ACCESS_LEVELS,
		ACCESS_LEVEL_DESCRIPTIONS,
		ACCESS_LEVEL_LABELS,
		type AccessLevel,
		type AccountSummary
	} from '#lib/mail-types.js';

	let {
		accounts,
		access,
		idPrefix,
		onchange
	}: {
		accounts: AccountSummary[];
		access: Record<string, AccessLevel>;
		idPrefix: string;
		onchange?: () => void;
	} = $props();
</script>

<div class="flex flex-col divide-y rounded-lg border">
	{#each accounts as account (account.id)}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
			<label for="{idPrefix}-{account.id}" class="flex min-w-0 flex-1 basis-48 items-center gap-2">
				<AccountSwatch color={account.color} />
				<span class="flex min-w-0 flex-col">
					<span class="truncate text-sm font-medium">{account.label}</span>
					<span class="truncate text-xs text-muted-foreground">{account.email}</span>
				</span>
			</label>
			<NativeSelect
				id="{idPrefix}-{account.id}"
				name="access:{account.id}"
				value={access[account.id] ?? 'none'}
				{onchange}
				class="w-48"
			>
				<NativeSelectOption value="none">No access</NativeSelectOption>
				{#each ACCESS_LEVELS as level (level)}
					<NativeSelectOption value={level}>{ACCESS_LEVEL_LABELS[level]}</NativeSelectOption>
				{/each}
			</NativeSelect>
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
</dl>
