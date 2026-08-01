import { Menu } from "@base-ui/react/menu";
import { Menubar as BUIMenubar } from "@base-ui/react/menubar";
import { memo, type ReactNode } from "react";
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
			<Menu.Trigger className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors data-[popup-open]:bg-muted data-[popup-open]:text-foreground">
				{trigger}
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner sideOffset={4}>
					<Menu.Popup className="min-w-[180px] rounded-lg bg-background/80 backdrop-liquid border border-border/50 p-1 shadow-lg outline-none">
						{children}
					</Menu.Popup>
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
			className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm text-foreground rounded cursor-pointer outline-none hover:bg-muted focus:bg-muted data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed"
		>
			<span className="flex items-center gap-2">{children}</span>
			{shortcut && (
				<span className="text-xs text-muted-foreground">{shortcut}</span>
			)}
		</Menu.Item>
	);
}

function MenubarSeparator() {
	return <Menu.Separator className="h-px bg-border my-1" />;
}
