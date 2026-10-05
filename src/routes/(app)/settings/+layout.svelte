<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';

	let { children } = $props();

	const tabs = [
		{ href: resolve('/(app)/settings/accounts'), label: 'Mail accounts' },
		{ href: resolve('/(app)/settings/connected-apps'), label: 'Connected apps' }
	];
</script>

<div class="relative min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
		<nav aria-label="Settings" class="flex gap-1 border-b">
			{#each tabs as tab (tab.href)}
				{@const active = page.url.pathname.startsWith(tab.href)}
				<a
					href={tab.href}
					aria-current={active ? 'page' : undefined}
					class={[
						'-mb-px border-b-2 px-3 py-2 text-sm',
						active
							? 'border-foreground font-medium'
							: 'border-transparent text-muted-foreground hover:text-foreground'
					]}>{tab.label}</a
				>
			{/each}
		</nav>
		{@render children()}
	</div>
</div>
