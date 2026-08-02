import {
	AlertTriangle,
	BarChart3,
	Box,
	Camera,
	Circle,
	Code,
	Cpu,
	Database,
	GitBranch,
	HardDrive,
	Image,
	Network,
	Pause,
	Terminal,
	Trash2,
} from "lucide-react";
import { Activity } from "react";
import { BufferPanel } from "./components/BufferPanel";
import { CapturePanel } from "./components/CapturePanel";
import { CommandPanel } from "./components/CommandPanel";
import { DevicePanel } from "./components/DevicePanel";
import { ErrorPanel } from "./components/ErrorPanel";
import { FramePanel } from "./components/FramePanel";
import { MemoryPanel } from "./components/MemoryPanel";
import { RelationsPanel } from "./components/RelationsPanel";
import { ResourcePanel } from "./components/ResourcePanel";
import { ShaderPanel } from "./components/ShaderPanel";
import { TexturePanel } from "./components/TexturePanel";
import { useDevToolsConnection } from "./hooks/useDevToolsConnection";
import { usePersistedState } from "./hooks/usePersistedState";

type Section =
	| "device"
	| "capture"
	| "resources"
	| "buffers"
	| "textures"
	| "pipelines"
	| "shaders"
	| "commands"
	| "frames"
	| "memory"
	| "relations"
	| "errors";

const NAV_ITEMS: {
	id: Section;
	label: string;
	icon: React.ComponentType<{ size?: number }>;
	badge?: (state: ReturnType<typeof useDevToolsConnection>["state"]) => number;
	badgeColor?: string;
}[] = [
	{ id: "device", label: "Device", icon: Cpu },
	{
		id: "capture",
		label: "Capture",
		icon: Camera,
		badge: (s) => s.captures.length,
	},
	{
		id: "resources",
		label: "Resources",
		icon: Database,
		badge: (s) => s.resources.length,
	},
	{
		id: "buffers",
		label: "Buffers",
		icon: Box,
		badge: (s) => s.resources.filter((r) => r.type === "GPUBuffer").length,
	},
	{
		id: "textures",
		label: "Textures",
		icon: Image,
		badge: (s) => s.resources.filter((r) => r.type === "GPUTexture").length,
	},
	{
		id: "pipelines",
		label: "Pipelines",
		icon: GitBranch,
		badge: (s) =>
			s.resources.filter(
				(r) =>
					r.type === "GPURenderPipeline" || r.type === "GPUComputePipeline",
			).length,
	},
	{
		id: "shaders",
		label: "Shaders",
		icon: Code,
		badge: (s) =>
			s.resources.filter((r) => r.type === "GPUShaderModule").length,
	},
	{
		id: "commands",
		label: "Commands",
		icon: Terminal,
		badge: (s) => s.commands.length,
	},
	{
		id: "frames",
		label: "Frames",
		icon: BarChart3,
		badge: (s) => s.frames.length,
	},
	{
		id: "memory",
		label: "Memory",
		icon: HardDrive,
		badge: (s) => s.memorySnapshots.length,
	},
	{
		id: "relations",
		label: "Relations",
		icon: Network,
		badge: (s) =>
			s.resources.filter((r) => r.relations && r.relations.length > 0).length,
	},
	{
		id: "errors",
		label: "Errors",
		icon: AlertTriangle,
		badge: (s) => s.errors.length,
		badgeColor: "bg-red-500",
	},
];

