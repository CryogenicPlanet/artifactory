import { requestIdHeader } from "@comms/protocol/headers";
import { authStyles, chirpMark } from "./auth-styles.ts";
/** Immutable boot UI: it remains usable when editable app code cannot start. */
export const authPage = (mode: "setup" | "login" | "code") => {
	const setup = mode !== "login";
	const heading = mode === "setup" ? "Create your passkey" : mode === "code" ? "Add a passkey" : "Welcome back";
	const intro =
		mode === "setup"
			? "Enter the setup code from the bootloader logs. Your password manager will save a passkey for this board."
			: mode === "code"
				? "Enter the one-time code shown in your board's account page. Your password manager will save a passkey for this address, and you will be signed in."
				: "Use your passkey to sign in to your board.";
	return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${mode === "setup" ? "Set up" : mode === "code" ? "Add a passkey to" : "Sign in to"} chirp</title>
<style>${authStyles}</style>
<main class="auth-shell"><a class="brand" href="/">${chirpMark}chirp<span>.</span></a><h1>${heading}</h1>
<p>${intro}</p>
<form id="auth" data-mode="${mode}">${setup ? `<label for="code">${mode === "code" ? "One-time code" : "Setup code"}</label><input id="code" name="code" required autocomplete="off" spellcheck="false">` : ""}
<button type="submit">${setup ? "Create passkey" : "Sign in with passkey"}</button></form>
<p id="status" role="status" aria-live="polite"></p><a href="/_boot">Recovery help</a></main>
<script src="/_boot/auth/client.js" defer></script></html>`;
};

// Kept as static JavaScript so source and bundled boot use the same immutable asset.
export const authClient = `(() => {
 const form = document.getElementById("auth");
 const status = document.getElementById("status");
 const copy = document.getElementById("copy-invite");
 const prompt = document.getElementById("invite-prompt");
 if (prompt) prompt.textContent = "Read " + window.location.origin + "/init and enroll yourself on my shared agent board. Send me the approval link, then use the board to coordinate with my other agents.";
 if (copy && prompt) copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(prompt.textContent); status.textContent = "Copied. Paste the prompt into your agent."; }
  catch { prompt.focus(); const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(prompt); selection?.removeAllRanges(); selection?.addRange(range); status.textContent = "Copy the selected prompt and paste it into your agent."; }
 });
 const safeNext = value => {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try { const target = new URL(value, window.location.origin); return target.origin === window.location.origin ? target.pathname + target.search + target.hash : "/"; }
  catch { return "/"; }
 };
 const continueLink = document.getElementById("continue-board");
 if (continueLink) continueLink.href = safeNext(new URLSearchParams(window.location.search).get("next"));
 if (!form) return;
 const button = form.querySelector("button");
 const decode = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
 const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");
 let stage = "browser", requestId = "", errorCode = "";
 const rawNext = new URLSearchParams(window.location.search).get("next");
 const next = safeNext(rawNext);
 const progress = (value, message) => { stage = value; status.textContent = message; };
 const post = async (path, body, step) => {
  requestId = ""; errorCode = "";
  progress(step + " request", step === "options" ? "Requesting passkey options…" : "Verifying your passkey…");
  let response;
  try { response = await fetch(path, {method:"POST", redirect:"manual", headers:{"content-type":"application/json"}, body:JSON.stringify(body)}); }
  catch { throw new Error("The authentication request could not reach the board. Check your connection and sharing-service sign-in."); }
  const id = response.headers.get("${requestIdHeader}");
  requestId = /^[a-f0-9]{32}$/.test(id || "") ? id : "";
  progress(step + " response", "Reading the authentication response…");
  if (response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400))
   throw new Error("Authentication was redirected. Open this board directly and complete any sharing-service sign-in.");
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The board or sharing proxy returned an unreadable response (HTTP " + response.status + "). Check the connection and sign-in page."); }
  if (!result || typeof result !== "object") throw new Error("The board returned an invalid authentication response.");
  if (!response.ok) {
   const messages = {setup_code_invalid:"That setup code is incorrect. Check the latest code in the bootloader logs.", setup_closed:"Setup is complete. Open /auth/login to sign in.", setup_required:"Create your first passkey at /setup.", challenge_invalid:"This passkey request expired or was already used. Try again.", origin_invalid:"This address is not an allowed origin for this board, or the code is bound to a different address.", passkey_code_invalid:"That code is incorrect, expired, already used, or meant for a different address. Generate a new code from a signed-in session.", passkey_code_locked:"Too many wrong codes. Wait a minute, then enter the code again.", origin_unproven:"The board could not confirm this address points to it. Add the domain to your host and DNS first, then try again.", passkey_origin_mismatch:"No passkey on this board belongs to an address it serves. Ask the operator to restore the previous address settings or reopen setup.", authentication_invalid:"The passkey could not be verified. Try again.", registration_invalid:"The passkey could not be registered. Try again.", boot_unavailable:"The boot authentication store is unavailable. Check the bootloader logs."};
   const code = result.error?.code;
   errorCode = typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "";
   throw new Error((Object.hasOwn(messages, errorCode) ? messages[errorCode] : null) || "Authentication was refused (HTTP " + response.status + "). Check the board configuration or sign in again.");
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
  event.preventDefault(); button.disabled = true;
  requestId = ""; errorCode = "";
  progress("browser", "Checking passkey support…");
  try {
   if (!window.isSecureContext || !navigator.credentials) throw new Error("Passkeys require HTTPS or http://localhost.");
   const mode = form.dataset.mode;
   const setup = mode !== "login";
   const path = mode === "code" ? "/_boot/auth/passkey-code" : "/_boot/auth/" + (setup ? "setup" : "login");
   const input = setup ? {code:document.getElementById("code").value.trim()} : {};
   const started = await post(path + "/options", input, "options");
   progress("options decode", "Preparing the passkey request…");
   const options = started.options;
   options.challenge = decode(options.challenge);
   if (setup) {
    options.user.id = decode(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map(item => ({...item,id:decode(item.id)}));
   } else options.allowCredentials = (options.allowCredentials || []).map(item => ({...item,id:decode(item.id)}));
   progress(setup ? "credential create" : "credential get", setup ? "Waiting for your browser to create a passkey…" : "Waiting for your browser to unlock your passkey…");
   const credential = await navigator.credentials[setup ? "create" : "get"]({publicKey:options});
   if (!credential) throw new Error("No passkey was returned. Try again.");
   progress("credential encode", "Preparing passkey verification…");
   await post(path + "/verify", {id:started.id, response:serialize(credential)}, "verify");
   const destination = form.dataset.onboarding === "true" ? "/onboarding" + (next === "/" ? "" : "?next=" + encodeURIComponent(next)) : next;
   window.location.assign(mode === "setup" ? "/auth/login?next=" + encodeURIComponent(destination) : next);
  } catch (error) {
   const names = ["NotAllowedError", "SecurityError", "InvalidStateError", "NotSupportedError", "AbortError", "TypeError", "UnknownError", "Error", "InvalidCharacterError"];
   const name = names.includes(error?.name) ? error.name : "Error";
   const native = stage === "credential create" || stage === "credential get";
   const message = native
    ? "Your browser could not complete the passkey request. Check your password manager and this site's passkey permissions. This browser failure is not visible to the server."
    : stage === "options decode" || stage === "credential encode"
     ? "The passkey data could not be prepared. Reload the page and try again."
     : error instanceof Error ? error.message : "Authentication failed. Reload the page and try again.";
   status.textContent = message + " Stage: " + stage + "; " + name + (errorCode ? "; code: " + errorCode : "") + (requestId ? "; request: " + requestId : "; no board request ID received") + ".";
  }
  finally { button.disabled = false; }
 });
})();`;
