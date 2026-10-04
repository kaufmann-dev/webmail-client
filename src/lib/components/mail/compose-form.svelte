<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { toast } from 'svelte-sonner';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Send from '@lucide/svelte/icons/send';
	import X from '@lucide/svelte/icons/x';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { fileSize } from '#lib/format.js';
	import type { AccountSummary, AttachmentInfo, ComposeState } from '#lib/mail-types.js';

	let { initial: props, accounts }: { initial: ComposeState; accounts: AccountSummary[] } =
		$props();

	// The editor owns its state after loading; the page re-creates it for each new compose URL.
	const initial = untrack(() => props);
	let accountId = $state(initial.accountId);
	let draftRef = $state(initial.replacesDraftRef);
	let carriedRef = $state(initial.carriedRef);
	let carried = $state<AttachmentInfo[]>(initial.carried);
	let files = $state<File[]>([]);
	let showCopies = $state(Boolean(initial.cc || initial.bcc));
	let dirty = $state(false);
	let pending = $state<'send' | 'save' | 'discard' | null>(null);
	let error = $state<string | null>(null);
	let confirmDiscard = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let form = $state<HTMLFormElement | null>(null);
	let discardButton = $state<HTMLButtonElement | null>(null);

	const account = $derived(accounts.find((a) => a.id === accountId));
	const heading = { new: 'New message', reply: 'Reply', forward: 'Forward', draft: 'Draft' }[
		initial.mode
	];

	function leave() {
		dirty = false;
		if (history.length > 1) history.back();
		else goto(resolve('/(app)/mail/[scope]/[...folder]', { scope: 'all', folder: 'inbox' }));
	}

	beforeNavigate((navigation) => {
		if (dirty && !confirm('Discard your unsaved changes?')) navigation.cancel();
	});

	function addFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		files = [...files, ...(input.files ?? [])];
		input.value = '';
		dirty = true;
	}

	const submit: SubmitFunction = ({ formData, action, cancel }) => {
		const kind = action.search.includes('discard')
			? 'discard'
			: action.search.includes('save')
				? 'save'
				: 'send';
		if (kind === 'send' && !String(formData.get('to') ?? '').trim()) {
			error = 'Add at least one recipient.';
			cancel();
			return;
		}
		formData.delete('files');
		for (const file of files) formData.append('files', file);
		pending = kind;
		error = null;
		return async ({ result }) => {
			pending = null;
			if (result.type === 'failure') {
				error = String(result.data?.error ?? 'Something went wrong.');
				return;
			}
			if (result.type === 'error') {
				error = result.error?.message ?? 'Something went wrong.';
				return;
			}
			if (result.type !== 'success') return;
			if (kind === 'save' && result.data) {
				draftRef = String(result.data.draftRef);
				carriedRef = draftRef;
				carried = result.data.carried as AttachmentInfo[];
				files = [];
				dirty = false;
				toast.success('Draft saved');
				return;
			}
			toast.success(kind === 'send' ? 'Message sent' : 'Draft discarded');
			leave();
		};
	};
</script>

<svelte:head><title>{heading} · Mail</title></svelte:head>

