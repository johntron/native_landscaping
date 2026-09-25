/**
 * The banner the design tool shows over the shared example yard (nl-3s5.24):
 * it says the yard is read-only and offers "Copy to my yards", which asks the
 * server for a private copy (POST /api/projects/copy-example) and reloads onto
 * it, the same navigation the project picker uses to switch yards.
 */
import { PROJECT_QUERY_PARAM } from './projectPicker.js';

/**
 * @param {{ banner: HTMLElement | null, button: HTMLButtonElement | null, status: HTMLElement | null,
 *   fetchFn?: typeof fetch, navigate?: (url: string) => void }} options
 */
export function initExampleBanner({ banner, button, status, fetchFn = fetch, navigate = (url) => window.location.assign(url) }) {
  if (!banner) return;
  banner.hidden = false;
  if (!button) return;

  const setStatus = (message, state) => {
    if (!status) return;
    status.textContent = message || '';
    if (state) status.dataset.state = state;
    else delete status.dataset.state;
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    setStatus('Copying…');
    try {
      const response = await fetchFn('/api/projects/copy-example', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.id) {
        throw new Error(payload.error || `Request failed (${response.status})`);
      }
      const url = new URL(window.location.href);
      url.searchParams.set(PROJECT_QUERY_PARAM, payload.id);
      navigate(url.toString());
    } catch (err) {
      button.disabled = false;
      setStatus(err.message, 'error');
    }
  });
}
