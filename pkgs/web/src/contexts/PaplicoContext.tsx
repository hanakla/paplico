"use client";

import type {
	Paplico,
	PaplicoCommands,
	PaplicoSelection,
	PublicUIState,
} from "@paplico/core";
import { createContext, useContext } from "react";

const PaplicoContext = createContext<Paplico | null>(null);

export function PaplicoProvider({
	paplico,
	children,
}: {
	paplico: Paplico | null;
	children: React.ReactNode;
}) {
	return (
		<PaplicoContext.Provider value={paplico}>
			{children}
		</PaplicoContext.Provider>
	);
}

/**
 * Get the Paplico instance. Throws if not available.
 */
export function usePaplico(): Paplico {
	const paplico = useContext(PaplicoContext);
	if (!paplico) {
		throw new Error("usePaplico must be used within PaplicoProvider");
	}
	return paplico;
}

/**
 * Get the Paplico instance, or null if not yet initialized.
 * Use this in components that render before Paplico is ready.
 */
export function usePaplicoMaybe(): Paplico | null {
	return useContext(PaplicoContext);
}

export function usePaplicoStore(): PublicUIState {
	return usePaplico().uiState;
}

export function usePaplicoCommands(): PaplicoCommands {
	return usePaplico().commands;
}

export function usePaplicoSelection(): PaplicoSelection {
	return usePaplico().selection;
}
