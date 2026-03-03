import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}

export type WithElementRef<T, El extends HTMLElement = HTMLElement> = T & {
	ref?: El | null;
};

export type WithoutChildren<T> = T extends object ? Omit<T, "children"> : T;
export type WithoutChild<T> = T extends object ? Omit<T, "child"> : T;
export type WithoutChildrenOrChild<T> = T extends object
	? Omit<T, "children" | "child">
	: T;
