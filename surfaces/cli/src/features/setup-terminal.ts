export interface SetupSpinner {
	readonly isSpinning: boolean;
	stop(): SetupSpinner;
	start(text?: string): SetupSpinner;
}

/** Run an interactive prompt without allowing spinner frames to redraw over it. */
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
