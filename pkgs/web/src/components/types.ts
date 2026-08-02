export type PropsWithNativeClassName<P> = Omit<P, "className"> & {
	className?: string;
};
