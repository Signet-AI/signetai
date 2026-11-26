import "../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { join } from "node:path";

test("Hermes client uses registry credentials and durably queues rejected evidence", async () => {
	const child = Bun.spawn(
		[
			"python",
			"-c",
			`
import http.server, threading, tempfile, pathlib, os
from signet_transport import ConnectorRegistry, write_key_file, DurableOutbox
from client import SignetClient
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  assert self.headers.get('Authorization') == 'Bearer private-key'
  assert self.headers.get('x-signet-actor') is None
  self.send_response(401); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"error":"expired","reason":"expired"}')
 def log_message(self, *args): pass
server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
url = 'http://127.0.0.1:%s' % server.server_port
with tempfile.TemporaryDirectory() as home:
 env = {'HOME':home}
 path = write_key_file(url,'hermes-agent','private-key',env=env)
 ConnectorRegistry(env=env).set('hermes-agent',{'url':url,'keyFile':str(path),'agentId':'alice'})
 os.environ['HOME'] = home
 os.environ['SIGNET_DAEMON_URL'] = 'http://127.0.0.1:1'
 os.environ['SIGNET_TOKEN'] = 'wrong-process-global-key'
 os.environ['SIGNET_API_KEY'] = 'wrong-process-global-key'
 client = SignetClient()
 assert client.base_url == url
 os.environ['SIGNET_DAEMON_URL'] = 'http://127.0.0.1:1'
 client.session_end('conversation', transcript='preserved evidence')
 assert DurableOutbox(url,env=env,harness='hermes-agent').status()['pending'] == 1
server.shutdown()
`,
		],
		{ cwd: join(import.meta.dir, "hermes-plugin"), stdout: "pipe", stderr: "pipe" },
	);
	const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ exit: await child.exited, output, error }).toMatchObject({ exit: 0, output: "" });
});

test("Hermes profiles keep targets, agents, credentials and pending evidence separate", async () => {
	const child = Bun.spawn(
		[
			"python",
			"-c",
			`
import hashlib, http.server, threading, tempfile, pathlib, os
from signet_transport import ConnectorRegistry, write_key_file, DurableOutbox
from client import SignetClient
class Handler(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  if self.headers.get('Authorization') != 'Bearer ' + self.server.token:
   self.send_response(403); self.end_headers(); return
  self.server.calls += 1
  self.send_response(401); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(b'{"reason":"expired"}')
 def log_message(self, *args): pass
servers = []
with tempfile.TemporaryDirectory() as home:
 clients = []
 for name, agent in [('work','alice'),('personal','bob')]:
  server = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
  server.token = name + '-private-key'; server.calls = 0
  servers.append(server)
  threading.Thread(target=server.serve_forever,daemon=True).start()
  profile = os.path.join(home,'.hermes','profiles',name)
  registry_key = 'hermes-agent.' + hashlib.sha256(os.path.abspath(profile).encode()).hexdigest()[:16]
  env = {'HOME':home,'HERMES_HOME':profile}
  url = 'http://127.0.0.1:%s' % server.server_port
  key = write_key_file(url,registry_key,server.token,env=env)
  ConnectorRegistry(env=env).set(registry_key,{'url':url,'keyFile':str(key),'agentId':agent})
  client = SignetClient(env=env)
  assert client.base_url == url and client.agent_id == agent
  clients.append((client,registry_key,url,env))
 os.environ['HERMES_HOME'] = os.path.join(home,'wrong-profile')
 os.environ['SIGNET_DAEMON_URL'] = 'http://127.0.0.1:1'
 for client, registry_key, url, env in clients:
  client.session_end('same-session-id',transcript='profile-owned evidence')
  assert DurableOutbox(url,env=env,harness=registry_key).status()['pending'] == 1
 assert [server.calls for server in servers] == [1,1]
for server in servers: server.shutdown()
`,
		],
		{ cwd: join(import.meta.dir, "hermes-plugin"), stdout: "pipe", stderr: "pipe" },
	);
	const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ exit: await child.exited, output, error }).toMatchObject({ exit: 0, output: "" });
});

test("bundled Python SDK regression suite including shared upload resume", async () => {
	const child = Bun.spawn(["python", "-m", "unittest", "-q", "test_signet_transport"], {
		cwd: join(import.meta.dir, "hermes-plugin"),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	expect({ exit: await child.exited, output, error }).toMatchObject({ exit: 0 });
	console.log(
		(output + error)
			.split("\n")
			.filter((line) => /^python:|^Ran \d+ tests|^OK$/.test(line))
			.join("\n"),
	);
}, 120000);
