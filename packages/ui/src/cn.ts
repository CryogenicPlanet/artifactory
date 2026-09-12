import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...inputs: readonly ClassValue[]) => twMerge(clsx(inputs));
