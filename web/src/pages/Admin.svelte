<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { changedOptions, initialValues, type UciOption } from '$shared/engine-form';
  import { COPY_OPTIONS, DEFAULT_COPY, DEFAULT_MULTI_PV, MAX_MULTI_PV } from '$shared/engine-config';
  import type { EngineConfig } from '$shared/types';
  import { adminApi, ApiError, getStatus, type AdminStatus, type Probe } from '$lib/admin-api';
  import StatusPanel from '../components/StatusPanel.svelte';
  import type { LiveStore } from '$lib/live.svelte';
  import type { DeadJob } from '$shared/queue';
  import { formatJobTime, jobTimeMs } from '$shared/admin-form';
  import { countdown, formatResult } from '$shared/viewer';

  type Section = 'login' | 'event' | 'engine' | 'status' | 'tracking';

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
  let topN = $state(''); // the Primary's next-Round default (Tracking form)
  let addTopN = $state(''); // the add-Event form: empty = the server's default
  let jobSeconds = $state('');
  let checked = $state<string[]>([]); // ids of the boards ticked in the Tracked set

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

  /** GET /status into `status`; the Tracking form follows the server's values. */
  async function refresh(): Promise<AdminStatus> {
    const s = (status = await getStatus());
    if (s.event) topN = String(s.topN); // Idle: keep the admin's value for the next add
    checked = s.round?.boards.filter((b) => b.tracked).map((b) => b.id) ?? [];
    return s;
  }
  /** The Status section's own 2 s poll: not refresh() (that would reset the Tracking form) and not run() (busy). */
  async function poll(): Promise<void> {
    if (!authed || document.hidden) return;
    now = Date.now();
    try {
      status = await getStatus();
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
    run('event', async () => {
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
  const clear = () =>
    run('status', async () => {
      if (status?.event) await adminApi('DELETE', `/event/${status.event.tourId}`);
      await refresh();
    });
  /** One Tracking control: send it, then re-read the status. */
  const control = (path: string, body: unknown) =>
    run('tracking', async () => {
      await adminApi('PUT', path, body);
      await refresh();
    });
  const setJobTime = () => {
    const ms = jobTimeMs(String(jobSeconds));
    if (ms === null) errors.tracking = 'Enter seconds > 0';
    else control('/jobtime', { ms });
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
  const running = $derived(!!snap?.round); // an engine runs while there is a Current Round

  // A swap (or a new Event) changes the Current Round: re-read the follow status without a reload.
  // A derived string, not the ids read in the effect: every Snapshot is a new object and would re-run it (and
  // refresh() resets the Tracking form).
  const roundKey = $derived(`${snap?.event?.tourId}/${snap?.round?.roundId}`);
  $effect(() => {
    void roundKey;
    if (authed) untrack(() => run('status', async () => void (await refresh())));
  });
  // Side menu (chips on a phone): scrolls to a section; the hash stays #/admin.
  const SECTIONS = [
    ['status', 'Status'],
    ['event', 'Event'],
    ['tracking', 'Tracking & job time'],
    ['engine', 'Engine'],
  ] as const;
  let section = $state<string>('status');
  function goTo(id: string) {
    section = id;
    document.getElementById(`admin-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const ago = (ms: number) =>
    `${new Date(ms).toLocaleTimeString()} · ${Math.max(0, Math.round((now - ms) / 1000))} s ago`;
  const when = (ms: number) => {
    const left = countdown(ms, now);
    return `${new Date(ms).toLocaleString()}${left === 'starting' ? '' : ` · in ${left}`}`;
  };
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
      <p class="muted">Log in to manage the Event, tracking and engine.</p>
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
            {#if status?.follow.polledAt != null}<span class="muted small">
                Last Event poll {ago(status.follow.polledAt)}
              </span>{/if}
          </div>
          <div class="grid">
            <article>
              <h2>Event</h2>
              {#if snap?.event}<a class="big" href={snap.event.link}>{snap.event.name}</a>{:else}<p class="big">
                  –
                </p>{/if}
              <p>
                Current Round <b>{snap?.round?.name ?? '–'}</b>
                {#if snap?.round}· {snap.round.boards.length} Tracked {snap.round.boards.length === 1
                    ? 'board'
                    : 'boards'}{/if}
              </p>
            </article>
            {#if status && snap?.event}
              {@const { next, swapAt, error } = status.follow}
              <article>
                <h2>Next Round</h2>
                {#if next}
                  <p class="big">{next.name}</p>
                  <p>Starts {next.startsAt === null ? 'when Lichess reports it' : when(next.startsAt)}</p>
                  <p>Swap <b>{swapAt === null ? 'when Lichess reports it live' : when(swapAt)}</b></p>
                {:else}
                  <p class="big">– (last Round)</p>
                {/if}
                {#if error}<p class="error">{error}</p>{/if}
              </article>
            {/if}
            <article>
              <h2>Connections</h2>
              <p class="dotrow">
                <i class={snap?.stream === 'connected' ? 'ok' : snap?.stream === 'reconnecting' ? 'warn' : ''}
                ></i>Lichess stream
                <b>{snap?.stream ?? '–'}</b>
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

        <section id="admin-event" class="card">
          <h2 class="title">Event</h2>
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
                placeholder={String(status?.nextTopN ?? '')}
                bind:value={addTopN}
              />
            </label>
            <button class="primary" disabled={busy}>Register Event</button>
          </form>
          {#if errors.event}<p class="error">{errors.event}</p>{/if}
          <div class="danger">
            <div>
              <b>Clear Event</b>
              <p class="muted small">Stops polling the Event and stops the engine.</p>
            </div>
            <button class="dangerBtn" disabled={busy || !snap?.event} onclick={clear}>Clear Event</button>
          </div>
        </section>

        {#if status}
          <section id="admin-tracking" class="card">
            <h2 class="title">Tracking &amp; job time</h2>
            <div class="pair">
              <form
                class="inline"
                onsubmit={(e) => (
                  e.preventDefault(),
                  status?.event && control(`/event/${status.event.tourId}/topn`, { n: Number(topN) })
                )}
              >
                <label class="field">
                  <span>Tracked boards in the next Round (top N)</span>
                  <input type="number" min="1" max="64" step="1" required bind:value={topN} />
                </label>
                <button disabled={busy}>Save</button>
              </form>
              <form class="inline" onsubmit={(e) => (e.preventDefault(), setJobTime())}>
                <label class="field">
                  <span>Job time · now <b>{formatJobTime(status.jobTimeMs)}</b></span>
                  <input type="number" min="0.1" step="0.1" placeholder="Seconds" bind:value={jobSeconds} />
                </label>
                <button disabled={busy}>Set</button>
                <button type="button" disabled={busy} onclick={() => control('/jobtime', { ms: null })}>Unset</button>
              </form>
            </div>
            {#if status.round}
              <form
                onsubmit={(e) => (
                  e.preventDefault(),
                  status?.event && control(`/event/${status.event.tourId}/tracked`, { boardIds: checked })
                )}
              >
                <p class="label">Tracked boards in this Round</p>
                <div class="boards">
                  {#each status.round.boards as b (b.id)}
                    <label class="check">
                      <input type="checkbox" value={b.id} bind:group={checked} />
                      <span class="n">{b.board}</span>
                      <span class="names">{b.white.name} – {b.black.name}</span>
                      <span class="muted">{formatResult(b.result)}</span>
                    </label>
                  {/each}
                </div>
                <div class="actions">
                  <button disabled={busy}>Save tracked boards</button>
                  <small class="muted">Applies to this Round only</small>
                </div>
              </form>
            {:else}
              <p class="muted">No Current Round</p>
            {/if}
            {#if errors.tracking}<p class="error">{errors.tracking}</p>{/if}
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
  .dangerBtn {
    border-color: var(--blunder);
    background: none;
    color: var(--liveText);
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
  .danger {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding-top: 16px;
    border-top: 1px solid var(--surface3);
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: 16px 32px;
  }
  .boards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 4px 16px;
    margin-top: 8px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    min-width: 0;
    cursor: pointer;
  }
  .check .n {
    font: 600 12px var(--fontMono);
    color: var(--accent);
  }
  .check .names {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
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
