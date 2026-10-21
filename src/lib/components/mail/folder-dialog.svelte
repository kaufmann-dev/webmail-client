<script module lang="ts">
	import type { FolderEntry } from '#lib/move-targets.js';

	/** A folder change asked for in the sidebar. */
	export type FolderRequest =
		| { kind: 'create'; accountId: string; parent: FolderEntry | null }
		| { kind: 'rename' | 'move' | 'delete'; accountId: string; folder: FolderEntry };
</script>

<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { moveParents, parentPath } from '#lib/folder-tree.js';
	import { FOLDER_ROLE_LABELS } from '#lib/mail-types.js';

	let {
		request,
		folders = [],
		gmail = false,
		onsubmit,
		onclose
	}: {
		request: FolderRequest | null;
		/** The folders of the request's account, to move a folder into. */
		folders?: FolderEntry[];
		/**
		 * Gmail folders are labels: deleting one keeps its messages in All Mail, and none can sit
		 * below a role folder.
		 */
		gmail?: boolean;
		/**
		 * `value` is the trimmed new name, or the destination path when moving (empty for the top
		 * level); empty when deleting.
		 */
		onsubmit: (request: FolderRequest, value: string) => void;
		onclose: () => void;
	} = $props();

	const naming = $derived(
		request?.kind === 'create' || request?.kind === 'rename' ? request : null
	);
	const moving = $derived(request?.kind === 'move' ? request : null);
	const deleting = $derived(request?.kind === 'delete' ? request.folder : null);
	let name = $derived(request?.kind === 'rename' ? request.folder.name : '');
	const currentParent = $derived(moving ? (parentPath(moving.folder) ?? '') : '');
	let destination = $derived(currentParent);
	const destinations = $derived(
		moving ? moveParents(moving.folder, folders, { roles: !gmail }) : []
	);

	const title = $derived.by(() => {
		if (naming?.kind === 'rename') return `Rename “${naming.folder.name}”`;
		if (naming?.kind === 'create' && naming.parent) return `New folder in “${naming.parent.name}”`;
		return 'New folder';
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (naming && name.trim()) onsubmit(naming, name.trim());
	}

	function submitMove(event: SubmitEvent) {
		event.preventDefault();
		if (moving && destination !== currentParent) onsubmit(moving, destination);
	}

	const closed = (open: boolean) => {
		if (!open) onclose();
	};
</script>

<Dialog.Root open={naming !== null} onOpenChange={closed}>
	<Dialog.Content>
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>{title}</Dialog.Title>
			</Dialog.Header>
			<div class="flex flex-col gap-2">
				<Label for="folder-name">Name</Label>
				<Input
					id="folder-name"
					value={name}
					oninput={(event) => (name = event.currentTarget.value)}
					maxlength={100}
					autocomplete="off"
					required
				/>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={onclose}>Cancel</Button>
				<Button type="submit" disabled={!name.trim()}>
					{naming?.kind === 'rename' ? 'Rename' : 'Create'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={moving !== null} onOpenChange={closed}>
	<Dialog.Content>
		<form class="flex flex-col gap-4" onsubmit={submitMove}>
			<Dialog.Header>
				<Dialog.Title>Move “{moving?.folder.name}”</Dialog.Title>
			</Dialog.Header>
			<div class="flex flex-col gap-2">
				<Label for="folder-destination">Move to</Label>
				<NativeSelect id="folder-destination" bind:value={destination} class="w-full">
					<NativeSelectOption value="">Top level</NativeSelectOption>
					{#each destinations as { folder, depth } (folder.path)}
						<NativeSelectOption value={folder.path}>
							{'\u00a0\u00a0'.repeat(depth + 1)}{folder.role
								? FOLDER_ROLE_LABELS[folder.role]
								: folder.name}
						</NativeSelectOption>
					{/each}
				</NativeSelect>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={onclose}>Cancel</Button>
				<Button type="submit" disabled={destination === currentParent}>Move</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<AlertDialog.Root open={deleting !== null} onOpenChange={closed}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Delete “{deleting?.name}”?</AlertDialog.Title>
			<AlertDialog.Description>
				{gmail
					? 'The label and its sublabels are removed. Their messages stay in All Mail.'
					: 'Its subfolders and all messages in them are deleted. This cannot be undone.'}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-white hover:bg-destructive/90"
				onclick={() => request && onsubmit(request, '')}>Delete</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
