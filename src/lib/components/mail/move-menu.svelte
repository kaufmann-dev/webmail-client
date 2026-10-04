<script lang="ts">
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { FOLDER_ROLE_LABELS } from '#lib/mail-types.js';
	import type { MoveDestination } from '#lib/move-targets.js';

	let {
		destinations,
		onmove
	}: {
		destinations: MoveDestination[];
		onmove: (key: string) => void;
	} = $props();
</script>

{#if destinations.length}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props} variant="ghost" size="sm" title="Move to folder">
					<FolderInput />
					<span class="sr-only">Move to folder</span>
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="max-h-80 max-w-72 overflow-y-auto">
			{#each destinations as destination (destination.key)}
				<DropdownMenu.Item onSelect={() => onmove(destination.key)}>
					<span class="truncate"
						>{destination.role ? FOLDER_ROLE_LABELS[destination.role] : destination.key}</span
					>
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/if}
