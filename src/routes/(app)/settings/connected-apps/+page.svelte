<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import AccessGrantFields from '#lib/components/access-grant-fields.svelte';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { postAction } from '#lib/form-action.js';

	let { data } = $props();

	let revoking = $state<{ clientId: string; name: string } | null>(null);
	// A revoked app disappears at once; revoking finishes in the background.
	const revoked = new SvelteSet<string>();
	const apps = $derived(data.apps.filter((app) => !revoked.has(app.clientId)));
	const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

	async function revoke(clientId: string) {
		revoked.add(clientId);
		const error = await postAction(`${resolve('/(app)/settings/connected-apps')}?/revoke`, {
			clientId
		});
		if (error) {
			revoked.delete(clientId);
			toast.error(error);
		}
		await invalidateAll();
	}
</script>

<svelte:head><title>Connected apps · Mail</title></svelte:head>

<section class="flex flex-col gap-4">
	<div class="flex flex-col gap-1">
		<h1 class="text-xl font-semibold">Connected apps</h1>
		<p class="text-sm text-muted-foreground">
			AI apps connected to the MCP server at <code class="text-foreground">/mcp</code>. Each app can
			only use the mail accounts you allow here. Changes apply to its next request.
		</p>
	</div>

	{#each apps as app (app.clientId)}
		<form
			method="POST"
			action="?/save"
			class="flex flex-col gap-3 border p-4"
			use:enhance={() =>
				async ({ result, update }) => {
					if (result.type === 'success') toast.success(`Saved access for ${app.name}`);
					await update({ reset: false });
				}}
		>
			<input type="hidden" name="clientId" value={app.clientId} />
			<div class="flex flex-wrap items-baseline justify-between gap-2">
				<h2 class="min-w-0 truncate font-medium">{app.name}</h2>
				<span class="text-xs text-muted-foreground"
					>Authorized {longDate.format(app.grantedAt)}</span
				>
			</div>
			{#if data.accounts.length}
				<AccessGrantFields accounts={data.accounts} access={app.access} idPrefix={app.clientId} />
			{:else}
				<p class="text-sm text-muted-foreground">Add a mail account first.</p>
			{/if}
			<div class="flex flex-wrap gap-2">
				<Button type="submit" size="sm" disabled={!data.accounts.length}>Save access</Button>
				<span class="flex-1"></span>
				<Button
					variant="ghost"
					size="sm"
					class="text-destructive"
					onclick={() => (revoking = { clientId: app.clientId, name: app.name })}
				>
					Revoke
				</Button>
			</div>
		</form>
	{:else}
		<div class="flex flex-col gap-2 border p-4 text-sm">
			<p class="font-medium">No apps connected yet</p>
			<p class="text-muted-foreground">
				Add this server's <code class="text-foreground">/mcp</code> URL as a remote MCP server in Claude,
				ChatGPT, or another MCP client. You choose the accounts it may use when you approve it.
			</p>
		</div>
	{/each}
</section>

<AlertDialog.Root
	open={revoking !== null}
	onOpenChange={(open) => {
		if (!open) revoking = null;
	}}
>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Revoke {revoking?.name}?</AlertDialog.Title>
			<AlertDialog.Description>
				It loses access to all mail accounts and has to be authorized again.
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-white hover:bg-destructive/90"
				onclick={() => {
					if (revoking) revoke(revoking.clientId);
					revoking = null;
				}}>Revoke</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
