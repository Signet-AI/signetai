import { useEffect, useMemo, useState } from "react";
import "./graph-color-lab.css";
import {
	COLOR_VARIABLES,
	type ColorConfig,
	colorNodes,
	DEFAULT_COLOR_CONFIG,
	parseColorConfig,
	RAMPS,
	rampGradient,
} from "@/lib/graph-color";
import type { SceneNode } from "@/lib/graph-scene";

const CURRENT_KEY = "signet.dev.graphColor";
const PRESETS_KEY = "signet.dev.graphColorPresets";

function readJson(key: string): unknown {
	try {
		return JSON.parse(localStorage.getItem(key) ?? "null");
	} catch {
		return null;
	}
}

function loadCurrent(): { enabled: boolean; config: ColorConfig } {
	const stored = readJson(CURRENT_KEY);
	const record = typeof stored === "object" && stored !== null ? stored : {};
	const enabled = "enabled" in record && record.enabled === true;
	const config = "config" in record ? parseColorConfig(record.config) : null;
	return { enabled, config: config ?? DEFAULT_COLOR_CONFIG };
}

function loadPresets(): Record<string, ColorConfig> {
	const stored = readJson(PRESETS_KEY);
	if (typeof stored !== "object" || stored === null) return {};
	return Object.fromEntries(
		Object.entries(stored).flatMap(([name, value]) => {
			const config = parseColorConfig(value);
			return config ? [[name, config]] : [];
		}),
	);
}

