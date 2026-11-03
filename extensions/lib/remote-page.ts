export function remotePage(nonce: string) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer">
<title>Pi remote</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; font: 16px system-ui, sans-serif; --control-bg: light-dark(#fafbfc, #1c2026); --control-border: light-dark(#7d8997, #748292); --control-hover: light-dark(#edf1f5, #29313b); --accent-bg: light-dark(#eef4fc, #202f43); --accent-hover: light-dark(#e1ecfa, #2b405c); --accent-border: light-dark(#6b87aa, #6d8eb8); --accent-text: light-dark(#234f85, #b8d6ff) }
body { --bottom-space: max(1rem, env(safe-area-inset-bottom)); max-width: 55rem; margin: auto; padding: 1rem 1rem var(--bottom-space); overflow-wrap: anywhere }
header { position: sticky; top: 0; background: Canvas; padding: .125rem 0; border-bottom: 1px solid var(--control-border); display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 1rem }
h1 { font-size: 1.5rem; font-weight: 500; line-height: 1; margin: 0; white-space: nowrap }
#status { min-width: 0; display: flex; align-items: center; justify-content: flex-end; gap: .4rem; font-size: .875rem; text-align: right }
#status::before { box-sizing: border-box; flex: 0 0 auto; width: .5rem; height: .5rem; border-radius: 50% }
#status[data-state="Idle"]::before { content: ''; background: GrayText }
#status[data-state="Working"]::before { content: ''; width: .75rem; height: .75rem; border: 2px solid var(--control-border); border-top-color: var(--accent-text); animation: working-spin 1s linear infinite }
@keyframes working-spin { to { transform: rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { #status[data-state="Working"]::before { animation: none } }
article { margin: 1rem 0; border-left: 2px solid GrayText; padding-left: .75rem }
pre { white-space: pre-wrap; font: inherit; margin: .3rem 0 }
.tool-result summary { box-sizing: border-box; min-height: 44px; padding: .6rem 0; cursor: pointer }
.tool-result summary:focus-visible { outline: 2px solid Highlight; outline-offset: 2px }
@media (hover: hover) { .tool-result summary:hover { background: var(--control-hover) } }
#live { border-color: Highlight }
form { position: sticky; bottom: var(--bottom-space); background: Canvas; padding-top: .5rem }
textarea, input { box-sizing: border-box; width: 100%; font: inherit; padding: .5rem }
textarea { display: block; line-height: 1.75rem; max-height: min(10rem, 30dvh); resize: none }
button { -webkit-appearance: none; appearance: none; box-sizing: border-box; font: inherit; min-width: 2.75rem; min-height: 2.75rem; padding: .4rem .7rem; margin: .3rem .3rem .3rem 0; border: 1px solid var(--control-border); border-radius: .3rem; background: var(--control-bg); color: CanvasText }
button:enabled { cursor: pointer }
@media (hover: hover) { button:enabled:hover { background: var(--control-hover) } }
button:enabled:active { background: var(--control-hover) }
button:disabled { background: transparent; border-color: light-dark(#c4cad1, #3e4855); color: light-dark(#687381, #929caa) }
button:focus-visible { outline: 2px solid Highlight; outline-offset: 2px }
#send, #record { --control-bg: var(--accent-bg); --control-hover: var(--accent-hover); --control-border: var(--accent-border) }
#send:enabled, #record:enabled { color: var(--accent-text) }
#composer[data-recording] #record:enabled { --control-bg: light-dark(#fff1f3, #3d232a); --control-hover: light-dark(#ffe3e8, #512c36); --control-border: light-dark(#b00020, #ff8797); color: light-dark(#b00020, #ff8797) }
#footer:not([hidden]) { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .7rem; padding: .25rem 0 .5rem; color: GrayText; font: .75rem ui-monospace, monospace }
#footer-cwd { flex: 1 1 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#footer-branch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#footer-git, #footer-context { flex-shrink: 0; white-space: nowrap }
#footer-context { margin-left: auto }
#footer-context[data-color="warning"] { color: light-dark(#805500, #ffc857) }
#footer-context[data-color="error"] { color: light-dark(#b00020, #ff8797) }
#footer-model-status { display: flex; flex: 0 0 100%; min-width: 0; gap: .7rem }
#footer-model { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
#footer-reasoning { flex-shrink: 0; white-space: nowrap }
#composer { display: flex; align-items: center; gap: .25rem }
#composer button { margin: .3rem 0; flex: 0 0 auto; width: 2.75rem; padding: 0 }
#composer #record { margin-left: auto }
#composer svg { width: 1.4rem; height: 1.4rem; vertical-align: middle }
#voice-status { flex: 1; min-width: 0; text-align: center; font-size: .875rem }
#composer:not([data-voice]) #voice-status, #composer:not([data-voice]) .voice-square, #composer[data-voice] .voice-mic, #composer[data-voice] .idle-action { display: none }
#composer[data-recording] #voice-status::before { content: ''; display: inline-block; width: .5rem; height: .5rem; margin-right: .5rem; border-radius: 50%; background: light-dark(#b00020, #ff8797) }
.attachment { display: flex; align-items: center; gap: .5rem; padding: .3rem 0 }
.attachment img { max-width: 6rem; max-height: 6rem; object-fit: contain }
#menu { border: 1px solid GrayText; padding: .5rem; margin-bottom: .5rem }
#menu-heading { display: flex; align-items: center; justify-content: space-between }
#choices { max-height: 30dvh; overflow-y: auto }
#choices button { display: block; width: 100%; text-align: left; margin: .2rem 0 }
#choices button[aria-selected="true"], #change-files button[aria-current="true"], #change-toolbar button[aria-pressed="true"] { --control-bg: var(--accent-bg); --control-hover: var(--accent-hover); --control-border: var(--accent-border); color: var(--accent-text); box-shadow: inset 0 0 0 1px var(--accent-border) }
small { display: block; color: GrayText }
#notice { box-sizing: border-box; position: fixed; inset: calc(5.5rem + env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) auto max(1rem, env(safe-area-inset-left)); max-width: 32rem; max-height: calc(100dvh - 6.5rem - env(safe-area-inset-top) - env(safe-area-inset-bottom)); margin: 0 auto; padding: .5rem .5rem .5rem 1rem; border: 1px solid light-dark(#b00020, #ff8797); border-radius: .3rem; background: Canvas; color: CanvasText; box-shadow: 0 .25rem 1rem #0004; overflow: auto }
#notice:popover-open { display: flex; align-items: center; gap: .75rem }
#notice-message { flex: 1; min-width: 0; white-space: pre-wrap }
#dismiss-notice { flex: 0 0 auto; margin: 0 }
#changes { box-sizing: border-box; position: fixed; inset: 0; width: 100%; height: 100dvh; max-width: none; max-height: none; margin: 0; padding: .75rem; border: 0; background: Canvas; color: CanvasText }
#changes[open] { display: flex; flex-direction: column; gap: .5rem }
#changes-heading, #change-toolbar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap }
#changes-heading h2 { font-size: 1.2rem; margin: 0; flex: 1 }
#change-toolbar button { min-width: 2.75rem; margin: .3rem 0 }
#changes-summary { margin: 0; white-space: pre-line }
#changes-main { display: flex; flex: 1; min-height: 0; gap: .75rem }
#change-files { flex: 0 0 16rem; overflow: auto; border-right: 1px solid GrayText; padding-right: .5rem }
#change-files button { display: block; width: 100%; text-align: left; overflow-wrap: anywhere; white-space: pre-wrap; margin: 0 0 .3rem }
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
<header><h1 aria-label="Pi remote">π</h1><div id="status" role="status">Connecting</div></header>
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
<div id="footer" hidden aria-label="Workspace, context, model, and reasoning status"><span id="footer-cwd"></span><span id="footer-branch"></span><span id="footer-git" aria-label="Git ahead, behind, changed, untracked, and staged counts"></span><span id="footer-context" aria-label="Context tokens used and window"></span><span id="footer-model-status"><span id="footer-model" aria-label="Current model"></span><span id="footer-reasoning" aria-label="Reasoning level"></span></span></div>
<div id="attachments" aria-label="Pending images"></div>
<input id="image-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
<textarea id="prompt" aria-label="Message Pi or type a command" rows="1" maxlength="60000" placeholder="Message Pi or type a command…"></textarea>
<div id="composer">
<button id="voice-cancel" type="button" aria-label="Cancel voice" title="Cancel voice and discard audio" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
<button id="attach" class="idle-action" type="button" aria-label="Attach up to five images" title="Up to five PNG, JPEG, or WebP images. Large images are resized before upload"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><path d="m3 17 5-5 4 4 4-6 5 7"/></svg></button>
<button id="stop" class="idle-action" type="button" aria-label="Stop Pi" title="Stop Pi" disabled><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
<button id="open-changes" class="idle-action" type="button" aria-label="Changes" title="Changes" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M5 7h8M9 3v8M11 17h8"/></svg></button>
<button id="commands" class="idle-action" type="button" aria-label="Open command menu" aria-expanded="false" disabled>/</button>
<button id="send" class="idle-action" aria-label="Send" title="Send" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5m-6 6 6-6 6 6"/></svg></button>
<small id="voice-status" role="status"></small>
<button id="record" type="button" aria-label="Record a voice message" title="Record a voice message" disabled><svg class="voice-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg><svg class="voice-square" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
</div>
<button id="reconnect" type="button" hidden>Reconnect</button>
</form>
<div id="notice" popover="manual"><span id="notice-message" role="alert" aria-live="assertive" aria-atomic="true"></span><button id="dismiss-notice" type="button" aria-label="Dismiss notification">×</button></div>
<script nonce="${nonce}">
const status = document.getElementById('status');
const history = document.getElementById('history');
const live = document.getElementById('live');
const stream = document.getElementById('stream');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const reconnect = document.getElementById('reconnect');
const composer = document.getElementById('composer');
const recordButton = document.getElementById('record');
const voiceCancel = document.getElementById('voice-cancel');
const voiceStatus = document.getElementById('voice-status');
let voice = null;
const voiceSupported = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
const voiceMime = voiceSupported ? ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type)) : '';
function releaseMicrophone(job) {
  if (job.recorder && job.recorder.state !== 'inactive') job.recorder.stop();
  job.stream?.getTracks().forEach(track => track.stop());
}
function cancelVoice(message) {
  if (!voice) return;
  const job = voice;
  voice = null;
  job.controller.abort();
  job.chunks = [];
  releaseMicrophone(job);
  voiceStatus.textContent = '';
  if (message) showError(message);
  controls();
}
async function transcribeVoice(job) {
  voiceStatus.textContent = 'Transcribing…';
  controls();
  try {
    const audio = new Blob(job.chunks, { type: job.recorder.mimeType });
    job.chunks = [];
    if (!audio.size) throw new Error('Recording is empty. Record again');
    const data = await (await request('/transcribe?' + new URLSearchParams({ workspace: job.workspace }), {
      method: 'POST', headers: { 'Content-Type': audio.type }, body: audio,
      signal: job.controller.signal,
    })).json();
    if (voice !== job || workspace !== job.workspace || data.workspace !== job.workspace) return;
    if (data.text) {
      prompt.value += (prompt.value && !/\\s$/.test(prompt.value) ? ' ' : '') + data.text;
      resizePrompt();
    } else showError('No speech found. Record again');
  } catch (error) { if (voice === job) showError(error.message); }
  finally {
    if (voice === job) { voice = null; voiceStatus.textContent = ''; controls(); }
  }
}
recordButton.onclick = async () => {
  if (voice?.recorder?.state === 'recording' && !voice.send) {
    voice.send = true;
    voiceStatus.textContent = 'Transcribing…';
    releaseMicrophone(voice);
    controls();
    return;
  }
  if (voice || !connected || !workspace || !voiceMime) return;
  closeMenu();
  const job = voice = { workspace, controller: new AbortController(), chunks: [], send: false };
  voiceStatus.textContent = 'Waiting for microphone…';
  controls();
  voiceCancel.focus();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (voice !== job) { stream.getTracks().forEach(track => track.stop()); return; }
    job.stream = stream;
    const recorder = job.recorder = new MediaRecorder(stream, { mimeType: voiceMime });
    recorder.ondataavailable = event => {
      if (voice !== job) return;
      job.chunks.push(event.data);
    };
    recorder.onerror = () => { if (voice === job) cancelVoice('Recording failed. Try again'); };
    recorder.onstop = () => {
      if (voice !== job) return;
      releaseMicrophone(job);
      if (job.send) transcribeVoice(job);
      else cancelVoice('Recording stopped. Record again');
    };
    recorder.start(1000);
    voiceStatus.textContent = 'Recording';
    controls();
  } catch (error) {
    if (voice !== job) return;
    cancelVoice(error.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in browser settings'
      : error.name === 'NotFoundError' ? 'No microphone found' : 'Cannot start microphone: ' + error.message);
  }
};
voiceCancel.onclick = () => cancelVoice();
window.addEventListener('pagehide', () => cancelVoice());
const notice = document.getElementById('notice');
const noticeMessage = document.getElementById('notice-message');
function dismissNotice() {
  notice.hidePopover();
  noticeMessage.textContent = '';
}
document.getElementById('dismiss-notice').onclick = dismissNotice;
const form = document.getElementById('form');
const footer = document.getElementById('footer');
const footerCwd = document.getElementById('footer-cwd');
const footerBranch = document.getElementById('footer-branch');
const footerGit = document.getElementById('footer-git');
const footerContext = document.getElementById('footer-context');
const footerModel = document.getElementById('footer-model');
const footerReasoning = document.getElementById('footer-reasoning');
const commandButton = document.getElementById('commands');
const menu = document.getElementById('menu');
const menuTitle = document.getElementById('menu-title');
const sessionFilter = document.getElementById('session-filter');
const choices = document.getElementById('choices');
const imageFile = document.getElementById('image-file');
const attachments = document.getElementById('attachments');
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
  if (notice.matches(':popover-open')) presentNotice();
  refreshChanges();
};
document.getElementById('refresh-changes').onclick = refreshChanges;
document.getElementById('close-changes').onclick = () => changes.close();
changes.addEventListener('close', () => {
  if (notice.matches(':popover-open')) presentNotice();
  clearChanges('');
  document.body.style.overflow = '';
  window.scrollTo(0, chatScroll);
});
diffButton.onclick = () => { changeView = 'diff'; if (changePathValue) loadChange(changePathValue); };
sourceButton.onclick = () => { changeView = 'source'; if (changePathValue) loadChange(changePathValue); };
let pendingImages = [];
const expandedResults = new Set();
let historyWorkspace = '';
let version = '', leaf = '', timer, submitting = false, accessToken = '';
let connected = false, stateName = '', recovering = false, menuMode = '', items = [], selected = 0;
function presentNotice() {
  // Keep the toast above, and interactive inside, the modal Changes dialog
  notice.hidePopover();
  (changes.open ? changes : document.body).append(notice);
  notice.showPopover();
}
function showError(message) {
  noticeMessage.textContent = message;
  presentNotice();
}
function removeImage(image) {
  if (!pendingImages.includes(image)) return;
  pendingImages = pendingImages.filter(item => item !== image);
  URL.revokeObjectURL(image.url);
  image.row.remove();
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
  const row = document.createElement('div');
  row.className = 'attachment';
  const preview = document.createElement('img');
  preview.alt = 'Pending image';
  preview.hidden = true;
  const label = document.createElement('span');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  row.append(preview, label, remove);
  attachments.append(row);
  const image = { file, url: URL.createObjectURL(file), ready: false, row };
  pendingImages.push(image);
  remove.onclick = () => removeImage(image);
  const name = file.name || 'Pasted image';
  label.textContent = name + ' · Preparing…';
  controls();
  let error = !file.size ? 'This image file is empty. Choose another image'
    : !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? 'Choose PNG, JPEG, or WebP images' : '';
  if (!error) {
    try {
      const prepared = await prepareImage(file, image.url);
      if (!pendingImages.includes(image)) return;
      if (prepared !== file) {
        URL.revokeObjectURL(image.url);
        image.url = URL.createObjectURL(prepared);
      }
      image.file = prepared;
      image.ready = true;
      preview.src = image.url;
      preview.hidden = false;
      label.textContent = name + (prepared !== file ? ' · Resized' : '');
    } catch {
      error = 'Cannot process this image or resize it below 10 MiB. Choose another PNG, JPEG, or WebP image';
    }
  }
  if (!pendingImages.includes(image)) return;
  if (error) {
    label.textContent = name + ' · Not ready. Remove it and choose another image';
    showError(error);
  }
  controls();
}
function attachImages(files) {
  if (!files.length) return;
  if (pendingImages.length + files.length > 5) {
    showError('Attach up to five images per message. Remove images or choose fewer files');
    return;
  }
  files.forEach(file => attachImage(file));
}
document.getElementById('attach').onclick = () => imageFile.click();
imageFile.onchange = () => {
  const files = Array.from(imageFile.files);
  imageFile.value = '';
  attachImages(files);
};
prompt.addEventListener('paste', event => {
  const images = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (!images.length) return;
  event.preventDefault();
  const files = images.map(item => item.getAsFile());
  if (files.some(file => !file)) { showError('Cannot read these clipboard images. Use the Image button'); return; }
  attachImages(files);
});
window.addEventListener('pagehide', () => pendingImages.slice().forEach(removeImage));
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
  send.disabled = !connected || submitting || changing || !!voice || stateName === 'Compacting' || pendingImages.some(image => !image.ready);
  const recording = voice?.recorder?.state === 'recording' && !voice.send;
  const voiceFocused = document.activeElement === voiceCancel;
  composer.toggleAttribute('data-voice', !!voice);
  composer.toggleAttribute('data-recording', !!recording);
  recordButton.disabled = voice ? !recording : !connected || !workspace || submitting || changing || !voiceMime;
  recordButton.title = voice ? (recording ? 'Stop recording and transcribe' : voice.send ? 'Transcribing' : 'Waiting for microphone permission')
    : !window.isSecureContext ? 'Voice requires HTTPS' : !voiceMime ? 'Voice is not supported in this browser' : 'Record a voice message';
  recordButton.setAttribute('aria-label', recordButton.title);
  voiceCancel.hidden = !voice;
  if (!voice && voiceFocused) recordButton.focus();
  stop.disabled = !connected || changing;
  commandButton.disabled = !connected || submitting || changing || !!voice;
  changesButton.disabled = !connected || changing || !workspace;
}
function resizePrompt() {
  prompt.style.height = '0';
  prompt.style.height = prompt.scrollHeight + prompt.offsetHeight - prompt.clientHeight + 'px';
}
function closeMenu() {
  if (!menu.hidden) commandButton.focus({ preventScroll: true });
  menu.hidden = true;
  menuMode = '';
  commandButton.setAttribute('aria-expanded', 'false');
}
function renderChoices() {
  const query = menuMode === 'sessions' ? sessionFilter.value.toLowerCase() : '';
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
      form.requestSubmit();
    };
    return button;
  }));
  if (!filtered.length) choices.textContent = menuMode === 'sessions' ? 'No saved sessions match' : 'No remote commands match';
}
async function openMenu(mode) {
  menuMode = mode;
  menu.hidden = false;
  commandButton.setAttribute('aria-expanded', 'true');
  commandButton.focus({ preventScroll: true });
  menuTitle.textContent = mode === 'sessions' ? 'Resume session' : 'Commands';
  sessionFilter.hidden = mode !== 'sessions';
  if (mode === 'sessions') sessionFilter.value = '';
  choices.textContent = 'Loading…';
  selected = 0;
  try {
    const data = await (await request(mode === 'sessions' ? '/sessions' : '/commands')).json();
    if (menuMode !== mode) return;
    items = mode === 'sessions'
      ? data.filter(item => !item.current).map(item => ({ label: item.name,
          description: new Date(item.modified).toLocaleString() + ' · ' + item.messageCount + ' messages · ' + item.id.slice(0, 8),
          value: '/resume ' + item.id }))
      : data.map(item => ({ label: '/' + item.name, description: item.description || '',
          value: '/' + item.name }));
    renderChoices();
  } catch (error) { if (menuMode === mode) choices.textContent = error.message; }
}
prompt.addEventListener('input', resizePrompt);
commandButton.onclick = () => {
  prompt.blur();
  openMenu('commands');
};
document.getElementById('close-menu').onclick = closeMenu;
sessionFilter.oninput = () => { selected = 0; renderChoices(); };
form.addEventListener('keydown', event => {
  if (menu.hidden) return;
  if (event.key === 'Escape') { closeMenu(); event.preventDefault(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || event.shiftKey) return;
  if (event.key === 'Enter' && event.target.tagName === 'BUTTON') return;
  const buttons = choices.querySelectorAll('button');
  if (!buttons.length) return;
  event.preventDefault();
  if (event.key === 'Enter') { buttons[selected].click(); return; }
  selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  renderChoices();
  const button = choices.querySelectorAll('button')[selected];
  button.focus({ preventScroll: true });
  button.scrollIntoView({ block: 'nearest' });
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
  cancelVoice('Disconnected. Voice cancelled');
  workspace = '';
  if (changes.open) clearChanges('Disconnected. Reconnect, then refresh Changes');
  footer.hidden = true;
  if (!recovering) showError(error.message);
  recovering = true;
  version = '';
  status.textContent = accessToken ? 'Reconnecting…' : 'Disconnected. Open the private /remote link';
  delete status.dataset.state;
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
        cancelVoice('Session changed. Voice cancelled');
        workspace = state.workspace || '';
        if (changes.open) refreshChanges();
      }
      if (state.workspace && historyWorkspace !== state.workspace) {
        historyWorkspace = state.workspace;
        expandedResults.clear();
        for (const details of history.querySelectorAll('details.tool-result')) details.open = false;
      }
      if (state.history) {
        // Read open state directly so a toggle just before a poll is retained too
        for (const details of history.querySelectorAll('details.tool-result')) {
          if (details.open) expandedResults.add(details.dataset.messageId);
          else expandedResults.delete(details.dataset.messageId);
        }
        const focusedId = document.activeElement.closest('details.tool-result')?.dataset.messageId;
        let focusTarget;
        const nodes = state.history.map(message => {
          const article = document.createElement('article');
          const role = document.createElement('strong');
          const content = document.createElement('pre');
          role.textContent = message.role;
          content.textContent = message.text;
          if (message.collapsible) {
            const details = document.createElement('details');
            const summary = document.createElement('summary');
            details.className = 'tool-result';
            details.dataset.messageId = message.id;
            details.open = expandedResults.has(message.id);
            summary.append(role);
            details.append(summary, content);
            article.append(details);
            if (message.id === focusedId) focusTarget = summary;
          } else article.append(role, content);
          return article;
        });
        history.replaceChildren(...nodes);
        focusTarget?.focus({ preventScroll: true });
      }
      footer.hidden = !state.footer;
      if (state.footer) {
        footerCwd.textContent = footerCwd.title = state.footer.cwd;
        footerBranch.textContent = footerBranch.title = state.footer.branch || '';
        footerBranch.hidden = !state.footer.branch;
        footerGit.textContent = state.footer.branch ? state.footer.gitStatus : '';
        footerContext.textContent = state.footer.context;
        footerContext.dataset.color = state.footer.contextColor;
        footerModel.textContent = footerModel.title = [state.footer.modelProvider, state.footer.model].filter(Boolean).join(' ');
        footerReasoning.textContent = state.footer.reasoning ? '• ' + state.footer.reasoning : '';
        footerReasoning.hidden = !state.footer.reasoning;
      }
      stream.textContent = state.live ? state.live.text : '';
      live.hidden = !state.live;
      stateName = state.state;
      status.textContent = stateName + (state.pending ? ' (queued prompts)' : '');
      status.dataset.state = stateName;
      version = state.version;
      if (state.leaf) leaf = state.leaf;
      if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
    }
    connected = true;
    controls();
    recovering = false;
    reconnect.hidden = true;
    timer = setTimeout(poll, 700);
  } catch (error) { disconnected(error); }
}
form.onsubmit = async event => {
  event.preventDefault();
  if ((!prompt.value.trim() && !pendingImages.length) || pendingImages.some(image => !image.ready) || submitting || !connected || voice) return;
  const text = prompt.value;
  const value = text.trim();
  const images = pendingImages.slice();
  const command = value.startsWith('/');
  closeMenu();
  if (command && images.length) { showError('Images cannot be attached to slash commands. Remove the images first'); return; }
  if (new TextEncoder().encode(text).length > 64 * 1024) { showError('Text is too large (64 KiB limit)'); return; }
  if (value === '/resume') { await openMenu('sessions'); return; }
  submitting = true;
  controls();
  try {
    const body = { text: command ? value : text, ...(images.length ? { images: await Promise.all(images.map(image => readImage(image.file))) } : {}) };
    await request(command ? '/command' : '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(images.length ? 60000 : 15000) });
    if (prompt.value === text) {
      prompt.value = '';
      resizePrompt();
    }
    images.forEach(removeImage);
  } catch (error) { showError(error.message + (command ? '. Check the current session before trying again' : '')); }
  finally { submitting = false; version = ''; controls(); }
};
stop.onclick = async () => {
  try { await request('/stop', { method: 'POST' }); }
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
