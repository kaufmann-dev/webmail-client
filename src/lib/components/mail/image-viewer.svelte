<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import TooltipButton from '#lib/components/tooltip-button.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	let { src, alt, onclose }: { src: string; alt: string; onclose: () => void } = $props();

	/** Shown at its natural size (scrolling) instead of fitted to the window. */
	let actual = $state(false);
	/** The fitted image is smaller than its natural size, so a click can enlarge it. */
	let zoomable = $state(false);

	function measure(event: Event) {
		const img = event.currentTarget as HTMLImageElement;
		zoomable = img.naturalWidth > img.clientWidth || img.naturalHeight > img.clientHeight;
	}
</script>

<!-- Centered with auto margins rather than `left-1/2`, which would cap the content at half the
     window's width. The close button sits above the image (1.75rem plus the gap), never on it. -->
<Dialog.Root open onOpenChange={(open) => !open && onclose()}>
	<Dialog.Content
		showCloseButton={false}
		onOpenAutoFocus={(event) => event.preventDefault()}
		class="right-0 left-0 mx-auto w-fit max-w-[calc(100%-2rem)] translate-x-0 justify-items-end gap-2 rounded-none bg-transparent p-0 ring-0 sm:max-w-[calc(100%-2rem)]"
	>
		<Dialog.Title class="sr-only">{alt || 'Image'}</Dialog.Title>
		<Dialog.Close>
			{#snippet child({ props })}
				<TooltipButton
					{...props}
					tooltip="Close"
					variant="ghost"
					size="icon-sm"
					class="bg-secondary"
				>
					<XIcon />
					<span class="sr-only">Close</span>
				</TooltipButton>
			{/snippet}
		</Dialog.Close>
		<!-- Mail images assume a white background, like the message frame. -->
		<div
			class="max-h-[calc(100dvh-4.5rem)] max-w-[calc(100vw-2rem)] overflow-auto rounded-lg bg-white"
		>
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<img
				{src}
				{alt}
				referrerpolicy="no-referrer"
				onload={measure}
				onclick={() => zoomable && (actual = !actual)}
				class={[
					'block',
					actual
						? 'max-w-none'
						: 'max-h-[calc(100dvh-4.5rem)] max-w-[calc(100vw-2rem)] object-contain',
					zoomable && (actual ? 'cursor-zoom-out' : 'cursor-zoom-in')
				]}
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>
