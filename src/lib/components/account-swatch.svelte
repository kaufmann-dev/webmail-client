<script lang="ts">
	import type { AccountColor } from '#lib/mail-types.js';

	let { color, class: className = '' }: { color: AccountColor; class?: string } = $props();
</script>

<span
	aria-hidden="true"
	class={['inline-block size-2.5 shrink-0 rounded-[3px]', className]}
	style:background="var(--account-{color})"
></span>
