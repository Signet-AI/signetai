export function workspaceHtml(): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signet workspaces</title>
<style>
:root{color-scheme:dark;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#0f0f0f;color:#eee}body{margin:0;padding:56px 32px}main{max-width:640px;margin:auto}h1{font-size:24px;letter-spacing:-.04em}p{color:#bbb;line-height:1.7}fieldset{border:1px solid #333;padding:24px;margin:24px 0}label{display:block;margin:12px 0}input[type=url]{box-sizing:border-box;width:100%;background:#171717;color:inherit;border:1px solid #444;padding:12px;font:inherit}button{padding:10px 14px;font:inherit;border:1px solid #555;background:#222;color:inherit;cursor:pointer;margin:8px 8px 0 0}button:disabled{opacity:.45;cursor:default}#code{font-size:24px;letter-spacing:.15em}output{display:block;padding:16px 0;line-height:1.6}small{color:#aaa}a{color:inherit}
</style></head><body><main><small>SIGNET / WORKSPACES</small><h1>Your memory, where you work.</h1><p>Keep your personal workspace local, or connect to your organization's instance.</p>
<fieldset><legend>Workspace</legend><label><input type="radio" name="mode" value="local" checked> Local — personal workspace</label><label><input type="radio" name="mode" value="organization"> Organization — remote instance</label><label for="origin">Instance URL</label><input id="origin" type="url" placeholder="https://signet.example.com" autocomplete="url"><button id="switch">Use workspace</button><p>Switching reopens the app. Organization mode never starts a local daemon.</p></fieldset>
<section id="account" hidden><h2>Organization session</h2><output id="status" aria-live="polite">Checking session…</output><div id="code"></div><button id="signin">Sign in through your browser</button><button id="signout">Sign out</button><button id="dashboard">Open organization dashboard</button><p>Your CLI and desktop share this login. Signing out removes it for both.</p></section><output id="error" role="alert"></output>
<script>
const api=window.signetDesktop;const $=id=>document.getElementById(id);let remote=false;let busy=false;
async function act(fn){try{$('error').textContent='';return await fn()}catch(error){$('error').textContent=String(error);return null}}
function render(status){$('status').textContent=status.message;$('status').dataset.state=status.state;$('dashboard').disabled=status.state!=='signed-in';$('signin').disabled=status.state==='pending';$('signout').disabled=status.state==='signed-out'}
async function refresh(){if(!remote||busy)return;busy=true;try{await act(async()=>render(await api.workspaceStatus()))}finally{busy=false}}
$('switch').onclick=()=>act(()=>api.selectWorkspace({mode:document.querySelector('input[name=mode]:checked').value,origin:$('origin').value}));
$('signin').onclick=()=>act(async()=>{const flow=await api.signIn();$('code').textContent=flow.userCode;render(flow.status)});
$('signout').onclick=()=>act(async()=>{render(await api.signOut());$('code').textContent=''});
$('dashboard').onclick=()=>api.openDashboard();
act(async()=>{const selection=await api.getWorkspace();remote=selection.mode==='organization';document.querySelector('input[value='+selection.mode+']').checked=true;$('origin').value=selection.origin||'';$('account').hidden=!remote;await refresh()});
setInterval(refresh,2500);
</script></main></body></html>`;
}
