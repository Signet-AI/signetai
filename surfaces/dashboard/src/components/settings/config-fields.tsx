import { Switch } from "@/components/ui/switch";
import type { AgentConfigStore } from "@/lib/agent-config";
import { SettingNumber, SettingRow } from "./controls";

type ConfigField = {
	path: readonly string[];
	title: string;
	desc: string;
} & (
	| { kind: "toggle"; fallback?: boolean; writeForm?: readonly string[] }
	| { kind: "number"; min: number; max: number; step?: number }
);

export function ConfigFields({ store, fields }: { store: AgentConfigStore; fields: readonly ConfigField[] }) {
	return fields.map((field) => (
		<SettingRow key={field.path.join(".")} title={field.title} desc={field.desc}>
			{field.kind === "toggle" ? (
				<Switch
					checked={store.aBool(field.path, field.fallback ?? false)}
					onCheckedChange={(value) => {
						store.aSetBool(field.writeForm ?? field.path, value);
						void store.save();
					}}
				/>
			) : (
				<SettingNumber
					value={store.aStr(field.path)}
					min={field.min}
					max={field.max}
					step={field.step}
					onCommit={(value) => {
						store.aSetNum(field.path, value);
						void store.save();
					}}
				/>
			)}
		</SettingRow>
	));
}
