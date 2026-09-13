/** The actual recovery UI belongs to boot and remains available after this child stops. */
export const boardRecovery = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>chirp recovery</title>
<h1>Board build unavailable</h1><p>Open immutable recovery to revert the last app source change. Messages, pages and identities are preserved.</p>
<form action="/_boot/recovery" method="get"><button>Revert last source change…</button></form>
<p><a href="/auth/login">Sign in with a passkey</a> · <a href="/_boot">open recovery help</a></p></html>`;
