export function remotePage(nonce: string) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer">
<title>Pi remote</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; font: 16px system-ui, sans-serif }
body { max-width: 55rem; margin: auto; padding: 1rem; overflow-wrap: anywhere }
header { position: sticky; top: 0; background: Canvas; padding: .5rem 0; border-bottom: 1px solid GrayText }
h1 { font-size: 1.2rem; margin: 0 }
article { margin: 1rem 0; border-left: 2px solid GrayText; padding-left: .75rem }
pre { white-space: pre-wrap; font: inherit; margin: .3rem 0 }
#live { border-color: Highlight }
form { position: sticky; bottom: 0; background: Canvas; padding-top: .5rem }
textarea { box-sizing: border-box; width: 100%; min-height: 6rem; font: inherit; padding: .5rem }
button { font: inherit; min-height: 2.75rem; padding: .4rem .7rem; margin: .3rem .3rem .3rem 0 }
#notice { min-height: 1.5rem }
small { display: block; color: GrayText }
</style>
<header><h1>Pi remote</h1><div id="status" role="status">Connecting</div>
<small>Private link grants control of this Pi session. Dialogs need the terminal</small></header>
<main id="history" aria-label="Conversation history"></main>
<article id="live" hidden><strong>Pi (live)</strong><pre id="stream"></pre></article>
<form id="form">
<label for="prompt">Plain text prompt or follow-up</label>
<textarea id="prompt" maxlength="60000" placeholder="Slash commands need the terminal"></textarea>
<div><button id="send" disabled>Send / queue follow-up</button><button id="stop" type="button" disabled>Stop Pi</button><button id="reconnect" type="button" hidden>Reconnect</button></div>
<div id="notice" role="status"></div>
</form>
<script nonce="${nonce}">
const status = document.getElementById('status');
const history = document.getElementById('history');
const live = document.getElementById('live');
const stream = document.getElementById('stream');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const reconnect = document.getElementById('reconnect');
const notice = document.getElementById('notice');
let version = '', leaf = '', timer, submitting = false, accessToken = '';
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + accessToken, ...options.headers } });
  if (!response.ok) throw new Error(await response.text());
  return response;
}
function disconnected(error) {
  clearTimeout(timer);
  status.textContent = 'Disconnected. Run /remote in the terminal if access is off';
  notice.textContent = error.message;
  send.disabled = stop.disabled = true;
  reconnect.hidden = false;
}
async function poll() {
  try {
    const response = await request('/state?' + new URLSearchParams({ version, leaf }));
    if (response.status !== 204) {
      const state = await response.json();
      const nearBottom = !leaf || window.innerHeight + window.scrollY >= document.body.scrollHeight - 180;
      if (state.history) {
        const nodes = state.history.map(message => {
          const article = document.createElement('article');
          const role = document.createElement('strong');
          const content = document.createElement('pre');
          role.textContent = message.role;
          content.textContent = message.text;
          article.append(role, content);
          return article;
        });
        history.replaceChildren(...nodes);
      }
      stream.textContent = state.live ? state.live.text : '';
      live.hidden = !state.live;
      status.textContent = state.state + (state.pending ? ' (queued prompts)' : '');
      send.disabled = submitting || state.state === 'Compacting';
      stop.disabled = false;
      version = state.version;
      leaf = state.leaf;
      if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
    }
    reconnect.hidden = true;
    timer = setTimeout(poll, 700);
  } catch (error) { disconnected(error); }
}
document.getElementById('form').onsubmit = async event => {
  event.preventDefault();
  if (!prompt.value.trim() || submitting) return;
  submitting = true;
  send.disabled = true;
  const value = prompt.value;
  try {
    const response = await request('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }) });
    if (prompt.value === value) prompt.value = '';
    notice.textContent = await response.text();
  } catch (error) { notice.textContent = error.message; }
  finally { submitting = false; version = ''; }
};
stop.onclick = async () => {
  try { notice.textContent = await (await request('/stop', { method: 'POST' })).text(); }
  catch (error) { disconnected(error); }
};
reconnect.onclick = () => { reconnect.hidden = true; version = ''; poll(); };
async function connect() {
  const token = location.hash.slice(1);
  window.history.replaceState(null, '', '/');
  try {
    if (!token) throw new Error('Open the private link from /remote again. Refreshing the page clears browser access');
    accessToken = (await (await request('/auth', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).json()).accessToken;
    await poll();
  } catch (error) { disconnected(error); }
}
connect();
</script>
</html>`;
}
