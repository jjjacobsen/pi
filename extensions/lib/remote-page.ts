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
#changes { box-sizing: border-box; position: fixed; inset: 0; width: 100%; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: .75rem; border: 0; background: Canvas; color: CanvasText }
#changes[open] { display: flex; flex-direction: column; gap: .5rem }
#changes-heading, #change-toolbar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap }
#changes-heading h2 { font-size: 1.2rem; margin: 0; flex: 1 }
#change-toolbar button { min-width: 2.75rem; margin: .3rem 0 }
#changes-summary { margin: 0; white-space: pre-line }
#changes-main { display: flex; flex: 1; min-height: 0; gap: .75rem }
#change-files { flex: 0 0 16rem; overflow: auto; border-right: 1px solid GrayText; padding-right: .5rem }
#change-files button { display: block; width: 100%; text-align: left; overflow-wrap: anywhere; white-space: pre-wrap; margin: 0 0 .3rem }
#change-files button[aria-current="true"], #change-toolbar button[aria-pressed="true"] { outline: 2px solid Highlight; outline-offset: -2px }
#change-detail { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0 }
#change-path { margin: 0; font-size: 1rem; white-space: pre-wrap }
#change-content { overflow: auto; flex: 1; min-height: 0; overscroll-behavior: contain }
.change-code { display: table; min-width: 100%; width: max-content; font: var(--change-code-size, 12px)/1.5 ui-monospace, monospace; white-space: pre; overflow-wrap: normal; tab-size: 4; -webkit-text-size-adjust: 100%; text-size-adjust: 100% }
.change-line { display: table-row }
.change-line span { display: table-cell; padding-right: .6rem }
.change-line .line-number { min-width: 3ch; text-align: right; color: GrayText; user-select: none; border-right: 1px solid GrayText; padding-left: .4rem }
.change-line .line-text { padding-left: .5rem }
.change-add { background: light-dark(#dafbe1, #12381f); color: light-dark(#116329, #aff5b4) }
.change-delete { background: light-dark(#ffebe9, #4c161b); color: light-dark(#a40e26, #ffc1c1) }
.change-meta { color: GrayText }
@media (max-width: 600px) {
  header { gap: .4rem }
  #changes-main { flex-direction: column }
  #change-files { flex: 0 1 auto; max-height: 25dvh; border-right: 0; border-bottom: 1px solid GrayText; padding-right: 0 }
}
</style>
<header><h1>Pi remote</h1><button id="open-changes" type="button" disabled>Changes</button><div id="status" role="status">Connecting</div></header>
<dialog id="changes" aria-labelledby="changes-title">
<div id="changes-heading"><h2 id="changes-title">Changes · read-only</h2><button id="refresh-changes" type="button">Refresh</button><button id="close-changes" type="button">Close</button></div>
<p id="changes-summary" role="status"></p>
<div id="changes-main"><nav id="change-files" aria-label="Changed files"></nav><section id="change-detail" aria-label="Selected file">
<h3 id="change-path"></h3><div id="change-toolbar"><button id="change-diff" type="button" aria-pressed="true">Diff</button><button id="change-source" type="button" aria-pressed="false">Source</button><button id="change-smaller" type="button" aria-label="Decrease code font size">A−</button><button id="change-larger" type="button" aria-label="Increase code font size">A+</button></div>
<div id="change-content" tabindex="0" aria-label="Read-only file content"></div>
</section></div>
</dialog>
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
const changes = document.getElementById('changes');
const changesButton = document.getElementById('open-changes');
const changesSummary = document.getElementById('changes-summary');
const changeFiles = document.getElementById('change-files');
const changePath = document.getElementById('change-path');
const changeContent = document.getElementById('change-content');
const diffButton = document.getElementById('change-diff');
const sourceButton = document.getElementById('change-source');
const smallerButton = document.getElementById('change-smaller');
const largerButton = document.getElementById('change-larger');
let changeFontSize = 12;
function setChangeFontSize(size) {
  changeFontSize = Math.max(9, Math.min(18, size));
  changeContent.style.setProperty('--change-code-size', changeFontSize + 'px');
  smallerButton.disabled = changeFontSize === 9;
  largerButton.disabled = changeFontSize === 18;
  sessionStorage.setItem('pi-remote-code-size', String(changeFontSize));
}
smallerButton.onclick = () => setChangeFontSize(changeFontSize - 1);
largerButton.onclick = () => setChangeFontSize(changeFontSize + 1);
let workspace = '', changesRequest = 0, changeRequest = 0, changePathValue = '', changeView = 'diff', chatScroll = 0;
function clearChanges(message) {
  changesRequest++;
  changeRequest++;
  changeFiles.replaceChildren();
  changePath.textContent = '';
  changePathValue = '';
  changeContent.replaceChildren();
  changesSummary.textContent = message;
}
function renderChange(data) {
  changeContent.replaceChildren();
  if (data.message) { changeContent.textContent = data.message; return; }
  const code = document.createElement('div');
  code.className = 'change-code';
  let oldLine = 0, newLine = 0, inHunk = false;
  const lines = data.text.split('\\n');
  if (lines.at(-1) === '') lines.pop();
  lines.forEach((text, index) => {
    let before = '', after = '', kind = '';
    if (changeView === 'source') after = index + 1;
    else {
      const hunk = /^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)/.exec(text);
      if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true; kind = 'change-meta'; }
      else if (inHunk && text.startsWith('+')) { after = newLine++; kind = 'change-add'; }
      else if (inHunk && text.startsWith('-')) { before = oldLine++; kind = 'change-delete'; }
      else if (inHunk && text.startsWith(' ')) { before = oldLine++; after = newLine++; }
      else kind = 'change-meta';
    }
    const row = document.createElement('div');
    row.className = 'change-line ' + kind;
    for (const [value, className] of [[before, 'line-number'], [after, 'line-number'], [text, 'line-text']]) {
      const cell = document.createElement('span');
      cell.className = className;
      cell.textContent = value;
      row.append(cell);
    }
    code.append(row);
  });
  changeContent.append(code);
  changeContent.scrollTo(0, 0);
}
async function loadChange(path) {
  changePathValue = path;
  changePath.textContent = path;
  for (const button of changeFiles.querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.path === path));
  diffButton.setAttribute('aria-pressed', String(changeView === 'diff'));
  sourceButton.setAttribute('aria-pressed', String(changeView === 'source'));
  const id = ++changeRequest, current = workspace;
  changeContent.textContent = 'Loading…';
  try {
    const data = await (await request('/changes?' + new URLSearchParams({ workspace: current, path, view: changeView }))).json();
    if (!changes.open || id !== changeRequest || current !== workspace || data.workspace !== current) return;
    renderChange(data);
  } catch (error) { if (changes.open && id === changeRequest && current === workspace) changeContent.textContent = error.message; }
}
async function refreshChanges() {
  const previous = changePathValue;
  clearChanges('Loading…');
  const id = changesRequest, current = workspace;
  if (!current) { changesSummary.textContent = 'Waiting for the current session'; return; }
  try {
    const data = await (await request('/changes?' + new URLSearchParams({ workspace: current }))).json();
    if (!changes.open || id !== changesRequest || current !== workspace || data.workspace !== current) return;
    if (data.message) { changesSummary.textContent = data.message; return; }
    changesSummary.textContent = data.repository + '\\n' + data.files.length + ' changed files · +' + data.added + ' / −' + data.deleted
      + (data.omitted ? ' · ' + data.omitted + ' binary or unavailable files excluded from line counts' : '')
      + (data.hasHead ? ' · Compared with HEAD' : ' · No HEAD yet, current files shown as additions');
    for (const file of data.files) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.path = file.path;
      button.textContent = file.path;
      const detail = document.createElement('small');
      const labels = file.untracked ? ['Untracked'] : [file.status[0] !== ' ' ? 'Staged ' + file.status[0] : '', file.status[1] !== ' ' ? 'Unstaged ' + file.status[1] : ''].filter(Boolean);
      detail.textContent = labels.join(' · ') + (file.added === null ? ' · No line counts' : ' · +' + file.added + ' / −' + file.deleted);
      button.append(detail);
      button.onclick = () => loadChange(file.path);
      changeFiles.append(button);
    }
    if (data.files.length) loadChange(data.files.some(file => file.path === previous) ? previous : data.files[0].path);
    else changeContent.textContent = 'No changed files';
  } catch (error) { if (changes.open && id === changesRequest && current === workspace) changesSummary.textContent = error.message; }
}
changesButton.onclick = () => {
  chatScroll = window.scrollY;
  changes.showModal();
  document.body.style.overflow = 'hidden';
  refreshChanges();
};
document.getElementById('refresh-changes').onclick = refreshChanges;
document.getElementById('close-changes').onclick = () => changes.close();
changes.addEventListener('close', () => {
  clearChanges('');
  document.body.style.overflow = '';
  window.scrollTo(0, chatScroll);
});
diffButton.onclick = () => { changeView = 'diff'; if (changePathValue) loadChange(changePathValue); };
sourceButton.onclick = () => { changeView = 'source'; if (changePathValue) loadChange(changePathValue); };
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
  changesButton.disabled = !connected || changing || !workspace;
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
  workspace = '';
  if (changes.open) clearChanges('Disconnected. Reconnect, then refresh Changes');
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
      const nearBottom = !changes.open && (!leaf || window.innerHeight + window.scrollY >= document.body.scrollHeight - 180);
      if (workspace !== (state.workspace || '')) {
        workspace = state.workspace || '';
        if (changes.open) refreshChanges();
      }
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
    setChangeFontSize(Number(sessionStorage.getItem('pi-remote-code-size')) || 12);
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
