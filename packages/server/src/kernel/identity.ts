export type Identity = {
	readonly agent: string;
	readonly instance: string;
	readonly request: string;
	readonly kind: "human" | "agent";
	readonly label?: string;
};
