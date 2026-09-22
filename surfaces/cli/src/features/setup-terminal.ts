export interface SetupSpinner {
	readonly isSpinning: boolean;
	stop(): SetupSpinner;
	start(text?: string): SetupSpinner;
}
export async function withSetupPrompt<T>(spinner: SetupSpinner, prompt: () => Promise<T>): Promise<T> {
	const wasSpinning = spinner.isSpinning;
	if (wasSpinning) {
		spinner.stop();
	}

	try {
		return await prompt();
	} finally {
		if (wasSpinning) {
			spinner.start();
		}
	}
}