<div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto px-4 py-6">
	<h1 class="mb-4 text-xl font-semibold">{heading}</h1>

	{#if !accounts.length}
		<p class="text-sm">
			Add a mail account before writing messages.
			<a class="underline" href={resolve('/(app)/settings/accounts/new')}>Add account</a>
		</p>
	{:else}
		<form
			bind:this={form}
			method="POST"
			action="?/send"
			enctype="multipart/form-data"
			use:enhance={submit}
			oninput={() => (dirty = true)}
			class="flex flex-col gap-4"
		>
			<input type="hidden" name="inReplyTo" value={initial.inReplyTo} />
			<input type="hidden" name="references" value={initial.references} />
			<input type="hidden" name="answersRef" value={initial.answersRef} />
			<input type="hidden" name="replacesDraftRef" value={draftRef} />
			<input type="hidden" name="carriedRef" value={carriedRef} />
			{#each carried as attachment (attachment.partId)}
				<input type="hidden" name="carriedPart" value={attachment.partId} />
			{/each}
			<button
				bind:this={discardButton}
				type="submit"
				formaction="?/discard"
				class="hidden"
				tabindex="-1"
				aria-hidden="true"
			></button>

			<div class="grid gap-1.5">
				<Label for="from">From</Label>
				<div class="flex items-center gap-2">
					{#if account}<AccountSwatch color={account.color} />{/if}
					<NativeSelect id="from" name="accountId" bind:value={accountId} class="min-w-0 flex-1">
						{#each accounts as option (option.id)}
							<NativeSelectOption value={option.id}>
								{option.displayName} &lt;{option.email}&gt;
							</NativeSelectOption>
						{/each}
					</NativeSelect>
				</div>
			</div>

			<div class="grid gap-1.5">
				<div class="flex items-center justify-between">
					<Label for="to">To</Label>
					{#if !showCopies}
						<Button variant="link" size="sm" class="h-auto p-0" onclick={() => (showCopies = true)}>
							Cc / Bcc
						</Button>
					{/if}
				</div>
				<Input
					id="to"
					name="to"
					value={initial.to}
					autocomplete="email"
					placeholder="name@example.com, …"
				/>
			</div>
			{#if showCopies}
				<div class="grid gap-1.5">
					<Label for="cc">Cc</Label>
					<Input id="cc" name="cc" value={initial.cc} autocomplete="email" />
				</div>
				<div class="grid gap-1.5">
					<Label for="bcc">Bcc</Label>
					<Input id="bcc" name="bcc" value={initial.bcc} autocomplete="email" />
				</div>
			{:else}
				<input type="hidden" name="cc" value={initial.cc} />
				<input type="hidden" name="bcc" value={initial.bcc} />
			{/if}

			<div class="grid gap-1.5">
				<Label for="subject">Subject</Label>
				<Input id="subject" name="subject" value={initial.subject} />
			</div>

			<div class="grid gap-1.5">
				<Label for="body">Message</Label>
				<Textarea
					id="body"
					name="body"
					value={initial.body}
					rows={16}
					class="min-h-64 font-mono text-sm"
					autofocus={initial.mode !== 'new'}
				/>
			</div>

			<div class="flex flex-col gap-2">
				{#if carried.length || files.length}
					<ul class="flex flex-wrap gap-2" aria-label="Attachments">
						{#each carried as attachment (attachment.partId)}
							<li class="flex max-w-72 items-center gap-2 border px-2 py-1 text-sm">
								<span class="min-w-0 truncate">{attachment.filename}</span>
								<span class="shrink-0 text-xs text-muted-foreground"
									>{fileSize(attachment.size)}</span
								>
								<button
									type="button"
									class="shrink-0"
									aria-label="Remove {attachment.filename}"
									onclick={() => {
										carried = carried.filter((a) => a !== attachment);
										dirty = true;
									}}><X class="size-4" /></button
								>
							</li>
						{/each}
						{#each files as file, index (index)}
							<li class="flex max-w-72 items-center gap-2 border px-2 py-1 text-sm">
								<span class="min-w-0 truncate">{file.name}</span>
								<span class="shrink-0 text-xs text-muted-foreground">{fileSize(file.size)}</span>
								<button
									type="button"
									class="shrink-0"
									aria-label="Remove {file.name}"
									onclick={() => (files = files.filter((_, i) => i !== index))}
									><X class="size-4" /></button
								>
							</li>
						{/each}
					</ul>
				{/if}
				<input
					bind:this={fileInput}
					type="file"
					multiple
					class="sr-only"
					tabindex="-1"
					onchange={addFiles}
				/>
				<div>
					<Button variant="outline" size="sm" onclick={() => fileInput?.click()}>
						<Paperclip />
						Attach files
					</Button>
				</div>
			</div>

			{#if error}
				<Alert.Root variant="destructive">
					<Alert.Title class="wrap-anywhere">{error}</Alert.Title>
				</Alert.Root>
			{/if}

			<div class="flex flex-wrap items-center gap-2 border-t pt-4">
				<Button type="submit" disabled={pending !== null}>
					{#if pending === 'send'}<Spinner aria-label="Sending" />{:else}<Send />{/if}
					Send
				</Button>
				<Button type="submit" variant="outline" formaction="?/save" disabled={pending !== null}>
					{#if pending === 'save'}<Spinner aria-label="Saving" />{/if}
					Save draft
				</Button>
				<span class="flex-1"></span>
				<Button
					variant="ghost"
					class="text-destructive"
					disabled={pending !== null}
					onclick={() => (draftRef ? (confirmDiscard = true) : leave())}
				>
					Discard
				</Button>
			</div>
		</form>
	{/if}
</div>

<AlertDialog.Root bind:open={confirmDiscard}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Discard this draft?</AlertDialog.Title>
			<AlertDialog.Description
				>The saved draft is deleted from the Drafts folder.</AlertDialog.Description
			>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Keep</AlertDialog.Cancel>
			<AlertDialog.Action
				class="bg-destructive text-white hover:bg-destructive/90"
				onclick={() => {
					confirmDiscard = false;
					form?.requestSubmit(discardButton ?? undefined);
				}}>Discard</AlertDialog.Action
			>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
