<script lang="ts">
	import { enhance } from '$app/forms';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { PROVIDER_LABELS, type Provider } from '#lib/mail-types.js';

	let { data, form } = $props();

	// svelte-ignore state_referenced_locally
	let provider = $state<Provider>((form?.provider as Provider) || 'gmail');
	let pending = $state(false);

	const HELP: Record<Provider, string> = {
		gmail:
			'Use a Google app password, not your Google password. It requires 2-Step Verification: Google Account → Security → App passwords.',
		purelymail:
			'Use your Purelymail password, or an app password if two-factor authentication is on.',
		microsoft:
			'Sign in with Microsoft. Your organization may require an administrator to approve this app.'
	};
</script>

<svelte:head><title>Add account · Mail</title></svelte:head>

<section class="flex flex-col gap-6">
	<h1 class="text-xl font-semibold">Add account</h1>

	<fieldset class="flex flex-col gap-2">
		<legend class="mb-2 text-sm font-medium">Provider</legend>
		<div class="flex flex-wrap gap-2">
			{#each ['gmail', 'purelymail', 'microsoft'] as const as option (option)}
				<label
					class={[
						'flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm',
						provider === option
							? 'border-primary bg-accent font-medium text-accent-foreground'
							: 'hover:bg-muted'
					]}
				>
					<input type="radio" name="provider-choice" value={option} bind:group={provider} />
					{PROVIDER_LABELS[option]}
				</label>
			{/each}
		</div>
		<p class="text-sm text-muted-foreground">{HELP[provider]}</p>
	</fieldset>

	{#if provider === 'microsoft'}
		{#if !data.microsoftAvailable}
			<Alert.Root>
				<Alert.Title>Microsoft accounts are not set up on this server</Alert.Title>
				<Alert.Description>
					Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET for an Entra app registration (see the
					README).
				</Alert.Description>
			</Alert.Root>
		{:else}
			<form
				method="GET"
				action="/accounts/microsoft/connect"
				data-sveltekit-reload
				class="flex flex-col gap-4"
			>
				<div class="grid gap-1.5">
					<Label for="ms-email">Email address</Label>
					<Input id="ms-email" name="email" type="email" required autocomplete="email" />
				</div>
				{#if data.microsoftError}
					<p class="text-sm wrap-anywhere text-destructive" role="alert">{data.microsoftError}</p>
				{/if}
				<div><Button type="submit">Continue with Microsoft</Button></div>
			</form>
		{/if}
	{:else}
		<form
			method="POST"
			action="?/create"
			class="flex flex-col gap-4"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					await update({ reset: false });
					pending = false;
				};
			}}
		>
			<input type="hidden" name="provider" value={provider} />
			<div class="grid gap-1.5">
				<Label for="email">Email address</Label>
				<Input
					id="email"
					name="email"
					type="email"
					required
					autocomplete="email"
					value={form?.email ?? ''}
				/>
			</div>
			<div class="grid gap-1.5">
				<Label for="displayName">Sender name</Label>
				<Input
					id="displayName"
					name="displayName"
					autocomplete="name"
					value={form?.displayName ?? ''}
				/>
			</div>
			<div class="grid gap-1.5">
				<Label for="password">{provider === 'gmail' ? 'App password' : 'Password'}</Label>
				<Input id="password" name="password" type="password" required autocomplete="off" />
			</div>
			{#if form?.error}
				<Alert.Root variant="destructive">
					<Alert.Title class="wrap-anywhere">{form.error}</Alert.Title>
				</Alert.Root>
			{/if}
			<div>
				<Button type="submit" disabled={pending}>
					{#if pending}<Spinner aria-label="Testing connection" />{/if}
					Test and add
				</Button>
			</div>
		</form>
	{/if}
</section>
