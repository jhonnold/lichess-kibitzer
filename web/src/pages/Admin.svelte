<script lang="ts">
  import { onMount } from 'svelte';
  import { changedOptions, initialValues, type UciOption } from '$shared/engine-form';
  import { adminApi, ApiError, type AdminStatus, type EventInfo, type Probe } from '$lib/admin-api';
  import { LiveStore } from '$lib/live.svelte';
  import { formatJobTime, jobTimeMs } from '$shared/admin-form';
  import { formatResult } from '$shared/viewer';

  type Section = 'login' | 'round' | 'engine' | 'status' | 'tracking';

  const store = new LiveStore(); // site state + Lichess stream status, same feed as the Viewer
  let authed = $state<boolean | null>(null); // null: checking the cookie
  let busy = $state(false);
  const errors = $state<Partial<Record<Section, string>>>({});
  let password = $state('');
  let link = $state('');
  let event = $state<EventInfo | null>(null);
  let roundId = $state('');
  let path = $state('');
  let config: Record<string, string> = {};
  let engineName = $state('');
  let options = $state<UciOption[]>([]);
  let values = $state<Record<string, string>>({});
  let saved = $state(false);
  let status = $state<AdminStatus | null>(null);
  let topN = $state('');
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
    const s = (status = await adminApi<AdminStatus>('GET', '/status'));
    [topN, checked] = [String(s.topN), s.round?.boards.filter((b) => b.tracked).map((b) => b.id) ?? []];
    return s;
  }
  async function loadStatus(): Promise<void> {
    const s = await refresh();
    authed = true;
    ({ path, options: config } = s.engine);
    await run('engine', probe); // form prefilled with the current (or default) config
  }
  const login = () =>
    run('login', async () => {
      await adminApi('POST', '/login', { password });
      password = '';
      await loadStatus();
    });

  const loadEvent = () =>
    run('round', async () => {
      event = await adminApi<EventInfo>('GET', `/event?link=${encodeURIComponent(link)}`);
      roundId = event.defaultRoundId ?? event.rounds[0]?.id ?? '';
    });
  const track = () =>
    run('round', async () => {
      await adminApi('POST', '/round', { link, roundId });
      await refresh();
    });

  async function probe(): Promise<void> {
    const p = await adminApi<Probe>('POST', '/engine/probe', { path });
    [engineName, options, values, saved] = [p.name, p.options, initialValues(p.options, config), false];
  }
  const save = () =>
    run('engine', async () => {
      const cfg = { path, options: changedOptions(options, values) };
      await adminApi('PUT', '/config', cfg);
      [config, saved] = [cfg.options, true];
    });
  const press = (name: string) => run('engine', () => adminApi('POST', '/engine/button', { name }));
  const clear = () =>
    run('status', async () => {
      await adminApi('POST', '/clear');
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
    return store.connect();
  });

  const snap = $derived(store.snap);
  const running = $derived(!!snap?.round); // an engine runs while there is a Current Round
</script>

