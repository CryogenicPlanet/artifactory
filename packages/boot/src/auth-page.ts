/** Immutable boot UI: it remains usable when editable app code cannot start. */
export const authPage = (setup: boolean) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${setup ? "Set up" : "Sign in to"} comms</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:28rem;margin:12vh auto;padding:1.5rem;color:#20251f;background:#f5f5ef}h1{line-height:1.2}label,input,button{display:block}input,button{font:inherit;padding:.7rem;width:100%;box-sizing:border-box;margin:.7rem 0}button{border:0;background:#244933;color:white;border-radius:.35rem;cursor:pointer}button:disabled{opacity:.5}a{color:#244933}#status{min-height:3em}</style>
<main><p>comms</p><h1>${setup ? "Create your passkey" : "Welcome back"}</h1>
<p>${setup ? "Enter the setup code from the bootloader logs. Your password manager will save a passkey for this board." : "Use your passkey to sign in to your board."}</p>
<form id="auth" data-mode="${setup ? "setup" : "login"}">${setup ? '<label for="code">Setup code</label><input id="code" name="code" required autocomplete="off" spellcheck="false">' : ""}
<button type="submit">${setup ? "Create passkey" : "Sign in with passkey"}</button></form>
<p id="status" role="status" aria-live="polite"></p><a href="/_boot">Recovery help</a></main>
<script src="/_boot/auth/client.js" defer></script></html>`;

// Kept as static JavaScript so source and bundled boot use the same immutable asset.
export const authClient = `(() => {
 const form = document.getElementById("auth");
 const status = document.getElementById("status");
 const button = form.querySelector("button");
 const decode = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
 const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");
 const post = async (path, body) => {
  const response = await fetch(path, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) {
   const messages = {setup_code_invalid:"That setup code is incorrect. Check the latest code in the bootloader logs.", setup_closed:"Setup is complete. Open /auth/login to sign in.", setup_required:"Create your first passkey at /setup.", challenge_invalid:"This passkey request expired or was already used. Try again.", origin_invalid:"This address does not match the configured public origin.", authentication_invalid:"The passkey could not be verified. Try again.", registration_invalid:"The passkey could not be registered. Try again.", boot_unavailable:"The boot authentication store is unavailable. Check the bootloader logs."};
   throw new Error(messages[result.error?.code] || "Request failed. Try again.");
  }
  return result;
 };
 const serialize = credential => {
  const response = credential.response;
  const value = {id:credential.id, rawId:encode(credential.rawId), type:credential.type, clientExtensionResults:credential.getClientExtensionResults(), response:{clientDataJSON:encode(response.clientDataJSON)}};
  if (response instanceof AuthenticatorAttestationResponse) {
   value.response.attestationObject = encode(response.attestationObject);
   if (response.getTransports) value.response.transports = response.getTransports();
  }
  else {
   value.response.authenticatorData = encode(response.authenticatorData);
   value.response.signature = encode(response.signature);
   if (response.userHandle) value.response.userHandle = encode(response.userHandle);
  }
  return value;
 };
 form.addEventListener("submit", async event => {
  event.preventDefault(); button.disabled = true; status.textContent = "Waiting for your passkey…";
  try {
   if (!window.isSecureContext || !navigator.credentials) throw new Error("Passkeys require HTTPS or http://localhost.");
   const setup = form.dataset.mode === "setup";
   const path = "/_boot/auth/" + (setup ? "setup" : "login");
   const input = setup ? {code:document.getElementById("code").value.trim()} : {};
   const started = await post(path + "/options", input);
   const options = started.options;
   options.challenge = decode(options.challenge);
   if (setup) {
    options.user.id = decode(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map(item => ({...item,id:decode(item.id)}));
   } else options.allowCredentials = (options.allowCredentials || []).map(item => ({...item,id:decode(item.id)}));
   const credential = await navigator.credentials[setup ? "create" : "get"]({publicKey:options});
   if (!credential) throw new Error("No passkey was returned. Try again.");
   await post(path + "/verify", {id:started.id, response:serialize(credential)});
   window.location.assign(setup ? "/auth/login" : "/");
  } catch (error) { status.textContent = error instanceof Error ? error.message : "Sign in failed. Try again."; }
  finally { button.disabled = false; }
 });
})();`;
