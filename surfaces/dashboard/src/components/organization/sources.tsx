import { HomeSourceRow } from "@/components/home/sources";
import type { SignetSource } from "@/lib/api";
import { OrganizationResource } from "@/views/organization";
import { OrganizationBlock } from "./controls";

export function OrganizationSources() {
	return (
		<OrganizationBlock title="Sources">
			<OrganizationResource<{ sources: readonly SignetSource[] }>
				path="/api/sources"
				empty={(data) => !data.sources.length}
			>
				{(data, refresh) => (
					<div className="divide-y">
						{data.sources.map((source) => (
							<HomeSourceRow key={source.id} source={source} onMutate={refresh} />
						))}
					</div>
				)}
			</OrganizationResource>
		</OrganizationBlock>
	);
}
