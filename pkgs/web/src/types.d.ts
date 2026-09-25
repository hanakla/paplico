declare global {
	interface Window {
		/** Debug reference to the Paplico engine instance */
		__paplico?: import("@paplico/core").Paplico;
	}
}

export {};
