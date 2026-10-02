import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
	return <span className={cn("rill-badge inline-flex items-center font-mono", className)} {...props} />;
}