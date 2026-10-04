<script lang="ts">
	import AppHeader from '#lib/components/app-header.svelte';

	let { data, children } = $props();
</script>

<div class="flex h-dvh flex-col">
	<AppHeader user={data.user} />
	<div class="mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col">
		{@render children()}
	</div>
</div>
