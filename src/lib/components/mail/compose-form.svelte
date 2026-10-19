<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance, type ActionResult, type SubmitFunction } from '$app/forms';
	import { afterNavigate, beforeNavigate, goto, invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import Paperclip from '@lucide/svelte/icons/paperclip';
	import Send from '@lucide/svelte/icons/send';
	import X from '@lucide/svelte/icons/x';
	import AccountSwatch from '#lib/components/account-swatch.svelte';
	import TooltipButton from '#lib/components/tooltip-button.svelte';
	import * as Alert from '#lib/components/ui/alert/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Label } from '#lib/components/ui/label/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import HtmlEditor from '#lib/components/mail/html-editor.svelte';
	import { fileSize } from '#lib/format.js';
	import type {
		AccountSummary,
		AttachmentInfo,
		ComposeMeeting,
		ComposeState,
		MeetingTimes
	} from '#lib/mail-types.js';
	import { followSend, takeUnsent } from '#lib/outbox.js';

	let { initial: props, accounts }: { initial: ComposeState; accounts: AccountSummary[] } =
		$props();

	// The editor owns its state after loading; the page re-creates it for each new compose URL.
	// `?unsent=` reopens a message whose background send failed.
	const unsent = takeUnsent(page.url.searchParams.get('unsent'));
	const initial = unsent?.state ?? untrack(() => props);
	let accountId = $state(initial.accountId);
	let draftRef = $state(initial.replacesDraftRef);
	let carriedRef = $state(initial.carriedRef);
	let carried = $state<AttachmentInfo[]>(initial.carried);
	let files = $state<File[]>(unsent?.files ?? []);
	let showCopies = $state(Boolean(initial.cc || initial.bcc));
	let dirty = $state(Boolean(unsent));
	// Sending and discarding close the editor, which stays until the page behind it has loaded.
	let pending = $state<'save' | 'close' | null>(null);
	let error = $state<string | null>(null);
	let confirmDiscard = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let form = $state<HTMLFormElement | null>(null);
	let discardButton = $state<HTMLButtonElement | null>(null);
	let editor = $state<HtmlEditor | null>(null);

	const account = $derived(accounts.find((a) => a.id === accountId));

	// A meeting invitation: To are required attendees, Cc optional ones. The form edits the date
	// and times in the browser's time zone and sends them as instants.
	const canMeet = initial.mode === 'new' || initial.mode === 'draft';
	const pad = (n: number) => String(n).padStart(2, '0');
	const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	/** An instant from local date and time inputs; null while they are incomplete. */
	function instant(date: string, time: string): string | null {
		const value = new Date(`${date}T${time}`);
		return date && time && !Number.isNaN(value.getTime()) ? value.toISOString() : null;
	}
	function nextHour(): ComposeMeeting {
		const now = new Date();
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1);
		const end = new Date(start.getTime() + 30 * 60_000);
		return { start: start.toISOString(), end: end.toISOString(), location: '' };
	}
	const firstMeeting = initial.meeting ?? nextHour();
	let meeting = $state(initial.meeting !== null);
	let meetingDate = $state(localDate(new Date(firstMeeting.start)));
	let startTime = $state(localTime(new Date(firstMeeting.start)));
	let endTime = $state(localTime(new Date(firstMeeting.end)));
	const meetingStart = $derived(instant(meetingDate, startTime));
	const meetingEnd = $derived(instant(meetingDate, endTime));
	let times = $state<MeetingTimes | null>(null);
	let finding = $state(false);
	let findError = $state<string | null>(null);

	const heading = $derived(
		meeting
			? initial.mode === 'draft'
				? 'Meeting draft'
				: 'New meeting'
			: { new: 'New message', reply: 'Reply', forward: 'Forward', draft: 'Draft' }[initial.mode]
	);

	// Going back is safe only to a page this document showed. Going back past the page load
	// unloads the document, which cancels a send that is still uploading and drops its toast.
	let openedInApp = false;
	afterNavigate(({ from }) => (openedInApp = from !== null));

	function leave() {
		dirty = false;
		if (openedInApp) history.back();
		else
			goto(resolve('/(app)/mail/[scope]/[...folder]', { scope: 'all', folder: 'inbox' }), {
				replace: true
			});
	}

	/** Goes back to where the editor was opened from; unsaved changes ask first. */
	function close() {
		if (openedInApp) history.back();
		else {
			const folder = initial.mode === 'draft' ? 'drafts' : 'inbox';
			const scope = initial.mode === 'draft' ? accountId : 'all';
			goto(resolve('/(app)/mail/[scope]/[...folder]', { scope, folder }));
		}
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || event.defaultPrevented || confirmDiscard || pending) return;
		// Escape in a menu or dialog closes only that.
		if ((event.target as Element | null)?.closest?.('[role="dialog"], [role="menu"]')) return;
		event.preventDefault();
		close();
	}

	/** A new sender brings its own signature. */
	function changeSender() {
		editor?.setSignature(accounts.find((a) => a.id === accountId)?.signature ?? null);
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

	function failure(result: ActionResult): string {
		if (result.type === 'failure') return String(result.data?.error ?? 'Something went wrong.');
		if (result.type === 'error') return result.error?.message ?? 'Something went wrong.';
		return 'Something went wrong.';
	}

	const submit: SubmitFunction = ({ formData, action, cancel }) => {
		if (pending) {
			cancel();
			return;
		}
		const kind = action.search.includes('discard')
			? 'discard'
			: action.search.includes('save')
				? 'save'
				: 'send';
		const text = (name: string) => String(formData.get(name) ?? '');
		if (kind === 'send' && !text('to').trim()) {
			error = meeting ? 'Add at least one attendee.' : 'Add at least one recipient.';
			cancel();
			return;
		}
		if (meeting && kind !== 'discard') {
			const problem =
				!meetingStart || !meetingEnd
					? 'Choose a date and times for the meeting.'
					: kind === 'send' && meetingEnd <= meetingStart
						? 'The meeting must end after it starts.'
						: null;
			if (problem) {
				error = problem;
				cancel();
				return;
			}
		}
		formData.delete('files');
		if (!meeting) for (const file of files) formData.append('files', file);
		error = null;

		if (kind === 'save') {
			pending = 'save';
			return async ({ result }) => {
				pending = null;
				if (result.type !== 'success' || !result.data) {
					error = failure(result);
					return;
				}
				draftRef = String(result.data.draftRef);
				carriedRef = draftRef;
				carried = result.data.carried as AttachmentInfo[];
				files = [];
				dirty = false;
				toast.success('Draft saved');
			};
		}

		// Sending and discarding finish in the background; the editor closes right away.
		pending = 'close';
		leave();
		if (kind === 'discard') {
			toast.success('Draft discarded');
			return async ({ result }) => {
				if (result.type === 'success') invalidate('mail:list');
				else toast.error(`The draft was not discarded: ${failure(result)}`);
			};
		}
		const finish = followSend({
			state: {
				...initial,
				accountId,
				to: text('to'),
				cc: text('cc'),
				bcc: text('bcc'),
				subject: text('subject'),
				body: text('body'),
				replacesDraftRef: draftRef,
				carriedRef,
				carried: $state.snapshot(carried),
				meeting:
					meeting && meetingStart && meetingEnd
						? { start: meetingStart, end: meetingEnd, location: text('meetingLocation') }
						: null
			},
			files: [...files]
		});
		return async ({ result }) => finish(result.type === 'success' ? null : failure(result));
	};

	/** Busy and free times of the attendees on the meeting's day (Exchange accounts). */
	async function findTimes() {
		if (!form || !meetingStart || !meetingEnd || meetingEnd <= meetingStart) {
			findError = 'Choose a date and times for the meeting first.';
			return;
		}
		const fields = new FormData(form);
		const params = new URLSearchParams({
			account: accountId,
			date: meetingDate,
			duration: String((Date.parse(meetingEnd) - Date.parse(meetingStart)) / 60_000),
			tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
			to: String(fields.get('to') ?? ''),
			cc: String(fields.get('cc') ?? '')
		});
		finding = true;
		findError = null;
		try {
			const response = await fetch(`/api/availability?${params}`);
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				throw new Error(body?.message ?? 'Free times could not be loaded.');
			}
			times = await response.json();
		} catch (e) {
			times = null;
			findError = e instanceof Error ? e.message : 'Free times could not be loaded.';
		} finally {
			finding = false;
		}
	}

	const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
	const span = (range: { start: string; end: string }) =>
		clock.formatRange(new Date(range.start), new Date(range.end));

	/** A free time starts the meeting at its beginning and keeps the meeting's length. */
	function pick(range: { start: string }) {
		if (!meetingStart || !meetingEnd) return;
		const length = Date.parse(meetingEnd) - Date.parse(meetingStart);
		const start = new Date(range.start);
		startTime = localTime(start);
		endTime = localTime(new Date(start.getTime() + length));
		dirty = true;
	}
