import { AsyncLocalStorage } from "node:async_hooks";

export interface WritePrincipal {
	readonly userId: string | null;
}
interface WriteContext {
	readonly principal: WritePrincipal;
	denied: boolean;
}
const writes = new AsyncLocalStorage<WriteContext | undefined>();
export function withWritePrincipal<T>(principal: WritePrincipal | undefined, operation: () => T): T {
	if (principal && principal.userId !== null && (typeof principal.userId !== "string" || !principal.userId))
		throw new Error("principal_required");
	return writes.run(principal ? { principal, denied: false } : undefined, operation);
}
export function currentWritePrincipal(): WritePrincipal | undefined {
	return writes.getStore()?.principal;
}
export function classifiedDestinationDenied(): boolean {
	return writes.getStore()?.denied ?? false;
}
export function recordClassifiedDestination(error: unknown): void {
	if (typeof error !== "object" || error === null || Reflect.get(error, "code") !== "classified_destination") return;
	const context = writes.getStore();
	if (context) context.denied = true;
}
export class ClassifiedDestinationError extends Error {
	readonly code = "classified_destination";
	constructor() {
		super("classified destination");
		this.name = "ClassifiedDestinationError";
		recordClassifiedDestination(this);
	}
}