function format(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function GraphColorLab({
	nodes,
	onColors,
}: {
	readonly nodes: readonly SceneNode[];
	readonly onColors: (colors: ReadonlyMap<string, string> | null) => void;
}) {
	const [initial] = useState(loadCurrent);
	const [open, setOpen] = useState(false);
	const [enabled, setEnabled] = useState(initial.enabled);
	const [config, setConfig] = useState<ColorConfig>(initial.config);
	const [presets, setPresets] = useState<Record<string, ColorConfig>>(loadPresets);
	const [name, setName] = useState("");
	const coloring = useMemo(() => colorNodes(nodes, config), [nodes, config]);
	const update = (patch: Partial<ColorConfig>) => setConfig((current) => ({ ...current, ...patch }));

	useEffect(() => {
		onColors(enabled ? coloring.colors : null);
	}, [enabled, coloring, onColors]);

	useEffect(() => {
		localStorage.setItem(CURRENT_KEY, JSON.stringify({ enabled, config }));
	}, [enabled, config]);

	const savePresets = (next: Record<string, ColorConfig>) => {
		setPresets(next);
		localStorage.setItem(PRESETS_KEY, JSON.stringify(next));
	};

	const gradient = useMemo(
		() => rampGradient(config, coloring.min, coloring.max),
		[config, coloring.min, coloring.max],
	);

	return (
		<div className="graph-color-lab" data-open={open}>
			<div className="gcl-head">
				<label className="gcl-row">
					<input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
					<span>Color lab</span>
					<span className="gcl-tag">dev</span>
				</label>
				<button type="button" className="gcl-toggle" onClick={() => setOpen((value) => !value)}>
					{open ? "Hide" : "Edit"}
				</button>
			</div>
			<div className="gcl-bar" style={{ background: gradient }} />
			<div className="gcl-range">
				<span>{format(coloring.min)}</span>
				<span>
					{coloring.valued.toLocaleString()} / {nodes.length.toLocaleString()} valued
				</span>
				<span>{format(coloring.max)}</span>
			</div>
			{open && (
				<div className="gcl-body">
					<label className="gcl-field">
						<span>Variable</span>
						<select
							value={config.variable}
							onChange={(event) => {
								const variable = COLOR_VARIABLES.find((entry) => entry.key === event.target.value);
								if (variable) update({ variable: variable.key });
							}}
						>
							{COLOR_VARIABLES.map((variable) => (
								<option key={variable.key} value={variable.key}>
									{variable.label}
								</option>
							))}
						</select>
					</label>
					<label className="gcl-field">
						<span>Ramp</span>
						<select
							value=""
							onChange={(event) => {
								const stops = RAMPS[event.target.value];
								if (stops) update({ stops });
							}}
						>
							<option value="" disabled>
								Load ramp
							</option>
							{Object.keys(RAMPS).map((ramp) => (
								<option key={ramp} value={ramp}>
									{ramp}
								</option>
							))}
						</select>
					</label>
					<div className="gcl-stops">
						{config.stops.map((stop, index) => (
							<span key={index} className="gcl-stop">
								<input
									type="color"
									value={stop.length === 4 ? `#${[...stop.slice(1)].map((c) => c + c).join("")}` : stop}
									onChange={(event) =>
										update({ stops: config.stops.map((value, at) => (at === index ? event.target.value : value)) })
									}
								/>
								{config.stops.length > 1 && (
									<button
										type="button"
										aria-label="Remove stop"
										onClick={() => update({ stops: config.stops.filter((_, at) => at !== index) })}
									>
										×
									</button>
								)}
							</span>
						))}
						<button
							type="button"
							className="gcl-add"
							onClick={() => update({ stops: [...config.stops, config.stops.at(-1) ?? "#ffffff"] })}
						>
							+
						</button>
					</div>
					<label className="gcl-field">
						<span>Blend</span>
						<select
							value={config.interpolation}
							onChange={(event) => update({ interpolation: event.target.value === "rgb" ? "rgb" : "oklab" })}
						>
							<option value="oklab">OKLab</option>
							<option value="rgb">sRGB</option>
						</select>
					</label>
					<label className="gcl-field">
						<span>Bands {config.bands < 2 ? "smooth" : config.bands}</span>
						<input
							type="range"
							min={0}
							max={16}
							value={config.bands}
							onChange={(event) => update({ bands: Number(event.target.value) })}
						/>
					</label>
					<label className="gcl-field">
						<span>Gamma {config.gamma.toFixed(2)}</span>
						<input
							type="range"
							min={0.2}
							max={4}
							step={0.05}
							value={config.gamma}
							onChange={(event) => update({ gamma: Number(event.target.value) })}
						/>
					</label>
					<label className="gcl-row">
						<input
							type="checkbox"
							checked={config.reverse}
							onChange={(event) => update({ reverse: event.target.checked })}
						/>
						Reverse
					</label>
					<label className="gcl-row">
						<input type="checkbox" checked={config.log} onChange={(event) => update({ log: event.target.checked })} />
						Log scale
					</label>
					<label className="gcl-row">
						<input type="checkbox" checked={config.auto} onChange={(event) => update({ auto: event.target.checked })} />
						Auto range
					</label>
					{!config.auto && (
						<div className="gcl-pair">
							<input
								type="number"
								step={0.05}
								value={config.min}
								aria-label="Minimum"
								onChange={(event) => update({ min: Number(event.target.value) })}
							/>
							<input
								type="number"
								step={0.05}
								value={config.max}
								aria-label="Maximum"
								onChange={(event) => update({ max: Number(event.target.value) })}
							/>
						</div>
					)}
					<label className="gcl-row">
						<input
							type="checkbox"
							checked={config.inherit}
							onChange={(event) => update({ inherit: event.target.checked })}
						/>
						Unvalued nodes take their cluster's mean
					</label>
					<label className="gcl-row">
						<input type="color" value={config.missing} onChange={(event) => update({ missing: event.target.value })} />
						No value
					</label>
					<div className="gcl-presets">
						<div className="gcl-pair">
							<input
								type="text"
								placeholder="Preset name"
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
							<button
								type="button"
								disabled={!name.trim()}
								onClick={() => savePresets({ ...presets, [name.trim()]: config })}
							>
								Save
							</button>
						</div>
						{Object.entries(presets).map(([preset, saved]) => (
							<div key={preset} className="gcl-preset">
								<button
									type="button"
									onClick={() => {
										setConfig(saved);
										setName(preset);
									}}
								>
									{preset}
								</button>
								<button
									type="button"
									aria-label={`Delete ${preset}`}
									onClick={() =>
										savePresets(Object.fromEntries(Object.entries(presets).filter(([key]) => key !== preset)))
									}
								>
									×
								</button>
							</div>
						))}
						<button type="button" onClick={() => void navigator.clipboard.writeText(JSON.stringify(config, null, 2))}>
							Copy JSON
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
