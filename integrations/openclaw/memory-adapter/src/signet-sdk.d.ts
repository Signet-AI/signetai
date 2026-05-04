declare module "@signet/sdk" {
	export interface SignetClientConfig {
		readonly daemonUrl?: string;
		readonly timeoutMs?: number;
		readonly retries?: number;
	}

	export class SignetClient {
		constructor(config?: SignetClientConfig);
		sessionEndFireAndForget(opts: {
			readonly sessionKey?: string;
			readonly summary?: string;
			readonly project?: string;
			readonly harness?: string;
			readonly agentId?: string;
			readonly transcriptPath?: string;
			readonly transcript?: string;
			readonly sessionId?: string;
			readonly cwd?: string;
			readonly reason?: string;
			readonly runtimePath?: string;
		}): void;
	}
}
