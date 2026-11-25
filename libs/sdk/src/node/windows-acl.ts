import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { attempt } from "@signet/core/attempt";

export class UnsafeAclError extends Error {}
const cache = new Map<string, string>();
async function fingerprint(path: string): Promise<string> {
	const info = await stat(path);
	return `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}:${info.size}`;
}
export function invalidatePrivate(path: string): void {
	cache.delete(`0:${path}`);
	cache.delete(`1:${path}`);
}
export async function rememberDirectoryMutation(path: string): Promise<void> {
	invalidatePrivate(path);
}
const operation =
	"$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $item=Get-Item -LiteralPath $v.path -Force -ErrorAction Stop; if(($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and -not $v.allowSymlink){throw 'unsafe_acl'}; if($v.write){if($v.directory){$acl=[System.Security.AccessControl.DirectorySecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')}else{$acl=[System.Security.AccessControl.FileSecurity]::new(); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')}; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $v.path -AclObject $acl -ErrorAction Stop}; $p=$item.FullName; for($i=0;$item.LinkType -and $i -lt 32;$i++){$p=$item.Target[0]; if(-not [System.IO.Path]::IsPathRooted($p)){$p=Join-Path $item.DirectoryName $p}; $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop}; if($item.LinkType){throw 'unsafe_acl'}; $acl=Get-Acl -LiteralPath $p -ErrorAction Stop; if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'unsafe_acl'}; foreach($r in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -ne $sid.Value){throw 'unsafe_acl'}}; if($v.directory -and -not $acl.AreAccessRulesProtected){throw 'unsafe_acl'}";
const script = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); while($null -ne ($line=[Console]::ReadLine())){$v=$null; try{$v=$line|ConvertFrom-Json; ${operation}; $r=@{id=$v.id;ok=$true}}catch{$r=@{id=$v.id;ok=$false;code=if($_.Exception.Message -eq 'unsafe_acl'){'unsafe_acl'}else{'helper_error'}}}; [Console]::WriteLine(($r|ConvertTo-Json -Compress))}`;
interface Pending {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}
function reference(value: unknown, active: boolean): void {
	if (typeof value !== "object" || value === null) return;
	if (active && "ref" in value && typeof value.ref === "function") value.ref();
	if (!active && "unref" in value && typeof value.unref === "function") value.unref();
}
class AclWorker {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<number, Pending>();
	private sequence = 0;
	private output = "";
	private stderrBytes = 0;
	private closed = false;
	private idle?: ReturnType<typeof setTimeout>;
	constructor() {
		this.child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (data: string) => this.receive(data));
		this.child.stderr.on("data", (data: Buffer) => {
			this.stderrBytes += data.length;
			if (this.stderrBytes > 4096) this.close();
		});
		this.child.on("error", () => this.close());
		this.child.on("exit", () => this.close());
		this.child.stdin.on("error", () => this.close());
	}
	private receive(data: string): void {
		this.output += data;
		if (this.output.length > 4096) {
			this.close();
			return;
		}
		let end: number;
		while ((end = this.output.indexOf("\n")) >= 0) {
			const value: unknown = attempt(() => JSON.parse(this.output.slice(0, end)));
			this.output = this.output.slice(end + 1);
			if (
				typeof value !== "object" ||
				value === null ||
				!("id" in value) ||
				typeof value.id !== "number" ||
				!("ok" in value) ||
				typeof value.ok !== "boolean"
			) {
				this.close();
				return;
			}
			const pending = this.pending.get(value.id);
			if (!pending) {
				this.close();
				return;
			}
			clearTimeout(pending.timer);
			this.pending.delete(value.id);
			if (value.ok) pending.resolve();
			else
				pending.reject(
					"code" in value && value.code === "unsafe_acl"
						? new UnsafeAclError("Unsafe permissions")
						: new Error("Signet ACL helper failed"),
				);
		}
		if (!this.pending.size) {
			for (const stream of [this.child, this.child.stdout, this.child.stderr, this.child.stdin])
				reference(stream, false);
			this.idle = setTimeout(() => this.close(), 1000);
			this.idle.unref();
		}
	}
	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (worker === this) worker = undefined;
		clearTimeout(this.idle);
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Signet ACL helper unavailable or timed out"));
		}
		this.pending.clear();
		this.child.stdin.destroy();
		this.child.stdout.destroy();
		this.child.stderr.destroy();
		this.child.kill();
	}
	request(input: { path: string; directory: boolean; write: boolean; allowSymlink: boolean }): Promise<void> {
		if (this.closed || this.pending.size >= 16 || input.path.length > 32768)
			return Promise.reject(new Error("Signet ACL helper admission limit"));
		clearTimeout(this.idle);
		for (const stream of [this.child, this.child.stdout, this.child.stderr, this.child.stdin]) reference(stream, true);
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.close(), 1000);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ ...input, id })}\n`);
		});
	}
}
let worker: AclWorker | undefined;
async function verify(path: string, directory: boolean, write: boolean, allowSymlink: boolean): Promise<void> {
	worker ??= new AclWorker();
	await worker.request({ path, directory, write, allowSymlink });
}
export async function windowsAcl(
	path: string,
	directory: boolean,
	write: boolean,
	allowSymlink = false,
): Promise<void> {
	const key = `${allowSymlink ? 1 : 0}:${path}`;
	let before = await fingerprint(path);
	if (cache.get(key) === before) return;
	if (write) {
		await verify(path, directory, true, allowSymlink);
		before = await fingerprint(path);
	}
	await verify(path, directory, false, allowSymlink);
	if (before !== (await fingerprint(path))) throw new Error("Private state changed during ACL verification");
	cache.set(key, before);
	if (cache.size > 512) {
		const first = cache.keys().next().value;
		if (first !== undefined) cache.delete(first);
	}
}
