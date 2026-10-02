import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonStyles = cva("rill-button inline-flex items-center justify-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200/40 disabled:pointer-events-none disabled:opacity-40", {
	variants: {
		variant: {
			primary: "rill-button-primary",
			secondary: "rill-button-secondary",
			ghost: "rill-button-ghost",
		danger: "rill-button-danger",
		icon: "rill-button-icon",
		},
		size: {
			default: "rill-button-default",
			small: "rill-button-small",
			icon: "rill-button-icon-size",
		},
	},
	defaultVariants: { variant: "secondary", size: "default" },
});

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonStyles> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
	<button ref={ref} className={cn(buttonStyles({ variant, size }), className)} {...props} />
));
Button.displayName = "Button";