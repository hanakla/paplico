import { Menubar as BUIMenubar } from "@base-ui/react/menubar";
import { memo, type ReactNode } from "react";
import { Menu } from "@/components/Menu";
import { twm } from "@/utils/tailwind";

type MenubarProps = {
	children: ReactNode;
	className?: string;
};

export const Menubar = {
	Root: memo(MenubarRoot),
	Menu: memo(MenubarMenu),
	Item: memo(MenubarItem),
	Separator: memo(MenubarSeparator),
};

function MenubarRoot({ children, className }: MenubarProps) {
	return (
		<BUIMenubar className={twm("flex items-center gap-1", className)}>
			{children}
		</BUIMenubar>
	);
}

type MenubarMenuProps = {
	trigger: ReactNode;
	children: ReactNode;
};

function MenubarMenu({ trigger, children }: MenubarMenuProps) {
	return (
		<Menu.Root>
			<Menu.Trigger className="hover:bg-background data-popup-open:bg-background">
				{trigger}
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4}>
					<Menu.Popup>{children}</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

type MenubarItemProps = {
	children: ReactNode;
	onClick?: () => void;
	shortcut?: string;
	disabled?: boolean;
};

function MenubarItem({
	children,
	onClick,
	shortcut,
	disabled,
}: MenubarItemProps) {
	return (
		<Menu.Item
			onClick={onClick}
			disabled={disabled}
			className="justify-between gap-4"
		>
			<span className="flex items-center gap-2">{children}</span>
			{shortcut && (
				<span className="text-xs text-muted-foreground">{shortcut}</span>
			)}
		</Menu.Item>
	);
}

function MenubarSeparator() {
	return <Menu.Separator className="mx-0 bg-border" />;
}
