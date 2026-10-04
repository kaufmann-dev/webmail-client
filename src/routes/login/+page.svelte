<script lang="ts">
	import LogIn from '@lucide/svelte/icons/log-in';
	import { authClient } from '#lib/auth-client.js';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';

	let { data } = $props();
	let pending = $state(false);
	let error = $state<string | null>(null);

	async function signIn() {
		pending = true;
		error = null;
		const result = await authClient.signIn.social({
			provider: 'pocket-id',
			callbackURL: data.returnTo,
			errorCallbackURL: `/login?error=1&returnTo=${encodeURIComponent(data.returnTo)}`
		});
		if (result.error) {
			error = result.error.message ?? 'Sign-in could not start. Try again.';
			pending = false;
		}
	}
</script>

<svelte:head><title>Sign in · Mail</title></svelte:head>

<main class="mx-auto flex max-w-sm flex-col gap-6 px-4 pt-24">
	<div class="flex flex-col gap-2">
		<h1 class="text-2xl font-semibold">Mail</h1>
		<p class="text-muted-foreground">
			{data.oauthRequest
				? 'Sign in to connect your AI app to your mail.'
				: 'Sign in to read and send mail from all your accounts.'}
		</p>
	</div>
	{#if data.failed || error}
		<Alert.Root variant="destructive">
			<Alert.Title>Sign-in failed</Alert.Title>
			<Alert.Description class="wrap-anywhere"
				>{error ?? 'Pocket ID did not complete the sign-in. Try again.'}</Alert.Description
			>
		</Alert.Root>
	{/if}
	<Button size="lg" onclick={signIn} disabled={pending}>
		{#if pending}
			<Spinner aria-label="Redirecting to Pocket ID" />
		{:else}
			<LogIn />
		{/if}
		Sign in with Pocket ID
	</Button>
	<nav aria-label="Legal" class="flex gap-4 text-sm">
		<a
			href="https://legal.kaufmann.dev/imprint?site=mail.kaufmann.dev"
			class="text-muted-foreground hover:text-foreground">Imprint</a
		>
		<a
			href="https://legal.kaufmann.dev/privacy?site=mail.kaufmann.dev"
			class="text-muted-foreground hover:text-foreground">Privacy</a
		>
	</nav>
</main>
