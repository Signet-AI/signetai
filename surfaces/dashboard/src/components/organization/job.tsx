import { useEffect, useState } from "react";
import { getJSONResult } from "@/lib/api";
import { type OrganizationJob, terminalJob } from "@/lib/organization";
import { Action, Message, OrganizationBlock } from "./controls";

export function TrackedJob({ id, onComplete }: { id: string; onComplete?: () => void }) {
	const [job, setJob] = useState<OrganizationJob | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let alive = true;
		let polls = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const poll = async () => {
			const result = await getJSONResult<OrganizationJob>(`/api/org/jobs/${encodeURIComponent(id)}`, {
				signal: controller.signal,
			});
			if (!alive) return;
			setError(result.error ? `${result.error} (status attempt ${attempt + 1})` : null);
			if (!result.data) return;
			polls++;
			if (polls >= 400 && !terminalJob(result.data.status)) {
				setError("Tracking paused after ten minutes. The job may still be running. Retry to check its durable status.");
				setJob(result.data);
				return;
			}
			setJob(result.data);
			if (result.data.status === "complete") onComplete?.();
			if (!terminalJob(result.data.status)) timer = setTimeout(() => void poll(), 1500);
		};
		void poll();
		return () => {
			alive = false;
			controller.abort();
			if (timer) clearTimeout(timer);
		};
	}, [id, attempt, onComplete]);
	return (
		<OrganizationBlock title="Tracked job">
			<p role="status">{job ? `Job ${id}: ${job.status}` : `Checking job ${id}…`}</p>
			{job?.progress_json && (
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-small">
					{job.progress_json}
				</pre>
			)}
			<Message error={error ?? job?.error ?? null} />
			{error && (
				<Action secondary onClick={() => setAttempt((value) => value + 1)}>
					Retry job status
				</Action>
			)}
		</OrganizationBlock>
	);
}
