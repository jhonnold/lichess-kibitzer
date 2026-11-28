/** Whether this browser holds a valid Admin cookie: the Viewer shows its Admin controls only then. */
class AdminSession {
  admin = $state(false);
  #checked = false;

  /** GET /api/admin/session once per page load (200: logged in; the cookie is httpOnly, so it can't be read). */
  check(): void {
    if (this.#checked) return;
    this.#checked = true;
    fetch('/api/admin/session')
      .then((res) => (this.admin = res.ok))
      .catch(() => {});
  }

  /** The Admin page logged in (true), or a call answered 401 (false). */
  set(admin: boolean): void {
    this.#checked = true;
    this.admin = admin;
  }
}

export const session = new AdminSession();
