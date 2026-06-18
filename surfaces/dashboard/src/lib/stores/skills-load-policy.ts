export function shouldPreserveCatalogOnEmptyRefresh(nextResultsLength: number, currentCatalogLength: number): boolean {
	return nextResultsLength === 0 && currentCatalogLength > 0;
}
