export interface SingleInstanceHost {
	requestSingleInstanceLock(): boolean;
	quit(): void;
	onSecondInstance(listener: (commandLine: readonly string[]) => void): void;
}

export function installSingleInstanceLock(
	host: SingleInstanceHost,
	onSecondInstance: (commandLine: readonly string[]) => void,
): boolean {
	if (!host.requestSingleInstanceLock()) {
		host.quit();
		return false;
	}

	host.onSecondInstance(onSecondInstance);
	return true;
}
