<script lang="ts">
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

<!-- Mail images assume a white background, like the message frame. -->
<Dialog.Root open onOpenChange={(open) => !open && onclose()}>
	<Dialog.Content
		class="w-auto gap-0 overflow-hidden bg-white p-0 ring-0 sm:max-w-[calc(100%-2rem)]"
	>
		<Dialog.Title class="sr-only">{alt || 'Image'}</Dialog.Title>
		<div class="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-auto">
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
						: 'max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] object-contain',
					zoomable && (actual ? 'cursor-zoom-out' : 'cursor-zoom-in')
				]}
			/>
		</div>
	</Dialog.Content>
</Dialog.Root>
