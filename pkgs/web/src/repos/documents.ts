import { tauriDocumentsRepo } from "@/infra/documentDB.tauri";
import type { DocumentsRepo } from "@/infra/documentDB.types";
import { webDocumentsRepo } from "@/infra/documentDB.web";
import { IS_TAURI_ENV } from "@/utils/platform";

export const documentsRepo: DocumentsRepo = IS_TAURI_ENV
	? tauriDocumentsRepo
	: webDocumentsRepo;
