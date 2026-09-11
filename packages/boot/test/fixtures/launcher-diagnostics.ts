// Only report recognized milestones: arbitrary child output can contain credentials.
export function launcherOutput(output: string) {
	return {
		characters: output.length,
		listening: /Listening on http:\/\/127\.0\.0\.1:\d+/.test(output),
		setup_open: output.includes("/setup is open, code "),
		fixture_startup_failed: output.includes("fixture startup failed"),
		child_closure_unproven: output.includes("child_closure_unproven"),
		other_output: "[redacted]",
	};
}

export function childDiagnostic(child: unknown) {
	if (typeof child !== "object" || child === null) return null;
	const state = "state" in child ? child.state : undefined;
	const stderr = "stderr" in child ? child.stderr : undefined;
	const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) ? field : null);
	return {
		state: state === "starting" || state === "live" || state === "failed" || state === "stopped" ? state : "unknown",
		pid: number("pid" in child ? child.pid : null),
		port: number("port" in child ? child.port : null),
		attempt: number("attempt" in child ? child.attempt : null),
		stderr: launcherOutput(typeof stderr === "string" ? stderr : ""),
	};
}
