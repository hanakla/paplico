import { Layers, Pen, Plus, Sparkles, Zap } from "lucide-react";
import { memo } from "react";

export const Icons = {
	Pen: memo(Pen),
	Plus: memo(Plus),
	ActionsPanel: memo(Zap),
	Layer: memo(Layers),
	Appearance: memo(Sparkles),
};
