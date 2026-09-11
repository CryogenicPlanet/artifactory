import { useSyncExternalStore } from "react";
const subscribe = (changed: () => void) => {
	document.addEventListener("visibilitychange", changed);
	return () => document.removeEventListener("visibilitychange", changed);
};
export const useVisible = () => useSyncExternalStore(subscribe, () => document.visibilityState === "visible");
