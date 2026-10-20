const launchButton = document.querySelector('#launch-button');
const downloadButton = document.querySelector('#download-button');
const dialog = document.querySelector('#workspace-dialog');
const closeDialog = document.querySelector('#close-dialog');
const continueButton = document.querySelector('#continue-button');
const message = document.querySelector('#launch-status');
const toast = document.querySelector('#toast');
let session;
let activeLaunch;
let polling;
let busy = false;
let toastTimer;

function notify(text) { toast.textContent = text; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 6000); }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrf || '', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function render(launch) {
  activeLaunch = launch;
  const labels = { creating: 'Creating your workspace and agent identity…', bootstrapping: 'Starting the workspace and verifying the agent private key…', authenticating: 'Approving workspace access and authenticating the agent…', ready: 'Your workspace is running and its agent identity is ready.', failed: launch.error || 'Workspace launch failed.', deleted: 'This workspace was deleted. You can launch a new one.' };
  message.textContent = labels[launch.state] || 'Waiting for the workspace…';
  continueButton.hidden = launch.state !== 'ready'; continueButton.disabled = launch.state !== 'ready';
  if (['ready', 'failed', 'deleted'].includes(launch.state)) {
    clearTimeout(polling); busy = false; launchButton.disabled = false;
    sessionStorage.removeItem('launch-request');
    return;
  }
  polling = setTimeout(async () => {
    try { render(await api(`/api/launch/${launch.id}`)); }
    catch (error) { message.textContent = error.message; polling = setTimeout(() => render(launch), 5000); }
  }, 2000);
}
async function launch() {
  if (busy) { dialog.showModal(); return; }
  try {
    session = await api('/api/session');
    if (!session.authenticated) { sessionStorage.setItem('launch-after-login', '1'); location.assign('/auth/login'); return; }
    busy = true; launchButton.disabled = true; dialog.showModal(); continueButton.hidden = true;
    message.textContent = 'Preparing your Identity workspace…';
    let requestId = sessionStorage.getItem('launch-request');
    if (!requestId) { requestId = crypto.randomUUID(); sessionStorage.setItem('launch-request', requestId); }
    render(await api('/api/launch', { method: 'POST', body: JSON.stringify({ requestId }) }));
  } catch (error) { busy = false; launchButton.disabled = false; message.textContent = error.message; notify(error.message); }
}
launchButton.addEventListener('click', launch);
closeDialog.addEventListener('click', () => dialog.close());
continueButton.addEventListener('click', () => { if (activeLaunch?.state === 'ready') location.assign(activeLaunch.workspaceURL); });
downloadButton.addEventListener('click', () => { location.assign('/identity-cli.mjs'); });
dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });

api('/api/session').then(data => {
  session = data;
  document.querySelector('#identity-status').textContent = data.authenticated ? 'Signed in to Identity' : 'Sign in to launch';
  document.querySelector('#active-context').textContent = 'Identity Workspace';
  document.querySelector('#sync-status').textContent = 'Connected to launcher';
  document.querySelector('#auth-status').textContent = data.authenticated ? 'authenticated' : 'sign-in required';
  if (data.authenticated && sessionStorage.getItem('launch-after-login')) { sessionStorage.removeItem('launch-after-login'); launch(); }
  else if (data.authenticated) {
    const pending = data.launches.find(item => !['ready', 'failed', 'deleted'].includes(item.state));
    if (pending) { busy = true; launchButton.disabled = true; dialog.showModal(); render(pending); }
  }
}).catch(() => { document.querySelector('#identity-status').textContent = 'Launcher unavailable'; });
