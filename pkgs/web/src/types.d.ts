declare global {
	/** In Tauri enviroment, confirm returns Promise<void> */
	declare function confirm(message?: string): Promise<boolean>;

	interface Window {
		/** Debug reference to the Paplico engine instance */
		__paplico?: import("@/core").Paplico;
	}
}

export {};
