<script lang="ts">
	import { enhance } from '$app/forms';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { authClient } from '#lib/auth-client.js';
	import AccessGrantFields from '#lib/components/access-grant-fields.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	let { data } = $props();
	let pending = $state<'accept' | 'deny' | null>(null);
	let error = $state<string | null>(null);

	async function finish(accept: boolean) {
		const result = await authClient.oauth2.consent({ accept });
		if (result.error || !result.data?.url) {
			error =
				result.error?.message ?? 'The authorization request expired. Start again from the app.';
			pending = null;
			return;
		}
		window.location.assign(result.data.url);
	}
</script>

<svelte:head><title>Authorize {data.client.name} · Mail</title></svelte:head>

<main class="mx-auto flex max-w-xl flex-col gap-6 px-4 py-16">
	<div class="flex flex-col gap-2">
		<ShieldCheck class="size-6" />
		<h1 class="text-2xl font-semibold break-words">Allow {data.client.name} to use your mail?</h1>
		{#if data.client.redirectHosts.length}
			<p class="text-sm break-words text-muted-foreground">
				You will be returned to {data.client.redirectHosts.join(', ')}.
			</p>
		{/if}
	</div>

	<form
		method="POST"
		action="?/grant"
		class="flex flex-col gap-4"
		use:enhance={() => {
			pending = 'accept';
			error = null;
			return async ({ result }) => {
				if (result.type === 'success') return finish(true);
				error =
					result.type === 'failure'
						? String(result.data?.error ?? 'Could not save the access.')
						: 'Could not save the access.';
				pending = null;
			};
		}}
	>
		<div class="flex flex-col gap-2">
			<h2 class="font-medium">Choose which accounts it may use</h2>
			{#if data.accounts.length}
				<AccessGrantFields accounts={data.accounts} access={data.access} idPrefix="grant" />
			{:else}
				<p class="text-sm text-muted-foreground">
					You have no mail accounts yet. Add one in the webmail first, then connect again.
				</p>
			{/if}
		</div>

		{#if error}
			<Alert.Root variant="destructive">
				<Alert.Title class="wrap-anywhere">{error}</Alert.Title>
			</Alert.Root>
		{/if}

		<div class="flex flex-wrap justify-end gap-3">
			<Button
				variant="outline"
				disabled={pending !== null}
				onclick={() => {
					pending = 'deny';
					finish(false);
				}}
			>
				{#if pending === 'deny'}<Spinner aria-label="Denying" />{/if}
				Deny
			</Button>
			<Button type="submit" disabled={pending !== null || !data.accounts.length}>
				{#if pending === 'accept'}<Spinner aria-label="Allowing" />{/if}
				Allow
			</Button>
		</div>
		<p class="text-xs text-muted-foreground">
			You can change or revoke this at any time under Settings → Connected apps.
		</p>
	</form>
</main>