</script>

<svelte:head><title>{heading} · Mail</title></svelte:head>
<svelte:window {onkeydown} />

<div
	class="relative mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto px-4 py-6"
>
	<div class="mb-4 flex items-center gap-2">
		<TooltipButton variant="ghost" size="sm" tooltip="Back" shortcut="Esc" onclick={close}>
			<ArrowLeft />
			<span class="sr-only">Back</span>
		</TooltipButton>
		<h1 class="text-xl font-semibold">{heading}</h1>
		{#if canMeet && accounts.length}
			<span class="flex-1"></span>
			<Button
				variant="outline"
				size="sm"
				aria-pressed={meeting}
				class={meeting ? 'bg-selected text-selected-foreground hover:bg-selected' : ''}
				onclick={() => {
					meeting = !meeting;
					dirty = true;
				}}
			>
				<CalendarPlus />
				Meeting
			</Button>
		{/if}
	</div>

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
					<NativeSelect
						id="from"
						name="accountId"
						bind:value={accountId}
						onchange={changeSender}
						class="min-w-0 flex-1"
					>
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
					<Label for="to">{meeting ? 'Required' : 'To'}</Label>
					{#if !showCopies && !meeting}
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
			{#if meeting}
				<div class="grid gap-1.5">
					<Label for="cc">Optional</Label>
					<Input id="cc" name="cc" value={initial.cc} autocomplete="email" />
				</div>
			{:else if showCopies}
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
				<Label for="subject">{meeting ? 'Title' : 'Subject'}</Label>
				<Input id="subject" name="subject" value={initial.subject} />
			</div>

			{#if meeting}
				<input type="hidden" name="meetingStart" value={meetingStart ?? ''} />
				<input type="hidden" name="meetingEnd" value={meetingEnd ?? ''} />
				<div class="grid gap-4 sm:grid-cols-3">
					<div class="grid gap-1.5">
						<Label for="meeting-date">Date</Label>
						<Input
							id="meeting-date"
							type="date"
							bind:value={meetingDate}
							onchange={() => (times = null)}
						/>
					</div>
					<div class="grid gap-1.5">
						<Label for="meeting-start">Start</Label>
						<Input id="meeting-start" type="time" step="300" bind:value={startTime} />
					</div>
					<div class="grid gap-1.5">
						<Label for="meeting-end">End</Label>
						<Input id="meeting-end" type="time" step="300" bind:value={endTime} />
					</div>
				</div>
				<div class="grid gap-1.5">
					<Label for="meeting-location">Location</Label>
					<Input
						id="meeting-location"
						name="meetingLocation"
						value={initial.meeting?.location ?? ''}
					/>
				</div>
				{#if account?.provider === 'exchange'}
					<div class="flex flex-col gap-3">
						<div>
							<Button variant="outline" size="sm" disabled={finding} onclick={findTimes}>
								{#if finding}<Spinner aria-label="Loading" />{/if}
								Find a time
							</Button>
						</div>
						{#if findError}
							<p class="text-sm text-destructive">{findError}</p>
						{/if}
						{#if times}
							<div class="flex flex-col gap-2 text-sm">
								<ul class="flex flex-col gap-1">
									{#each times.attendees as attendee (attendee.address)}
										<li class="wrap-anywhere">
											<span class="font-medium">
												{attendee.address.toLowerCase() === account.email.toLowerCase()
													? 'You'
													: attendee.address}:
											</span>
											<span class="text-muted-foreground">
												{#if attendee.busy === null}
													no information
												{:else if !attendee.busy.length}
													free all day
												{:else}
													busy {attendee.busy
														.map((b) => span(b) + (b.tentative ? ' (tentative)' : ''))
														.join(', ')}
												{/if}
											</span>
										</li>
									{/each}
								</ul>
								{#if times.free.length}
									<p class="text-muted-foreground">Free for everyone (click to choose):</p>
									<div class="flex flex-wrap gap-2">
										{#each times.free as range (range.start)}
											{@const chosen =
												meetingStart !== null &&
												Date.parse(meetingStart) === Date.parse(range.start)}
											<Button
												variant="outline"
												size="sm"
												aria-pressed={chosen}
												class={chosen
													? 'bg-selected text-selected-foreground hover:bg-selected'
													: ''}
												onclick={() => pick(range)}
											>
												{span(range)}
											</Button>
										{/each}
									</div>
								{:else}
									<p class="text-muted-foreground">
										No time between 08:00 and 18:00 suits everyone on this day.
									</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			{/if}

			<div class="grid gap-1.5">
				<Label onclick={() => editor?.focus()}>Message</Label>
				<HtmlEditor
					bind:this={editor}
					name="body"
					value={initial.body}
					label="Message"
					font={account?.font ?? null}
					autofocus={initial.mode !== 'new'}
					onchange={() => (dirty = true)}
					onescape={() => !confirmDiscard && !pending && close()}
				/>
			</div>

			<div class={['flex flex-col gap-2', meeting && 'hidden']}>
				{#if carried.length || files.length}
					<ul class="flex flex-wrap gap-2" aria-label="Attachments">
						{#each carried as attachment (attachment.partId)}
							<li class="flex max-w-72 items-center gap-2 rounded-md border px-2 py-1 text-sm">
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
							<li class="flex max-w-72 items-center gap-2 rounded-md border px-2 py-1 text-sm">
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
					<Send />
					{meeting ? 'Send invitation' : 'Send'}
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
