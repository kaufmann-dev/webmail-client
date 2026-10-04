<script lang="ts">
	import ComposeForm from '#lib/components/mail/compose-form.svelte';

	let { data } = $props();
</script>

{#key data.compose}
	<ComposeForm initial={data.compose} accounts={data.accounts} />
{/key}
