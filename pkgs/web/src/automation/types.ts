export type AutomationScript = {
	id: string;
	name: string;
	description: string;
	source: string;
	origin: "builtin" | "user";
};

export type AutomationDiagnostic = {
	message: string;
	severity: "error" | "warning" | "info";
	line?: number;
	column?: number;
};

export type AutomationRunResult = {
	diagnostics: AutomationDiagnostic[];
};

export type AutomationPromptRequest =
	| {
			kind: "alert";
			message: string;
	  }
	| {
			kind: "confirm";
			message: string;
	  }
	| {
			kind: "string";
			message: string;
			defaultValue: string;
	  }
	| {
			kind: "number";
			message: string;
			defaultValue: number;
	  }
	| {
			kind: "boolean";
			message: string;
			defaultValue: boolean;
	  }
	| {
			kind: "choice";
			message: string;
			choices: string[];
			defaultValue: string;
	  };

export type AutomationPromptResponse = string | number | boolean | null;

export interface AutomationRuntimeAdapter {
	run(source: string): Promise<AutomationRunResult>;
	stop(): void;
	dispose(): Promise<void>;
}

export type AutomationRuntimeFactory = (callbacks: {
	onLog: (message: string) => void;
	onPrompt: (
		request: AutomationPromptRequest,
		signal: AbortSignal,
	) => Promise<AutomationPromptResponse>;
}) => Promise<AutomationRuntimeAdapter>;

export interface AutomationScriptRepository {
	readonly canManageUserScripts: boolean;
	list(): Promise<AutomationScript[]>;
	create(input: {
		name: string;
		description: string;
		source: string;
	}): Promise<AutomationScript>;
	update(script: AutomationScript): Promise<AutomationScript>;
	delete(id: string): Promise<void>;
}
