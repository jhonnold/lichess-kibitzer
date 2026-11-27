<script lang="ts">
  import type { NavLink, Tab } from '$shared/route';

  // Phone navigation (<700px); the app bar's tabs and Admin link are hidden there.
  const { links }: { links: NavLink[] } = $props();
  const ICON: Record<Tab, string> = {
    events: 'M4 6h16M4 12h16M4 18h16',
    board: 'M4 4h16v16H4zM4 12h16M12 4v16',
    round: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
    admin:
      'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .3-1.5-1.5L17 5l-3-1-1 2h-2L10 4 7 5l.5 1.8L6 8.3 4 8l-1 3 2 1-2 1 1 3 2-.3 1.5 1.5L7 19l3 1 1-2h2l1 2 3-1-.5-1.8 1.5-1.5 2 .3 1-3z',
  };
</script>

<nav aria-label="Main">
  {#each links as l (l.tab)}
    <a href={l.href} aria-current={l.current ? 'page' : undefined}>
      <span class="pill">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d={ICON[l.tab]} />
        </svg>
      </span>
      {l.label}
    </a>
  {/each}
</nav>

<style>
  nav {
    display: none;
  }
  @media (max-width: 699px) {
    nav {
      display: grid;
      flex: none;
      grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
      grid-auto-flow: column;
      padding: 4px 4px max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--line);
      background: var(--surface2);
    }
  }
  a {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    min-height: 52px;
    border-radius: var(--radius);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    text-decoration: none;
  }
  .pill {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 52px;
    height: 28px;
    border-radius: 14px;
  }
  a[aria-current='page'] {
    color: var(--text);
  }
  a[aria-current='page'] .pill {
    background: var(--accentPill);
  }
</style>
