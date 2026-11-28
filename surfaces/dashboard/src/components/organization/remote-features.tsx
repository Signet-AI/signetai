export interface RemoteHostFeatures {
	readonly features: readonly { readonly name: string; readonly allowed: boolean }[];
}
export function RemoteHostFeaturesContent({ features }: RemoteHostFeatures) {
	return (
		<section className="flex flex-col gap-3" aria-labelledby="host-features-title">
			<h2 id="host-features-title" className="font-medium">
				Server tasks
			</h2>
			<p className="text-sm text-muted-foreground">
				Changed on the server with <code>signet org remote-features allow|deny &lt;feature&gt;</code>. This view is
				read-only.
			</p>
			<dl className="flex flex-col gap-2">
				{features.map(({ name, allowed }) => (
					<div key={name} className="flex flex-wrap justify-between gap-2 text-sm">
						<dt>
							<code>{name}</code>
						</dt>
						<dd>{allowed ? "Allowed remotely" : "Server only"}</dd>
					</div>
				))}
			</dl>
			<p className="text-sm text-muted-foreground">
				Arbitrary commands, server-path imports, and transcript-path reads remain server only.
			</p>
		</section>
	);
}
