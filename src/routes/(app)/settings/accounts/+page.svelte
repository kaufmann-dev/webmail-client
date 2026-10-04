<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Plus from '@lucide/svelte/icons/plus';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { postAction } from '#lib/form-action.js';
	import { ACCOUNT_COLORS, PROVIDER_LABELS, type AccountSummary } from '#lib/mail-types.js';

	let { data, form } = $props();

	let removing = $state<AccountSummary | null>(null);
	// Removing and reordering show at once and are saved in the background.
	const removed = new SvelteSet<string>();
	let localOrder = $state<string[] | null>(null);
	let queuedMoves = 0;
	let moves = Promise.resolve();

	const accounts = $derived.by(() => {
		const byId = new Map(data.accounts.map((a) => [a.id, a]));
		const ordered = localOrder ? localOrder.flatMap((id) => byId.get(id) ?? []) : data.accounts;
		return ordered.filter((a) => !removed.has(a.id));
	});

	const connected = $derived(page.url.searchParams.get('connected'));
	const actionUrl = (name: string) => `${resolve('/(app)/settings/accounts')}?/${name}`;

	/** Saves moves one after another, so each applies to the order the one before left. */
	function moveAccount(id: string, direction: 'up' | 'down') {
		const order = accounts.map((a) => a.id);
		const from = order.indexOf(id);
		const to = from + (direction === 'up' ? -1 : 1);
		if (from < 0 || to < 0 || to >= order.length) return;
		[order[from], order[to]] = [order[to], order[from]];
		localOrder = order;
		queuedMoves++;
		moves = moves.then(async () => {
			const error = await postAction(actionUrl('move'), { id, direction });
			if (error) toast.error(error);
			if (--queuedMoves > 0 && !error) return;
			await invalidateAll();
			if (queuedMoves === 0) localOrder = null;
		});
	}

	async function removeAccount(id: string) {
		removed.add(id);
		const error = await postAction(actionUrl('delete'), { id });
		if (error) {
			removed.delete(id);
			toast.error(error);
		}
		await invalidateAll();
	}
</script>

<svelte:head><title>Mail accounts · Mail</title></svelte:head>

<section class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h1 class="text-xl font-semibold">Mail accounts</h1>
		<Button href={resolve('/(app)/settings/accounts/new')} size="sm">
			<Plus />
			Add account
		</Button>
	</div>

	{#if connected}
		<Alert.Root>
			<Alert.Title>Account connected</Alert.Title>
		</Alert.Root>
	{/if}

	{#each accounts as account, index (account.id)}
		<article class="flex flex-col border" aria-labelledby="account-{account.id}">
			<div class="flex flex-wrap items-center gap-3 p-3">
				<AccountSwatch color={account.color} class="size-3" />
				<div class="flex min-w-0 flex-1 flex-col">
					<h2 id="account-{account.id}" class="truncate font-medium">{account.label}</h2>
					<span class="truncate text-sm text-muted-foreground">
						{account.email} · {PROVIDER_LABELS[account.provider]}
					</span>
				</div>
				<div class="flex">
					<Button
						variant="ghost"
						size="sm"
						disabled={index === 0}
						aria-label="Move {account.label} up"
						onclick={() => moveAccount(account.id, 'up')}
					>
						<ArrowUp />
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={index === accounts.length - 1}
						aria-label="Move {account.label} down"
						onclick={() => moveAccount(account.id, 'down')}
					>
						<ArrowDown />
					</Button>
				</div>
			</div>
			{#if account.lastError}
				<div class="flex flex-wrap items-center gap-2 border-t bg-muted px-3 py-2 text-sm">
					<span class="min-w-0 flex-1 wrap-anywhere">{account.lastError}</span>
					{#if account.provider === 'microsoft'}
						<Button
							href="/accounts/microsoft/connect?email={encodeURIComponent(account.email)}"
							size="sm"
							variant="outline"
							data-sveltekit-reload>Reconnect</Button
						>
					{/if}
				</div>
			{/if}
			<details class="border-t">
				<summary class="cursor-pointer px-3 py-2 text-sm">Edit</summary>
				<form
					method="POST"
					action="?/update"
					class="grid gap-4 p-3 pt-1"
					use:enhance={() =>
						async ({ result, update }) => {
							if (result.type === 'success') toast.success('Account saved');
							await update({ reset: false });
						}}
				>
					<input type="hidden" name="id" value={account.id} />
					<div class="grid gap-4 sm:grid-cols-2">
						<div class="grid gap-1.5">
							<Label for="label-{account.id}">Label</Label>
							<Input id="label-{account.id}" name="label" value={account.label} />
						</div>
						<div class="grid gap-1.5">
							<Label for="name-{account.id}">Sender name</Label>
							<Input id="name-{account.id}" name="displayName" value={account.displayName} />
						</div>
					</div>
					<div class="grid gap-1.5">
						<Label for="color-{account.id}">Color</Label>
						<div class="flex items-center gap-2">
							<AccountSwatch color={account.color} />
							<NativeSelect
								id="color-{account.id}"
								name="color"
								value={account.color}
								class="w-40 capitalize"
							>
								{#each ACCOUNT_COLORS as color (color)}
									<NativeSelectOption value={color}>{color}</NativeSelectOption>
								{/each}
							</NativeSelect>
						</div>
					</div>
					<div class="grid gap-1.5">
						<Label for="signature-{account.id}">Signature</Label>
						<Textarea
							id="signature-{account.id}"
							name="signature"
							value={account.signature ?? ''}
							rows={4}
						/>
					</div>
					{#if account.provider !== 'microsoft'}
						<div class="grid gap-1.5">
							<Label for="password-{account.id}">New password</Label>
							<Input
								id="password-{account.id}"
								name="password"
								type="password"
								autocomplete="new-password"
								placeholder="Leave empty to keep the current one"
							/>
						</div>
					{/if}
					{#if form?.id === account.id && form?.error}
						<p class="text-sm wrap-anywhere text-destructive" role="alert">{form.error}</p>
					{/if}
					<div class="flex flex-wrap gap-2">
						<Button type="submit" size="sm">Save</Button>
						<span class="flex-1"></span>
						<Button
							variant="ghost"
							size="sm"
							class="text-destructive"
							onclick={() => (removing = account)}
						>
							Remove account
						</Button>
					</div>
				</form>
			</details>
		</article>
	{:else}
		<div class="flex flex-col items-start gap-2 border p-4 text-sm">
			<p class="font-medium">No mail accounts yet</p>
			<p class="text-muted-foreground">Add your Gmail, Purelymail, or Microsoft 365 accounts.</p>
		</div>
	{/each}
</section>

<AlertDialog.Root
	open={removing !== null}
	onOpenChange={(open) => {
		if (!open) removing = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Remove {removing?.email}?</AlertDialog.Title>
			<AlertDialog.Description>
				The app forgets its credentials and AI apps lose access to it. No mail is deleted from the
				mailbox.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-white hover:bg-destructive/90"
				onclick={() => {
					if (removing) removeAccount(removing.id);
					removing = null;
				}}>Remove</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
