<script lang="ts">
	import type { Tooltip as TooltipPrimitive } from 'bits-ui';
	import { Button, type ButtonProps } from '#lib/components/ui/button/index.js';
	import { Kbd } from '#lib/components/ui/kbd/index.js';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';

	let {
		tooltip,
		shortcut,
		children,
		...restProps
	}: ButtonProps & {
		/** Says what the button does; the button still needs its own accessible label. */
		tooltip: string;
		shortcut?: string;
	} = $props();
</script>

<!-- Tooltip.Trigger merges the button's props (and an enclosing dropdown trigger's) with its own,
     chaining event handlers. The triggers' data-slot would replace the button's, which toolbar
     styles select on. -->
<Tooltip.Root>
	<Tooltip.Trigger {...restProps as TooltipPrimitive.TriggerProps}>
		{#snippet child({ props })}
			<Button {...props} data-slot="button">{@render children?.()}</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content>
		{tooltip}
		{#if shortcut}<Kbd>{shortcut}</Kbd>{/if}
	</Tooltip.Content>
</Tooltip.Root>
