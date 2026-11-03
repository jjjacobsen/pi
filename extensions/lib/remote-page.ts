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
textarea, input { box-sizing: border-box; width: 100%; font: inherit; padding: .5rem }
textarea { min-height: 2.75rem; max-height: min(10rem, 30dvh); resize: none }
button { font: inherit; min-height: 2.75rem; padding: .4rem .7rem; margin: .3rem .3rem .3rem 0 }
#footer:not([hidden]) { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .7rem; padding: .25rem 0 .5rem; color: GrayText; font: .75rem ui-monospace, monospace }
#footer-cwd { flex: 1 1 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#footer-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#footer-git, #footer-context { flex-shrink: 0; white-space: nowrap }
#footer-context { margin-left: auto }
#footer-context[data-color="warning"] { color: light-dark(#805500, #ffc857) }
#footer-context[data-color="error"] { color: light-dark(#b00020, #ff8797) }
#composer { display: flex; align-items: end; gap: .4rem }
#commands, #attach { margin: 0; flex: 0 0 auto }
#attachment:not([hidden]) { display: flex; align-items: center; gap: .5rem; padding: .3rem 0 }
#preview { max-width: 6rem; max-height: 6rem; object-fit: contain }
#menu { border: 1px solid GrayText; padding: .5rem; margin-bottom: .5rem }
#menu-heading { display: flex; align-items: center; justify-content: space-between }
#choices { max-height: 30dvh; overflow-y: auto }
#choices button { display: block; width: 100%; text-align: left; margin: .2rem 0 }
#choices button[aria-selected="true"] { outline: 2px solid Highlight; outline-offset: -2px }
small { display: block; color: GrayText }
#notice { min-height: 1.5rem }
</style>
<header><h1>Pi remote</h1><div id="status" role="status">Connecting</div></header>
<main id="history" aria-label="Conversation history"></main>
<article id="live" hidden><strong>Pi (live)</strong><pre id="stream"></pre></article>
<form id="form">
<section id="menu" hidden aria-label="Command menu">
<div id="menu-heading"><strong id="menu-title">Commands</strong><button id="close-menu" type="button" aria-label="Close menu">Close</button></div>
<input id="session-filter" hidden aria-label="Filter saved sessions" placeholder="Search sessions…">
<div id="choices" role="listbox" aria-label="Commands"></div>
</section>
<div id="footer" hidden aria-label="Workspace and context status"><span id="footer-cwd"></span><span id="footer-branch"></span><span id="footer-git" aria-label="Git ahead, behind, changed, untracked, and staged counts"></span><span id="footer-context" aria-label="Context tokens used and window"></span></div>
<div id="attachment" hidden><img id="preview" alt="Pending image"><span id="image-name"></span><button id="remove-image" type="button">Remove</button></div>
<input id="image-file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
<div id="composer"><button id="commands" type="button" aria-label="Open command menu" aria-expanded="false" disabled>/</button><button id="attach" type="button" aria-label="Attach one image" title="PNG, JPEG, or WebP. Large images are resized before upload">Image</button><textarea id="prompt" aria-label="Message Pi, add an optional image caption, or type / for commands" rows="1" maxlength="60000" placeholder="Message Pi or type /…"></textarea></div>
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
const form = document.getElementById('form');
const footer = document.getElementById('footer');
const footerCwd = document.getElementById('footer-cwd');
const footerBranch = document.getElementById('footer-branch');
const footerGit = document.getElementById('footer-git');
const footerContext = document.getElementById('footer-context');
const commandButton = document.getElementById('commands');
const menu = document.getElementById('menu');
const menuTitle = document.getElementById('menu-title');
const sessionFilter = document.getElementById('session-filter');
const choices = document.getElementById('choices');
const imageFile = document.getElementById('image-file');
const attachment = document.getElementById('attachment');
const preview = document.getElementById('preview');
const imageName = document.getElementById('image-name');
let pendingImage = null;
let version = '', leaf = '', timer, noticeTimer, busy = false, submitting = false, accessToken = '';
let connected = false, stateName = '', recovering = false, menuMode = '', items = [], selected = 0;
function showNotice(message, temporary = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  if (temporary) noticeTimer = setTimeout(() => { notice.textContent = ''; }, 2000);
}
function removeImage() {
  if (pendingImage) URL.revokeObjectURL(pendingImage.url);
  pendingImage = null;
  preview.removeAttribute('src');
  attachment.hidden = true;
  controls();
}
async function prepareImage(file, url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (file.size <= 10 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  // Keep PNG lossless and retain PNG/WebP transparency. Never enlarge an image
  for (const edge of [2560, 1920, 1440]) {
    const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, file.type, 0.9));
    if (!blob) throw new Error('Image encoding failed');
    if (blob.size <= 10 * 1024 * 1024) return blob;
  }
  throw new Error('Image remains too large');
}
async function attachImage(file) {
  removeImage();
  const image = pendingImage = { file, url: URL.createObjectURL(file), ready: false };
  const name = file.name || 'Pasted image';
  preview.hidden = true;
  imageName.textContent = name + ' · Preparing…';
  attachment.hidden = false;
  controls();
  let error = !file.size ? 'This image file is empty. Choose another image'
    : !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? 'Choose one PNG, JPEG, or WebP image' : '';
  if (!error) {
    showNotice('Preparing image…');
    try {
      const prepared = await prepareImage(file, image.url);
      if (pendingImage !== image) return;
      if (prepared !== file) {
        URL.revokeObjectURL(image.url);
        image.url = URL.createObjectURL(prepared);
      }
      image.file = prepared;
      image.ready = true;
      preview.src = image.url;
      preview.hidden = false;
      imageName.textContent = name + (prepared !== file ? ' · Resized' : '');
      showNotice('Image attached. Add a caption or send the image alone');
    } catch {
      error = 'Cannot process this image or resize it below 10 MiB. Choose another PNG, JPEG, or WebP image';
    }
  }
  if (pendingImage !== image) return;
  if (error) {
    imageName.textContent = name + ' · Not ready. Choose another image or remove it';
    showNotice(error);
  }
  controls();
}
document.getElementById('attach').onclick = () => imageFile.click();
document.getElementById('remove-image').onclick = removeImage;
imageFile.onchange = () => {
  const file = imageFile.files[0];
  imageFile.value = '';
  if (file) attachImage(file);
};
prompt.addEventListener('paste', event => {
  const images = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  if (images.length !== 1) { showNotice('Paste one image at a time'); return; }
  const file = images[0].getAsFile();
  if (file) attachImage(file);
  else showNotice('Cannot read this clipboard image. Use the Image button');
});
window.addEventListener('pagehide', removeImage);
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ mimeType: file.type, data: reader.result.slice(reader.result.indexOf(',') + 1) });
    reader.onerror = () => reject(new Error('Cannot read this image. Choose it again'));
    reader.readAsDataURL(file);
  });
}
function controls() {
  const changing = stateName === 'Reloading' || stateName === 'Switching session';
  send.disabled = !connected || submitting || changing || stateName === 'Compacting' || !!(pendingImage && !pendingImage.ready);
  stop.disabled = !connected || changing;
  commandButton.disabled = !connected || submitting || changing;
}
function resizePrompt() {
  prompt.style.height = 'auto';
  prompt.style.height = prompt.scrollHeight + prompt.offsetHeight - prompt.clientHeight + 'px';
}
function closeMenu() {
  menu.hidden = true;
  menuMode = '';
  commandButton.setAttribute('aria-expanded', 'false');
}
function renderChoices() {
  const query = (menuMode === 'sessions' ? sessionFilter.value : prompt.value.trim().slice(1)).toLowerCase();
  const filtered = items.filter(item => (item.label + ' ' + item.description).toLowerCase().includes(query));
  selected = Math.min(selected, Math.max(0, filtered.length - 1));
  choices.replaceChildren(...filtered.map((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === selected));
    button.textContent = item.label;
    const description = document.createElement('small');
    description.textContent = item.description;
    button.append(description);
    button.onclick = () => {
      closeMenu();
      prompt.value = item.value;
      resizePrompt();
      prompt.focus();
      if (item.run) form.requestSubmit();
    };
    return button;
  }));
  if (!filtered.length) choices.textContent = menuMode === 'sessions' ? 'No saved sessions match' : 'No remote commands match';
}
async function openMenu(mode) {
  menuMode = mode;
  menu.hidden = false;
  commandButton.setAttribute('aria-expanded', 'true');
  menuTitle.textContent = mode === 'sessions' ? 'Resume session' : 'Commands · type to filter';
  sessionFilter.hidden = mode !== 'sessions';
  if (mode === 'sessions') { sessionFilter.value = ''; sessionFilter.focus(); }
  choices.textContent = 'Loading…';
  selected = 0;
  try {
    const data = await (await request(mode === 'sessions' ? '/sessions' : '/commands')).json();
    if (menuMode !== mode) return;
    items = mode === 'sessions'
      ? data.filter(item => !item.current).map(item => ({ label: item.name,
          description: new Date(item.modified).toLocaleString() + ' · ' + item.messageCount + ' messages · ' + item.id.slice(0, 8),
          value: '/resume ' + item.id, run: true }))
      : data.map(item => ({ label: '/' + item.name, description: item.description || '',
          value: '/' + item.name, run: ['new', 'reload', 'resume'].includes(item.name) }));
    renderChoices();
  } catch (error) { if (menuMode === mode) choices.textContent = error.message; }
}
prompt.addEventListener('input', () => {
  resizePrompt();
  if (/^\\/[^\\s]*$/.test(prompt.value.trim())) {
    selected = 0;
    if (menuMode === 'commands') renderChoices();
    else openMenu('commands');
  } else closeMenu();
});
commandButton.onclick = () => {
  prompt.value = '/';
  resizePrompt();
  prompt.focus();
  openMenu('commands');
};
document.getElementById('close-menu').onclick = () => { closeMenu(); prompt.focus(); };
sessionFilter.oninput = () => { selected = 0; renderChoices(); };
form.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeMenu(); prompt.focus(); event.preventDefault(); }
  if (menu.hidden || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.shiftKey) return;
  const buttons = choices.querySelectorAll('button');
  if (!buttons.length) return;
  event.preventDefault();
  if (event.key === 'Enter') { buttons[selected].click(); return; }
  selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  renderChoices();
  choices.querySelectorAll('button')[selected].scrollIntoView({ block: 'nearest' });
});
window.addEventListener('resize', resizePrompt);
resizePrompt();
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', credentials: 'omit', signal: options.signal || AbortSignal.timeout(15000),
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
  connected = false;
  footer.hidden = true;
  recovering = true;
  version = '';
  status.textContent = accessToken ? 'Reconnecting…' : 'Disconnected. Open the private /remote link';
  showNotice(error.message);
  controls();
  reconnect.hidden = false;
  if (accessToken) timer = setTimeout(poll, 1500);
}
async function poll() {
  clearTimeout(timer);
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
      footer.hidden = !state.footer;
      if (state.footer) {
        footerCwd.textContent = footerCwd.title = state.footer.cwd;
        footerBranch.textContent = footerBranch.title = state.footer.branch || '';
        footerBranch.hidden = !state.footer.branch;
        footerGit.textContent = state.footer.branch ? state.footer.gitStatus : '';
        footerContext.textContent = state.footer.context;
        footerContext.dataset.color = state.footer.contextColor;
      }
      stream.textContent = state.live ? state.live.text : '';
      live.hidden = !state.live;
      stateName = state.state;
      status.textContent = stateName + (state.pending ? ' (queued prompts)' : '');
      busy = stateName !== 'Idle';
      version = state.version;
      if (state.leaf) leaf = state.leaf;
      if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
    }
    connected = true;
    controls();
    if (recovering) { recovering = false; showNotice(''); }
    reconnect.hidden = true;
    timer = setTimeout(poll, 700);
  } catch (error) { disconnected(error); }
}
form.onsubmit = async event => {
  event.preventDefault();
  if ((!prompt.value.trim() && !pendingImage) || (pendingImage && !pendingImage.ready) || submitting || !connected) return;
  const text = prompt.value;
  const value = text.trim();
  const image = pendingImage;
  const command = value.startsWith('/');
  closeMenu();
  if (command && image) { showNotice('Images cannot be attached to slash commands. Remove the image first'); return; }
  if (new TextEncoder().encode(text).length > 64 * 1024) { showNotice('Text is too large (64 KiB limit)'); return; }
  if (value === '/resume') { await openMenu('sessions'); return; }
  submitting = true;
  controls();
  const queued = busy;
  try {
    if (image) showNotice('Sending image…');
    const body = { text: command ? value : text, ...(image ? { image: await readImage(image.file) } : {}) };
    const response = await request(command ? '/command' : '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(image ? 60000 : 15000) });
    if (prompt.value === text) {
      prompt.value = '';
      resizePrompt();
    }
    if (pendingImage === image) removeImage();
    showNotice(command ? await response.text() : queued ? 'Queued' : 'Sent', true);
  } catch (error) { showNotice(error.message + (command ? '. Check the current session before trying again' : '')); }
  finally { submitting = false; version = ''; controls(); }
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
