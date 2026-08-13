export interface SingleInstanceHost {
	requestSingleInstanceLock(): boolean;
	quit(): void;
	onSecondInstance(listener: () => void): void;
}

export function installSingleInstanceLock(host: SingleInstanceHost, onSecondInstance: () => void): boolean {
	if (!host.requestSingleInstanceLock()) {
		host.quit();
		return false;
	}

	host.onSecondInstance(onSecondInstance);
	return true;
}
