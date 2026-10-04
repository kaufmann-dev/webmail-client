<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import { Button } from '#lib/components/ui/button/index.js';

	let { value, label }: { value: string; label: string } = $props();
	let copied = $state(false);

	async function copy() {
		await navigator.clipboard.writeText(value);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<div class="flex items-stretch rounded-md border">
	<code class="min-w-0 flex-1 overflow-x-auto px-3 py-2 text-sm whitespace-pre">{value}</code>
	<Button
		variant="ghost"
		size="icon"
		onclick={copy}
		aria-label={copied ? 'Copied' : `Copy ${label}`}
	>
		{#if copied}<Check />{:else}<Copy />{/if}
	</Button>
</div>
