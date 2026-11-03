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
header { position: sticky; top: 0; background: Canvas; padding: .5rem 0; border-bottom: 1px solid GrayText; display: flex; align-items: center; justify-content: space-between; gap: 1rem }
h1 { font-size: 1.2rem; margin: 0; white-space: nowrap }
#status { text-align: right }
article { margin: 1rem 0; border-left: 2px solid GrayText; padding-left: .75rem }
pre { white-space: pre-wrap; font: inherit; margin: .3rem 0 }
#live { border-color: Highlight }
form { position: sticky; bottom: 0; background: Canvas; padding-top: .5rem }
textarea { box-sizing: border-box; width: 100%; min-height: 2.75rem; max-height: min(10rem, 30dvh); resize: none; font: inherit; padding: .5rem }
button { font: inherit; min-height: 2.75rem; padding: .4rem .7rem; margin: .3rem .3rem .3rem 0 }
#notice { min-height: 1.5rem }
</style>
<header><h1>Pi remote</h1><div id="status" role="status">Connecting</div></header>
<main id="history" aria-label="Conversation history"></main>
<article id="live" hidden><strong>Pi (live)</strong><pre id="stream"></pre></article>
<form id="form">
<textarea id="prompt" aria-label="Message Pi" rows="1" maxlength="60000" placeholder="Message Pi…"></textarea>
<div><button id="send" disabled>Send</button><button id="stop" type="button" disabled>Stop</button><button id="reconnect" type="button" hidden>Reconnect</button></div>
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
let version = '', leaf = '', timer, noticeTimer, busy = false, submitting = false, accessToken = '';
function showNotice(message, temporary = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  if (temporary) noticeTimer = setTimeout(() => { notice.textContent = ''; }, 2000);
}
function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = prompt.scrollHeight + prompt.offsetHeight - prompt.clientHeight + 'px';
}
prompt.addEventListener('input', resizePrompt);
window.addEventListener('resize', resizePrompt);
resizePrompt();
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + accessToken, ...options.headers } });
  if (response.status === 401) {
    sessionStorage.removeItem('pi-remote-access');
    accessToken = '';
  }
  if (!response.ok) throw new Error(await response.text());
  return response;
}
function disconnected(error) {
  clearTimeout(timer);
  status.textContent = 'Disconnected. Run /remote in the terminal if access is off';
  showNotice(error.message);
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
      busy = state.state !== 'Idle';
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
  const queued = busy;
  try {
    await request('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }) });
    if (prompt.value === value) {
      prompt.value = '';
      resizePrompt();
    }
    showNotice(queued ? 'Queued' : 'Sent', true);
  } catch (error) { showNotice(error.message); }
  finally { submitting = false; version = ''; }
};
stop.onclick = async () => {
  try { showNotice(await (await request('/stop', { method: 'POST' })).text()); }
  catch (error) { disconnected(error); }
};
reconnect.onclick = () => { reconnect.hidden = true; version = ''; poll(); };
async function connect() {
  const token = location.hash.slice(1);
  window.history.replaceState(null, '', '/');
  try {
    if (token) {
      // A new link replaces the old credential even when authentication fails
      sessionStorage.removeItem('pi-remote-access');
      accessToken = (await (await request('/auth', { method: 'POST', headers: { Authorization: 'Bearer ' + token } })).json()).accessToken;
      sessionStorage.setItem('pi-remote-access', accessToken);
    } else {
      accessToken = sessionStorage.getItem('pi-remote-access') || '';
    }
    if (!accessToken) throw new Error('Open the private link from /remote in the terminal');
    await poll();
  } catch (error) { disconnected(error); }
}
// Opening a new fragment in this tab must replace the active connection too
window.addEventListener('hashchange', () => window.location.reload());
connect();
</script>
</html>`;
}