export function App() {
	const {
		state,
		isConnected,
		isRecording,
		settings,
		captureSettings,
		toggleRecording,
		clearState,
		updateSettings,
		updateCaptureSettings,
		clearCaptures,
		isCapturePaused,
		toggleCapturePaused,
		requestBufferData,
		requestTextureData,
	} = useDevToolsConnection();
	const [activeSection, setActiveSection] = usePersistedState<Section>(
		"activeSection",
		"device",
	);

	return (
		<div className="flex h-screen">
			{/* Sidebar */}
			<div className="flex w-48 shrink-0 flex-col border-r border-border bg-surface">
				{/* Toolbar */}
				<div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
					<button
						type="button"
						onClick={toggleRecording}
						className={`rounded p-1 ${isRecording ? "text-red-500 hover:bg-red-500/10" : "text-muted hover:bg-surface-hover"}`}
						title={isRecording ? "Pause recording" : "Resume recording"}
					>
						{isRecording ? (
							<Circle size={14} fill="currentColor" />
						) : (
							<Pause size={14} />
						)}
					</button>
					<button
						type="button"
						onClick={clearState}
						className="rounded p-1 text-muted hover:bg-surface-hover hover:text-foreground"
						title="Clear"
					>
						<Trash2 size={14} />
					</button>
					<div className="ml-auto">
						<span
							className={`inline-block h-2 w-2 rounded-full ${isConnected ? "bg-emerald-500" : "bg-muted-foreground"}`}
							title={isConnected ? "Connected" : "Disconnected"}
						/>
					</div>
				</div>

				{/* Navigation */}
				<nav className="flex-1 overflow-y-auto py-1">
					{NAV_ITEMS.map((item) => {
						const count = item.badge?.(state) ?? 0;
						const isActive = activeSection === item.id;
						return (
							<button
								type="button"
								key={item.id}
								onClick={() => setActiveSection(item.id)}
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
									isActive
										? "bg-blue-600/20 text-blue-400"
										: "text-muted hover:bg-surface-hover hover:text-foreground"
								}`}
							>
								<item.icon size={14} />
								<span className="flex-1">{item.label}</span>
								{count > 0 && (
									<span
										className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${
											item.badgeColor ?? "bg-surface-active text-foreground"
										} ${item.badgeColor ? "text-white" : ""}`}
									>
										{count > 999 ? "999+" : count}
									</span>
								)}
							</button>
						);
					})}
				</nav>

				{/* Settings */}
				<div className="border-t border-border px-3 py-2">
					<label className="flex items-center gap-2 text-[10px] text-muted">
						<input
							type="checkbox"
							checked={settings.preserveOnReload}
							onChange={(e) =>
								updateSettings({ preserveOnReload: e.target.checked })
							}
							className="accent-accent"
						/>
						Preserve on reload
					</label>
					<label className="mt-1 flex items-center gap-2 text-[10px] text-muted">
						<input
							type="checkbox"
							checked={settings.injectCopySrc}
							onChange={(e) =>
								updateSettings({ injectCopySrc: e.target.checked })
							}
							className="accent-accent"
						/>
						Inject COPY_SRC
					</label>
				</div>
			</div>

			{/* Main content */}
			<div className="flex-1 overflow-hidden">
				<Activity mode={activeSection === "device" ? "visible" : "hidden"}>
					<DevicePanel devices={state.devices} />
				</Activity>
				<Activity mode={activeSection === "capture" ? "visible" : "hidden"}>
					<CapturePanel
						captures={state.captures}
						captureSettings={captureSettings}
						isPaused={isCapturePaused}
						onTogglePause={toggleCapturePaused}
						onUpdateSettings={updateCaptureSettings}
						onClear={clearCaptures}
					/>
				</Activity>
				<Activity mode={activeSection === "resources" ? "visible" : "hidden"}>
					<ResourcePanel resources={state.resources} />
				</Activity>
				<Activity mode={activeSection === "buffers" ? "visible" : "hidden"}>
					<BufferPanel
						buffers={state.resources.filter((r) => r.type === "GPUBuffer")}
						onRequestData={requestBufferData}
					/>
				</Activity>
				<Activity mode={activeSection === "textures" ? "visible" : "hidden"}>
					<TexturePanel
						textures={state.resources.filter((r) => r.type === "GPUTexture")}
						onRequestData={requestTextureData}
					/>
				</Activity>
				<Activity mode={activeSection === "pipelines" ? "visible" : "hidden"}>
					<ResourcePanel
						resources={state.resources.filter(
							(r) =>
								r.type === "GPURenderPipeline" ||
								r.type === "GPUComputePipeline",
						)}
					/>
				</Activity>
				<Activity mode={activeSection === "shaders" ? "visible" : "hidden"}>
					<ShaderPanel
						shaders={state.resources.filter(
							(r) => r.type === "GPUShaderModule",
						)}
					/>
				</Activity>
				<Activity mode={activeSection === "commands" ? "visible" : "hidden"}>
					<CommandPanel commands={state.commands} />
				</Activity>
				<Activity mode={activeSection === "frames" ? "visible" : "hidden"}>
					<FramePanel frames={state.frames} />
				</Activity>
				<Activity mode={activeSection === "memory" ? "visible" : "hidden"}>
					<MemoryPanel snapshots={state.memorySnapshots} />
				</Activity>
				<Activity mode={activeSection === "relations" ? "visible" : "hidden"}>
					<RelationsPanel
						resources={state.resources}
						frameRelations={state.frames.at(-1)?.relations}
					/>
				</Activity>
				<Activity mode={activeSection === "errors" ? "visible" : "hidden"}>
					<ErrorPanel errors={state.errors} />
				</Activity>
			</div>
		</div>
	);
}
