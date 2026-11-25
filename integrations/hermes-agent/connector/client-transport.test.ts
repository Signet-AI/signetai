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
