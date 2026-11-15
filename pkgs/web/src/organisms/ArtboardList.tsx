import { Menu as BUIMenu } from "@base-ui/react/menu";
import type { Artboard } from "@paplico/core/schema";
import { Ellipsis, Maximize } from "lucide-react";
import { useState } from "react";
import { useSnapshot } from "valtio";
import { FakeInput } from "@/components/FakeInput";
import { IconButton } from "@/components/IconButton";
import { Menu } from "@/components/Menu";
import { usePaplico } from "@/contexts/PaplicoContext";
import { useTranslation } from "@/locales";
import { useEventCallback } from "@/utils/hooks";

/**
 * Lists the artboards of the document with an editable name each.
 */
export function ArtboardList({
	onFit,
}: {
	onFit: (artboard: Artboard) => void;
}) {
	const t = useTranslation();
	const paplico = usePaplico();
	const { artboards } = useSnapshot(paplico.uiState).document;
	const [editingId, setEditingId] = useState<string | null>(null);

	const handleEditingChange = useEventCallback(
		(id: string, editing: boolean) => {
			if (editing) setEditingId(id);
			else setEditingId((current) => (current === id ? null : current));
		},
	);

	// Tab and Shift+Tab hand editing to the next or previous name
	const handleNameKeyDown = useEventCallback(
		(id: string, e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key !== "Tab") return;
			e.preventDefault();
			const index = artboards.findIndex((artboard) => artboard.id === id);
			setEditingId(artboards[index + (e.shiftKey ? -1 : 1)]?.id ?? null);
		},
	);

	if (artboards.length === 0) {
		return (
			<p className="px-3 py-2 text-xs text-muted-foreground">
				{t("assetPanel.noArtboards")}
			</p>
		);
	}

	return (
		<ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
			{artboards.map((artboard) => (
				<li
					key={artboard.id}
					className="flex items-center gap-1.5 py-0.5 pl-3 pr-1"
				>
					<ArtboardNameField
						artboard={artboard}
						editing={editingId === artboard.id}
						onEditingChange={handleEditingChange}
						onKeyDown={handleNameKeyDown}
					/>
					<Menu.Root>
						<BUIMenu.Trigger
							render={
								<IconButton
									$size="xs"
									$variant="ghost"
									aria-label={t("assetPanel.moreActions")}
								>
									<Ellipsis size={14} />
								</IconButton>
							}
						/>
						<Menu.Portal>
							<Menu.Positioner side="bottom" align="end" sideOffset={4}>
								<Menu.Popup>
									<Menu.Item onClick={() => onFit(artboard)}>
										<Maximize size={14} />
										{t("assetPanel.goToArtboard")}
									</Menu.Item>
								</Menu.Popup>
							</Menu.Positioner>
						</Menu.Portal>
					</Menu.Root>
				</li>
			))}
		</ul>
	);
}

function ArtboardNameField({
	artboard,
	editing,
	onEditingChange,
	onKeyDown,
}: {
	artboard: Artboard;
	editing: boolean;
	onEditingChange: (id: string, editing: boolean) => void;
	onKeyDown: (id: string, e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
	const t = useTranslation();
	const { commands } = usePaplico();

	return (
		<FakeInput
			$size="xs"
			$behaviour="click"
			editing={editing}
			onEditingChange={(next) => onEditingChange(artboard.id, next)}
			onKeyDown={(e) => onKeyDown(artboard.id, e)}
			className="block min-w-0 flex-1 truncate"
			aria-label={t("assetPanel.artboardName")}
			value={artboard.name}
			onChange={(name) => {
				if (!name) return;
				commands.updateArtboard(artboard.id, { name });
			}}
		/>
	);
}
