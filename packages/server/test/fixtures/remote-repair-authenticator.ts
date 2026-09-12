import { authenticator } from "../../../boot/test/fixtures/authenticator.ts";

/** One real passkey and monotonic authenticator counter survive all board restarts in this test. */
export const repairAuthenticator = () => {
	const device = authenticator();
	let counter = 0;
	return {
		registration: device.registration,
		assertion: (challenge: string) => device.assertion(challenge, ++counter),
	};
};
