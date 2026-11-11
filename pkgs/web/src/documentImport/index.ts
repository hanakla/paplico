import type { Paplico } from "@paplico/core";
import type { Document } from "@paplico/core/schema";
import { documentImporters } from "#document-importers";

/** Converts a file written by another application into a Paplico document. */
export interface DocumentImporter {
	/** Lowercase file extensions, each with its leading dot. */
	extensions: `.${string}`[];
	/** @param fonts Lists the fonts the converted text can be set in. */
	convert(file: Blob, fonts: Paplico["fonts"]): Promise<Document>;
}

/** Extensions of every file the app can open as a document. */
export function openableDocumentExtensions(): `.${string}`[] {
	return [".papf", ...documentImporters.flatMap((i) => i.extensions)];
}

/** The extension of `fileName` when the app can open it as a document. */
export function openableDocumentExtension(
	fileName: string,
): string | undefined {
	const lowerName = fileName.toLowerCase();
	return openableDocumentExtensions().find((ext) => lowerName.endsWith(ext));
}

/** The importer for `fileName`, or undefined when it is not a foreign format. */
export function findDocumentImporter(
	fileName: string,
): DocumentImporter | undefined {
	const lowerName = fileName.toLowerCase();
	return documentImporters.find((importer) =>
		importer.extensions.some((ext) => lowerName.endsWith(ext)),
	);
}
