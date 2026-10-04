<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { toggleMode } from 'mode-watcher';
	import CircleUser from '@lucide/svelte/icons/circle-user';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Mail from '@lucide/svelte/icons/mail';
	import PenSquare from '@lucide/svelte/icons/pen-square';
	import SunMoon from '@lucide/svelte/icons/sun-moon';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { authClient } from '#lib/auth-client.js';

	let { user }: { user: { name: string; email: string } } = $props();

	const links = [
		{
			href: resolve('/(app)/mail/[scope]/[...folder]', { scope: 'all', folder: 'inbox' }),
			match: '/mail',
			label: 'Mail'
		},
		{ href: resolve('/(app)/settings/accounts'), match: '/settings', label: 'Settings' }
	];

	async function signOut() {
		// Ends the local session, then Pocket ID's session (RP-initiated logout) when available.
		const { data } = await authClient.signOut({ callbackURL: '/login', disableRedirect: true });
		window.location.assign(data?.url ?? '/login');
	}
</script>

<header class="border-b">
	<div class="mx-auto flex h-14 max-w-[1600px] items-center gap-2 px-4 sm:gap-6">
		<a href={links[0].href} class="hidden items-center gap-2 font-semibold sm:flex">
			<span
				class="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
			>
				<Mail class="size-4" aria-hidden="true" />
			</span>
			Mail
		</a>
		<nav class="flex min-w-0 flex-1 items-center gap-1" aria-label="Main">
			{#each links as link (link.match)}
				{@const active = page.url.pathname.startsWith(link.match)}
				<a
					href={link.href}
					aria-current={active ? 'page' : undefined}
					class={[
						'rounded-md px-3 py-1.5 text-sm whitespace-nowrap',
						active
							? 'bg-accent font-medium text-accent-foreground'
							: 'text-muted-foreground hover:bg-muted hover:text-foreground'
					]}
				>
					{link.label}
				</a>
			{/each}
		</nav>
		<Button href={resolve('/(app)/compose')} size="sm">
			<PenSquare />
			<span class="hidden sm:inline">Compose</span>
			<span class="sr-only sm:hidden">Compose</span>
		</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" class="max-w-48 min-w-0" aria-label="Account menu">
						<CircleUser />
						<span class="hidden truncate md:inline">{user.name || user.email}</span>
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content
				align="end"
				class="w-max max-w-[calc(100vw-2rem)] min-w-(--bits-dropdown-menu-anchor-width)"
			>
				<DropdownMenu.Label class="truncate font-normal text-muted-foreground">
					{user.email}
				</DropdownMenu.Label>
				<DropdownMenu.Separator />
				<DropdownMenu.Item onSelect={toggleMode}>
					<SunMoon />
					Toggle theme
				</DropdownMenu.Item>
				<DropdownMenu.Item onSelect={signOut}>
					<LogOut />
					Sign out
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</header>
