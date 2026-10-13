<script module lang="ts">
	import type { FolderEntry } from '#lib/move-targets.js';

	/** A folder change asked for in the sidebar. */
	export type FolderRequest =
		| { kind: 'create'; accountId: string; parent: FolderEntry | null }
		| { kind: 'rename' | 'delete'; accountId: string; folder: FolderEntry };
</script>

<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';

	let {
		request,
		gmail = false,
		onsubmit,
		onclose
	}: {
		request: FolderRequest | null;
		/** Gmail folders are labels: deleting one keeps its messages in All Mail. */
		gmail?: boolean;
		/** `name` is the trimmed new name; empty when deleting. */
		onsubmit: (request: FolderRequest, name: string) => void;
		onclose: () => void;
	} = $props();

	const naming = $derived(request && request.kind !== 'delete' ? request : null);
	const deleting = $derived(request?.kind === 'delete' ? request.folder : null);
	let name = $derived(request?.kind === 'rename' ? request.folder.name : '');

	const title = $derived.by(() => {
		if (naming?.kind === 'rename') return `Rename “${naming.folder.name}”`;
		if (naming?.kind === 'create' && naming.parent) return `New folder in “${naming.parent.name}”`;
		return 'New folder';
	});

	function submit(event: SubmitEvent) {
		event.preventDefault();
		if (naming && name.trim()) onsubmit(naming, name.trim());
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
