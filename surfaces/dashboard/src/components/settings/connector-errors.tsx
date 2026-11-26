import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/shell/panel";
import { usePanelQuery } from "@/lib/use-panel-query";

export function ConnectorErrors({ keyId }: { readonly keyId: string }) {
	const [open, setOpen] = useState(false);
	const { result, refresh } = usePanelQuery<{ errors: readonly { at: string; status: number; reason: string }[] }>(
		open ? `/api/auth/connector-keys/${encodeURIComponent(keyId)}/errors` : null,
	);
	return (
		<div className="flex w-full flex-col gap-3">
			<Button size="sm" variant="ghost" className="self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
				{open ? "Hide recent errors" : "Recent errors"}
			</Button>
			{open && (
				<Panel
					result={result}
					empty={result?.data?.errors.length === 0}
					emptyMessage="No connector errors in the past seven days."
					onRetry={refresh}
				>
					{({ errors }) => (
						<ul className="m-0 list-none divide-y p-0">
							{errors.map((error) => (
								<li key={`${error.at}:${error.status}:${error.reason}`} className="py-2 text-small">
									<time dateTime={error.at}>{new Date(error.at).toLocaleString()}</time>
									<span>
										{" "}
										· HTTP {error.status} · {error.reason}
									</span>
								</li>
							))}
						</ul>
					)}
				</Panel>
			)}
		</div>
	);
}