<main class="admin">
  <h1>Admin</h1>
  {#if authed === false}
    <form onsubmit={(e) => (e.preventDefault(), login())}>
      <label>Password <input type="password" bind:value={password} autocomplete="current-password" /></label>
      <button disabled={busy}>Log in</button>
      {#if errors.login}<p class="error">{errors.login}</p>{/if}
    </form>
  {:else if authed}
    <section>
      <h2>Status</h2>
      <p>Event: <b>{snap?.event?.name ?? '–'}</b></p>
      <p>
        Current Round: <b>{snap?.round?.name ?? '–'}</b>
        {#if snap?.round}· {snap.round.boards.length} Tracked boards{/if}
      </p>
      <p>
        Lichess stream: <b>{snap?.stream ?? '–'}</b> · Server: <b>{store.connected ? 'connected' : 'reconnecting…'}</b>
      </p>
      <button disabled={busy || !snap?.event} onclick={clear}>Clear Event</button>
      {#if errors.status}<p class="error">{errors.status}</p>{/if}
    </section>

    <section>
      <h2>Round</h2>
      <form onsubmit={(e) => (e.preventDefault(), loadEvent())}>
        <label>
          Event link
          <input bind:value={link} placeholder="https://lichess.org/broadcast/…" required />
        </label>
        <button disabled={busy}>Load</button>
      </form>
      {#if event}
        <form onsubmit={(e) => (e.preventDefault(), track())}>
          <label>
            Round
            <select bind:value={roundId} disabled={busy}>
              {#each event.rounds as r (r.id)}
                <option value={r.id}>{r.name}{r.ongoing ? ' (live)' : r.finished ? ' (finished)' : ''}</option>
              {/each}
            </select>
          </label>
          <button disabled={busy || !roundId}>Track this Round</button>
        </form>
      {/if}
      {#if errors.round}<p class="error">{errors.round}</p>{/if}
    </section>

    {#if status}
      <section>
        <h2>Tracking</h2>
        <form onsubmit={(e) => (e.preventDefault(), control('/topn', { n: Number(topN) }))}>
          <label>
            Tracked boards in the next Round (top N)
            <input type="number" min="1" max="64" step="1" required bind:value={topN} />
          </label>
          <button disabled={busy}>Save</button>
        </form>
        <form onsubmit={(e) => (e.preventDefault(), setJobTime())}>
          <p>Job time: <b>{formatJobTime(status.jobTimeMs)}</b></p>
          <label>
            Seconds
            <input type="number" min="0.1" step="0.1" bind:value={jobSeconds} />
          </label>
          <button disabled={busy}>Set</button>
          <button type="button" disabled={busy} onclick={() => control('/jobtime', { ms: null })}>Unset</button>
        </form>
        {#if status.round}
          <form onsubmit={(e) => (e.preventDefault(), control('/tracked', { boardIds: checked }))}>
            {#each status.round.boards as b (b.id)}
              <label>
                <input type="checkbox" value={b.id} bind:group={checked} />
                Board {b.board} · {b.white.name} – {b.black.name} ({formatResult(b.result)})
              </label>
            {/each}
            <button disabled={busy}>Save tracked boards</button>
            <small>Applies to this Round only</small>
          </form>
        {:else}
          <p>No Current Round</p>
        {/if}
        {#if errors.tracking}<p class="error">{errors.tracking}</p>{/if}
      </section>
    {/if}

    <section>
      <h2>Kibitzer</h2>
      <form onsubmit={(e) => (e.preventDefault(), run('engine', probe))}>
        <label>Engine path <input bind:value={path} oninput={() => (options = [])} required /></label>
        <button disabled={busy}>Probe</button>
      </form>
      {#if options.length}
        <form onsubmit={(e) => (e.preventDefault(), save())}>
          <p>{engineName}</p>
          {#each options as o (o.name)}
            {#if o.type === 'button'}
              <p>
                <button type="button" disabled={busy || !running} onclick={() => press(o.name)}>{o.name}</button>
                <small>sent to the running engine, between searches</small>
              </p>
            {:else}
              <label>
                {o.name}
                {#if o.type === 'spin'}
                  <input
                    type="number"
                    min={o.min}
                    max={o.max}
                    required
                    value={values[o.name]}
                    oninput={(e) => (values[o.name] = e.currentTarget.value)}
                  />
                {:else if o.type === 'check'}
                  <input
                    type="checkbox"
                    checked={values[o.name] === 'true'}
                    onchange={(e) => (values[o.name] = String(e.currentTarget.checked))}
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
          <button disabled={busy}>Save</button>
          {#if saved}<span>Saved. A running engine restarts.</span>{/if}
        </form>
      {/if}
      {#if errors.engine}<p class="error">{errors.engine}</p>{/if}
    </section>
  {/if}
</main>

<style>
  /* tokens.css locks body scrolling for the full-screen Viewer, so this page scrolls itself. */
  .admin {
    height: 100vh;
    overflow-y: auto;
    padding: 16px 24px;
  }
  section {
    max-width: 720px;
    margin-bottom: 24px;
    padding: 12px 16px;
    background: var(--surface);
  }
  h2 {
    margin-top: 0;
  }
  label {
    display: flex;
    gap: 8px;
    align-items: center;
    margin: 6px 0;
  }
  input:not([type]) {
    flex: 1;
  }
  form {
    margin: 6px 0;
  }
  .error {
    color: var(--blunder);
  }
</style>
