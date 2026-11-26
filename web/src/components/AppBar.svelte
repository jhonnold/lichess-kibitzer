<script lang="ts">
  import type { NavLink } from '$shared/route';
  import type { StreamStatus } from '$shared/types';

  // here: what is on screen. live: the Current Round (LIVE pill while a Board is being played). archived: an
  // archived Round, shown as a breadcrumb back into the Archive (board: the Board on screen, if any).
  type Here =
    | { kind: 'live'; event: string | null; round: string | null; live: boolean }
    | { kind: 'archived'; event: string | null; round: string | null; roundHref: string; board: number | null };
  type Props = {
    links: NavLink[];
    here: Here;
    stream: StreamStatus | null;
    connected: boolean;
  };
  const { links, here, stream, connected }: Props = $props();
  const tabs = $derived(links.filter((l) => l.tab !== 'admin'));
  const admin = $derived(links.find((l) => l.tab === 'admin')!);
  const home = $derived(links.find((l) => l.tab === 'board')!.href);
</script>

{#snippet chevron()}
  <svg class="chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
  </svg>
{/snippet}

<header>
  <a class="logo" href={home}>
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
      <rect x="1" y="1" width="20" height="20" rx="5" fill="none" stroke="currentColor" stroke-width="1.6" />
      <rect x="5" y="5" width="6" height="6" fill="currentColor" />
      <rect x="11" y="11" width="6" height="6" fill="currentColor" />
    </svg>
    <span>Kibitzer</span>
  </a>

  {#if here.kind === 'archived'}
    <nav class="where" aria-label="Breadcrumb">
      <span class="badge">ARCHIVE</span>
      {#if here.event}<a class="event" href="#/archive">{here.event}</a>{@render chevron()}{/if}
      {#if here.board === null}
        <span class="round" aria-current="page">{here.round ?? ''}</span>
      {:else}
        <a class="round up" href={here.roundHref}>{here.round ?? 'Round'}</a>
        {@render chevron()}
        <span class="round" aria-current="page">Board {here.board}</span>
      {/if}
    </nav>
  {:else if here.event}
    <div class="where">
      <span class="event">{here.event}</span>
      {#if here.round}{@render chevron()}<span class="round">{here.round}</span>{/if}
      {#if here.live}<span class="live"><span></span>LIVE</span>{/if}
    </div>
  {/if}

  <nav class="tabs" aria-label="Main">
    {#each tabs as l (l.tab)}
      <a href={l.href} aria-current={l.current ? 'page' : undefined}>
        {l.label}{#if l.key}<kbd>{l.key}</kbd>{/if}
      </a>
    {/each}
  </nav>

  <span class="fill"></span>

  <div class="dots">
    <span
      title={stream === null
        ? 'No Lichess stream'
        : stream === 'connected'
          ? 'Lichess stream connected'
          : 'Lichess stream reconnecting'}
    >
      <i class:bad={stream === 'reconnecting'} class:off={stream === null}></i><span class="label">Lichess</span>
    </span>
    <span title={connected ? 'Server connected' : 'Reconnecting to server'}>
      <i class:bad={!connected}></i><span class="label">Server</span>
    </span>
  </div>

  <a class="admin" href={admin.href} aria-label="Admin" aria-current={admin.current ? 'page' : undefined}>
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"
      />
    </svg>
  </a>
</header>

<style>
  header {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px 16px;
    min-height: var(--barH);
    padding: 0 12px 0 16px;
    border-bottom: 1px solid var(--line);
    background: var(--surface2);
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  .logo {
    display: flex;
    flex: none;
    align-items: center;
    gap: 8px;
    min-height: var(--barH);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .logo svg {
    color: var(--accent);
  }
  .where {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 24px;
    padding-left: 16px;
    border-left: 1px solid var(--line);
    white-space: nowrap;
  }
  .event {
    min-width: 0;
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
  }
  a.event:hover,
  a.round:hover {
    color: var(--text);
  }
  .round {
    font-weight: 600;
  }
  .round.up {
    color: var(--muted);
  }
  .chev {
    flex: none;
    color: var(--muted);
  }
  .badge,
  .live {
    flex: none;
    padding: 2px 7px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
  }
  .badge {
    border-radius: 4px;
    background: var(--surface3);
    color: var(--text2);
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border-radius: 999px;
    background: var(--liveBg);
    color: var(--liveText);
  }
  .live span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--live);
  }
  .tabs {
    display: flex;
    align-self: stretch;
    gap: 2px;
  }
  .tabs a {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    color: var(--muted);
    font-weight: 600;
  }
  .tabs a:hover {
    color: var(--text);
  }
  .tabs a[aria-current='page'],
  .admin[aria-current='page'] {
    color: var(--text);
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .fill {
    flex: 1 1 0;
  }
  .dots {
    display: flex;
    flex: none;
    align-items: center;
    gap: 14px;
    font-size: 13px;
    color: var(--muted);
  }
  .dots > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--ok);
  }
  i.bad {
    background: var(--warn);
  }
  i.off {
    background: var(--muted);
  }
  .admin {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    align-self: stretch;
    width: 44px;
    color: var(--muted);
  }
  .admin:hover {
    color: var(--text);
  }
  /* Tablet: no Event name. Phone: the tab bar at the bottom takes over the sections. */
  @media (max-width: 1099px) {
    .event,
    .event + .chev {
      display: none;
    }
  }
  @media (max-width: 699px) {
    header {
      gap: 4px 12px;
      padding: 0 12px;
    }
    .logo span,
    .tabs,
    .admin,
    .dots .label {
      display: none;
    }
    .where {
      padding-left: 12px;
    }
    .dots {
      gap: 8px;
    }
  }
</style>
