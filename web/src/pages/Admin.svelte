<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { changedOptions, initialValues, type UciOption } from '$shared/engine-form';
  import { COPY_OPTIONS, DEFAULT_COPY, DEFAULT_MULTI_PV, MAX_MULTI_PV } from '$shared/engine-config';
  import type { EngineConfig } from '$shared/types';
  import { adminApi, ApiError, getStatus, type AdminStatus, type Probe } from '$lib/admin-api';
  import StatusPanel from '../components/StatusPanel.svelte';
  import type { LiveStore } from '$lib/live.svelte';
  import type { DeadJob } from '$shared/queue';
  import { formatPasses, mergeForms, passesMs } from '$shared/admin-form';
  import { defaultTopN } from '$shared/events';
  import { estimatedLoad } from '$shared/timing';
  import AdminEvent from '../components/AdminEvent.svelte';

  type Section = 'login' | 'events' | 'passes' | 'engine' | 'status';

  const { store }: { store: LiveStore } = $props(); // site state + Lichess stream status, same feed as the Viewer
  let authed = $state<boolean | null>(null); // null: checking the cookie
  let busy = $state(false);
  const errors = $state<Partial<Record<Section, string>>>({});
  let password = $state('');
  let link = $state('');
  let now = $state(Date.now()); // for the countdowns; ticks once a second
  let path = $state('');
  let config: Record<string, string> = {};
  let engineName = $state('');
  let options = $state<UciOption[]>([]); // the shared ones: not Threads/Hash/MultiPV
  let limits = $state<Record<string, UciOption | undefined>>({}); // the engine's Threads/Hash/MultiPV spins
  let copies = $state<Pick<EngineConfig, 'main' | 'multi'>>({
    main: { ...DEFAULT_COPY },
    multi: { ...DEFAULT_COPY, multiPv: DEFAULT_MULTI_PV },
  });
  let values = $state<Record<string, string>>({});
  let saved = $state(false);
  let status = $state<AdminStatus | null>(null);
  // Per-Event form state, keyed by tourId; only refresh() rewrites it, so a poll never resets typed input.
  let topN = $state<Record<string, string>>({});
  let checked = $state<Record<string, string[]>>({}); // ids of the boards ticked in each Event's Tracked set
  let rounds: Record<string, string> = {}; // Current Round each Event's forms were filled from
  let gen = 0; // bumped by refresh(): a poll that started before it is stale and dropped
  let addTopN = $state(''); // the add-Event form: empty = the server's default
  // A cleared number input binds null; the fields start from the saved Passes, so changing one keeps the others.
  const passSeconds = $state<(string | number | null)[]>(['', '', '']);
  const passFields = (p: AdminStatus['passesMs']) =>
    (p ?? [null, null, null]).map((ms) => (ms === null ? '' : String(ms / 1000)));

  /** One action at a time; failures show inline in their section. A 401 means the cookie is gone: back to login. */
  async function run(section: Section, action: () => Promise<void>): Promise<void> {
    busy = true;
    errors[section] = '';
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        authed = false;
        errors.login = section === 'login' ? 'Wrong password' : 'Logged out (server restarted?). Log in again.';
      } else errors[section] = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /** GET /status into `status`. Forms follow the server only for the Event acted on (`acted`), one whose Round
   *  changed, and new Events; the others keep what was typed. */
  async function refresh(acted?: string): Promise<AdminStatus> {
    gen++;
    const s = await getStatus();
    gen++;
    status = s;
    ({ topN, checked, rounds } = mergeForms({ topN, checked, rounds }, s.events, acted));
    return s;
  }
  /** The 2 s poll: not refresh() (forms keep their input) and not run() (busy). A poll overtaken by a refresh()
   *  is dropped, or it would bring back a removed Event. */
  async function poll(): Promise<void> {
    if (!authed || document.hidden) return;
    now = Date.now();
    const g = gen;
    try {
      const s = await getStatus();
      if (g !== gen) return;
      status = s;
      ({ topN, checked, rounds } = mergeForms({ topN, checked, rounds }, s.events)); // seeds new Events
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) authed = false; // the login form shows
    }
  }
  const onDead = (action: 'requeue' | 'discard', d: DeadJob) =>
    run('status', async () => {
      await adminApi('POST', `/dead/${action}`, { boardId: d.boardId, ply: d.ply });
      await poll();
    });
  async function loadStatus(): Promise<void> {
    const s = await refresh();
    authed = true;
    ({ path, options: config } = s.engine);
    passFields(s.passesMs).forEach((v, k) => (passSeconds[k] = v));
    copies = { main: { ...s.engine.main }, multi: { ...s.engine.multi } };
    await run('engine', probe); // form prefilled with the current (or default) config
  }
  const login = () =>
    run('login', async () => {
      await adminApi('POST', '/login', { password });
      password = '';
      await loadStatus();
    });

  const register = () =>
    run('events', async () => {
      await adminApi('POST', '/event', {
        link,
        ...(addTopN !== '' && Number.isInteger(Number(addTopN)) && Number(addTopN) > 0 && { topN: Number(addTopN) }),
      });
      addTopN = '';
      await refresh();
    });

  async function probe(): Promise<void> {
    const p = await adminApi<Probe>('POST', '/engine/probe', { path });
    const shared = p.options.filter((o) => !COPY_OPTIONS.includes(o.name));
    limits = Object.fromEntries(COPY_OPTIONS.map((n) => [n, p.options.find((o) => o.name === n)]));
    [engineName, options, values, saved] = [p.name, shared, initialValues(shared, config), false];
  }
  const save = () =>
    run('engine', async () => {
      const cfg: EngineConfig = { path, options: changedOptions(options, values), ...$state.snapshot(copies) };
      await adminApi('PUT', '/config', cfg);
      [config, saved] = [cfg.options, true];
    });
  const press = (name: string) => run('engine', () => adminApi('POST', '/engine/button', { name }));
  /** One control: send it, then re-read the status. */
  const control = (section: Section, method: string, path: string, body?: unknown, acted?: string) =>
    run(section, async () => {
      await adminApi(method, path, body);
      await refresh(acted);
    });
  const remove = (t: string) => control('events', 'DELETE', `/event/${t}`);
  const makePrimary = (t: string) => control('events', 'PUT', '/primary', { tourId: t });
  const saveTopN = (t: string) => control('events', 'PUT', `/event/${t}/topn`, { n: Number(topN[t]) }, t);
  const saveTracked = (t: string) =>
    control('events', 'PUT', `/event/${t}/tracked`, { boardIds: $state.snapshot(checked[t]) }, t);
  const setPasses = () => {
    const ms = passesMs(passSeconds.map((v) => (v == null ? '' : String(v))) as [string, string, string]);
    if (typeof ms === 'string') errors.passes = ms;
    else control('passes', 'PUT', '/passes', { ms });
  };

  onMount(() => {
    // A valid cookie skips the login form; a 401 here is just "not logged in yet".
    loadStatus().catch((e) => {
      authed = false;
      if (!(e instanceof ApiError && e.status === 401)) errors.login = e instanceof Error ? e.message : String(e);
    });
    const tick = setInterval(() => (now = Date.now()), 1000);
    const pollTimer = setInterval(() => void poll(), 2000);
    return () => (clearInterval(tick), clearInterval(pollTimer));
  });

  const snap = $derived(store.snap);
  // Everything Event-specific comes from `status`, whichever Event the stream is on (the snapshot only adds the
  // live search depth, when it matches the running Job).
  const running = $derived(!!status?.events.some((e) => e.round)); // an engine runs while some Event has a Round
  const evs = $derived(status?.events ?? []);
  const load = $derived(status ? estimatedLoad(status.tracked, status.passesMs?.[0] ?? null) : null);
  const streams = $derived(evs.filter((e) => e.stream === 'connected').length);

  // Any Event's swap, add, remove or Primary change: re-read the status without a reload.
  // A derived string, not the ids read in the effect: every Snapshot is a new object and would re-run it (and
  // refresh() resets the forms).
  const eventsKey = $derived(
    (snap?.events ?? []).map((e) => `${e.tourId}/${e.round?.roundId ?? ''}/${e.primary}`).join(),
  );
  $effect(() => {
    void eventsKey;
    if (authed) untrack(() => run('status', async () => void (await refresh())));
  });
  // Side menu (chips on a phone): scrolls to a section; the hash stays #/admin.
  const SECTIONS = [
    ['status', 'Status'],
    ['events', 'Events'],
    ['passes', 'Search passes'],
    ['engine', 'Engine'],
  ] as const;
  let section = $state<string>('status');
  function goTo(id: string) {
    section = id;
    document.getElementById(`admin-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
</script>

<main class="admin">
  {#if authed === false}
    <form class="login" onsubmit={(e) => (e.preventDefault(), login())}>
      <span class="lock" aria-hidden="true">
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
      </span>
      <h1>Admin</h1>
      <p class="muted">Log in to manage the Events, tracking and engine.</p>
      <label class="field">
        <span>Password</span>
        <input type="password" bind:value={password} autocomplete="current-password" required />
      </label>
      {#if errors.login}<p class="error" role="alert">{errors.login}</p>{/if}
      <button class="primary" disabled={busy}>Log in</button>
      <a href="#/">Back to the live board</a>
    </form>
  {:else if authed}
    <div class="layout">
      <nav aria-label="Admin sections">
        <p>Admin</p>
        {#each SECTIONS as [id, label] (id)}
          <button type="button" aria-current={section === id ? 'true' : undefined} onclick={() => goTo(id)}>
            {label}
          </button>
        {/each}
      </nav>

      <div class="sections">
        <section id="admin-status">
          <div class="head">
            <h1>Status</h1>
            <span class="fill"></span>
          </div>
          <div class="grid">
            <article>
              <h2>Events</h2>
              <p class="big">
                {evs.length}
                {evs.length === 1 ? 'Event' : 'Events'} · {status?.tracked ?? 0} Tracked
                {status?.tracked === 1 ? 'board' : 'boards'}
              </p>
              <p class={{ warn: load !== null && load >= 0.9 }}>
                Estimated load <b>{load === null ? '–' : `≈ ${Math.round(load * 100)}%`}</b>
              </p>
              <p class="muted small">estimate: one move per Board every ~3 min</p>
            </article>
            <article>
              <h2>Connections</h2>
              <p class="dotrow">
                <i class={streams === evs.length && evs.length ? 'ok' : streams ? 'warn' : ''}></i>Lichess
                <b>{streams} of {evs.length} {evs.length === 1 ? 'stream' : 'streams'} connected</b>
              </p>
              <p class="dotrow">
                <i class={store.connected ? 'ok' : 'warn'}></i>Server
                <b>{store.connected ? 'connected' : 'reconnecting…'}</b>
              </p>
            </article>
            {#if status}<StatusPanel {status} {snap} {now} {busy} {onDead} />{/if}
          </div>
          {#if errors.status}<p class="error">{errors.status}</p>{/if}
        </section>

        <section id="admin-events" class="card">
          <h2 class="title">Events</h2>
          <div class="evlist">
            {#each evs as ev (ev.event.tourId)}
              {@const t = ev.event.tourId}
              {#if t in topN && t in checked}
                <AdminEvent
                  {ev}
                  {busy}
                  {now}
                  bind:topN={topN[t]}
                  bind:checked={checked[t]}
                  onTopN={() => saveTopN(t)}
                  onTracked={() => saveTracked(t)}
                  onPrimary={() => makePrimary(t)}
                  onRemove={() => remove(t)}
                />
              {/if}
            {:else}
              <p class="muted">No Events yet. Add one below.</p>
            {/each}
          </div>
          <form class="inline" onsubmit={(e) => (e.preventDefault(), register())}>
            <label class="field grow">
              <span>Event link</span>
              <input bind:value={link} placeholder="https://lichess.org/broadcast/…" required />
            </label>
            <label class="field">
              <span>Top N</span>
              <input
                type="number"
                min="1"
                max="64"
                step="1"
                placeholder={String(defaultTopN(evs.length + 1))}
                bind:value={addTopN}
              />
            </label>
            <button class="primary" disabled={busy}>Add Event</button>
          </form>
          {#if errors.events}<p class="error">{errors.events}</p>{/if}
        </section>

        {#if status}
          <section id="admin-passes" class="card">
            <h2 class="title">Search passes</h2>
            <p class="muted">
              Now <b>{formatPasses(status.passesMs)}</b>. Pass 1 runs right away, Pass 2 in free time. Pass 3 is deep
              analysis: only for a Board an Admin asks for, and only while no Event is live. Leave Pass 2 or 3 blank to
              skip it.
            </p>
            <form class="inline" onsubmit={(e) => (e.preventDefault(), setPasses())}>
              {#each ['Pass 1', 'Pass 2', 'Pass 3 (deep, on demand)'] as label, k (label)}
                <label class="field">
                  <span>{label}</span>
                  <input type="number" min="0.1" step="0.1" placeholder="Seconds" bind:value={passSeconds[k]} />
                </label>
              {/each}
              <button disabled={busy}>Set</button>
              <button type="button" disabled={busy} onclick={() => control('passes', 'PUT', '/passes', { ms: null })}>
                Unset
              </button>
            </form>
            {#if errors.passes}<p class="error">{errors.passes}</p>{/if}
          </section>
        {/if}

        <section id="admin-engine" class="card">
          <h2 class="title">Engine</h2>
          <form class="inline" onsubmit={(e) => (e.preventDefault(), run('engine', probe))}>
            <label class="field grow">
              <span>Engine path</span>
              <input class="mono" bind:value={path} oninput={() => (options = [])} required />
            </label>
            <button disabled={busy}>Probe</button>
          </form>
          {#if options.length}
            <form onsubmit={(e) => (e.preventDefault(), save())}>
              <p class="label">{engineName}</p>
              <div class="options">
                <p class="label span">Main line: MultiPV 1, sets the eval, accuracy and marks</p>
                <label class="field">
                  <span>Threads</span>
                  <input type="number" min="1" max={limits.Threads?.max} required bind:value={copies.main.threads} />
                </label>
                <label class="field">
                  <span>Hash (MB)</span>
                  <input type="number" min="1" max={limits.Hash?.max} required bind:value={copies.main.hash} />
                </label>
                <p class="label span">Lines: a second copy of the engine, for the other moves</p>
                <label class="field">
                  <span>Threads</span>
                  <input type="number" min="1" max={limits.Threads?.max} required bind:value={copies.multi.threads} />
                </label>
                <label class="field">
                  <span>Hash (MB)</span>
                  <input type="number" min="1" max={limits.Hash?.max} required bind:value={copies.multi.hash} />
                </label>
                <label class="field">
                  <span>MultiPV</span>
                  <input
                    type="number"
                    min="2"
                    max={Math.min(MAX_MULTI_PV, limits.MultiPV?.max ?? MAX_MULTI_PV)}
                    required
                    bind:value={copies.multi.multiPv}
                  />
                </label>
                <p class="label span">Options of both copies</p>
                {#each options as o (o.name)}
                  {#if o.type === 'button'}
                    <div class="field">
                      <span>{o.name}</span>
                      <button type="button" disabled={busy || !running} onclick={() => press(o.name)}>{o.name}</button>
                      <small class="muted">sent to the running engine, between searches</small>
                    </div>
                  {:else if o.type === 'check'}
                    <label class="check">
                      <input
                        type="checkbox"
                        checked={values[o.name] === 'true'}
                        onchange={(e) => (values[o.name] = String(e.currentTarget.checked))}
                      />
                      {o.name}
                    </label>
                  {:else}
                    <label class="field">
                      <span>{o.name}</span>
                      {#if o.type === 'spin'}
                        <input
                          type="number"
                          min={o.min}
                          max={o.max}
                          required
                          value={values[o.name]}
                          oninput={(e) => (values[o.name] = e.currentTarget.value)}
                        />
                      {:else if o.type === 'combo'}
                        <select bind:value={values[o.name]}>
                          {#each o.vars ?? [] as v (v)}<option>{v}</option>{/each}
                        </select>
                      {:else}
                        <input bind:value={values[o.name]} />
                      {/if}
                    </label>
                  {/if}
                {/each}
              </div>
              <div class="actions">
                <button class="primary" disabled={busy}>Save</button>
                {#if saved}<span class="saved">Saved. A running engine restarts.</span>{/if}
              </div>
            </form>
          {/if}
          {#if errors.engine}<p class="error">{errors.engine}</p>{/if}
        </section>
      </div>
    </div>
  {/if}
</main>

<style>
  /* The app shell is one screen high, so this page scrolls itself. */
  .admin {
    height: 100%;
    overflow-y: auto;
  }
  p {
    margin: 0;
  }
  a {
    color: var(--accent);
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 13px;
  }
  .error {
    color: var(--blunder);
  }
  h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  /* Controls */
  input,
  select {
    min-height: 40px;
    padding: 0 12px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  input[type='checkbox'] {
    width: 18px;
    min-height: 18px;
    margin: 0;
    accent-color: var(--accent);
  }
  input:focus {
    border-color: var(--accent);
    outline: none;
  }
  .mono {
    font-family: var(--fontMono);
    font-size: 13px;
  }
  button {
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: var(--radiusS);
    background: var(--surface);
    color: var(--text);
    font: 600 14px var(--fontUi);
    white-space: nowrap;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--muted);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--onLight);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .field > span,
  .label {
    color: var(--text2);
    font-size: 13px;
    font-weight: 600;
  }
  .grow {
    flex: 1 1 260px;
  }
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 12px;
  }
  .saved {
    color: var(--ok);
  }

  /* Login */
  .login {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: min(400px, calc(100% - 32px));
    margin: 12vh auto 32px;
    padding: 28px 24px;
    border: 1px solid var(--surface3);
    border-radius: 12px;
    background: var(--surface2);
  }
  .lock {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: var(--accentBg);
    color: var(--accent);
  }
  .login a {
    align-self: center;
    font-size: 13px;
  }

  /* Layout: side menu + sections; on a phone the menu is a row of chips that stays at the top. */
  .layout {
    display: flex;
    align-items: flex-start;
    gap: 24px 32px;
    max-width: 1280px;
    margin: 0 auto;
    padding: 24px 16px 48px;
  }
  nav {
    position: sticky;
    top: 0;
    display: flex;
    flex: 0 0 200px;
    flex-direction: column;
    gap: 2px;
  }
  nav p {
    margin: 0 0 8px 12px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  nav button {
    justify-content: flex-start;
    border: 0;
    background: none;
    color: var(--text2);
    font-weight: 500;
    text-align: left;
  }
  nav button:hover {
    background: var(--surface2);
  }
  nav button[aria-current] {
    background: var(--surface);
    color: var(--text);
    font-weight: 600;
  }
  .sections {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    gap: 32px;
    min-width: 0;
  }
  section {
    scroll-margin-top: 16px;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 16px;
  }
  .fill {
    flex: 1 1 0;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .grid :global(article),
  .card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 16px;
    border: 1px solid var(--surface3);
    border-radius: 10px;
    background: var(--surface2);
  }
  .grid :global(article.wide) {
    grid-column: span 2;
  }
  .grid :global(h2) {
    margin: 0 0 4px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .grid :global(b) {
    color: var(--text);
  }
  .grid p {
    color: var(--text2);
  }
  .grid .big {
    color: var(--text);
    font-size: 16px;
    font-weight: 600;
  }
  .dotrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dotrow b {
    margin-left: auto;
  }
  i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  i.ok {
    background: var(--ok);
  }
  i.warn {
    background: var(--warn);
  }
  .card {
    gap: 16px;
    padding: 20px;
  }
  .title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
  }
  .evlist {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(380px, 100%), 1fr));
    gap: 12px;
  }
  .warn b {
    color: var(--warn);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    min-width: 0;
    cursor: pointer;
  }
  .options {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px 16px;
    margin-top: 8px;
  }
  .options .span {
    grid-column: 1 / -1;
    margin: 8px 0 0;
  }
  .options .field button {
    align-self: flex-start;
  }

  @media (max-width: 1099px) {
    .grid :global(article.wide) {
      grid-column: auto;
    }
  }
  @media (max-width: 699px) {
    .layout {
      flex-direction: column;
      align-items: stretch;
      gap: 16px;
      padding: 0 12px 32px;
    }
    nav {
      z-index: 1;
      flex: none;
      flex-direction: row;
      gap: 6px;
      margin: 0 -12px;
      padding: 10px 12px;
      overflow-x: auto;
      background: var(--bg);
      border-bottom: 1px solid var(--surface3);
      scrollbar-width: none;
    }
    nav p {
      display: none;
    }
    nav button {
      flex: none;
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 999px;
    }
    nav button[aria-current] {
      border-color: var(--accent);
      background: var(--accentBg);
    }
    section {
      scroll-margin-top: 64px;
    }
    h1 {
      font-size: 22px;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .card {
      padding: 16px;
    }
    .inline > button {
      flex: 1 1 auto;
      min-height: 44px;
    }
    input,
    select {
      min-height: 44px;
    }
  }
</style>
