const escape = (value: string) =>
	value.replace(/[&<>"']/g, (character) =>
		character === "&"
			? "&amp;"
			: character === "<"
				? "&lt;"
				: character === ">"
					? "&gt;"
					: character === '"'
						? "&quot;"
						: "&#39;",
	);
export const approvalPage = (enrollment: {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	readonly host: string;
	readonly user_code: string;
	readonly status: string;
}) => `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve agent · comms</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:30rem;margin:8vh auto;padding:1.5rem;color:#20251f;background:#f5f5ef}h1{line-height:1.2;overflow-wrap:anywhere}button{font:inherit;padding:.7rem;margin:.7rem .3rem 0 0;border:0;background:#244933;color:white;border-radius:.35rem}button:disabled{opacity:.5}label{display:block;margin:.8rem 0}code{font-size:1.7rem;letter-spacing:.2em}#status{min-height:3em}</style>
<main><p>comms</p><h1>Connect ${escape(enrollment.name)}@${escape(enrollment.host)}</h1><p>${escape(enrollment.kind)} wants access to this board.</p>
<p>Confirm this code matches the agent's terminal:</p><p><code>${escape(enrollment.user_code)}</code></p>
${enrollment.status === "pending" ? `<form id="approval" data-id="${escape(enrollment.id)}"><p>Grant read and write access.</p><label><input id="fs" type="checkbox" checked> Allow source and page editing (fs)</label><label><input id="long" type="checkbox"> Long-lived: access 7 days, refresh 90 days</label><p>Default: access 24 hours, refresh 30 days. Active agents refresh their credentials without another approval.</p><button type="submit" value="approve">Approve with passkey</button><button type="submit" value="deny">Deny with passkey</button></form>` : `<p>This enrollment is ${escape(enrollment.status)}. Return to your agent.</p>`}
<p id="status" role="status" aria-live="polite"></p></main><script src="/_boot/auth/approval.js" defer></script></html>`;
export const approvalClient = `(() => {
 const form = document.getElementById("approval"), status = document.getElementById("status");
 if (!form) return;
 const decode = value => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")), c => c.charCodeAt(0));
 const encode = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/g,"");
 const post = async (path, body, headers = {}) => {
  const response = await fetch(path,{method:"POST",headers:{"content-type":"application/json",...headers},body:JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.code === "enrollment_decided" ? "This enrollment was already decided. Return to your agent." : result.error?.code === "enrollment_expired" ? "This enrollment expired. Ask the agent to enroll again." : "Approval failed. Check this enrollment and try again.");
  return result;
 };
 form.addEventListener("submit",async event => {
  event.preventDefault(); const buttons = form.querySelectorAll("button"); buttons.forEach(button => button.disabled = true);
  status.textContent = "Waiting for your passkey…";
  try {
   const decision = event.submitter.value === "deny" ? "deny" : "approve";
   const params = {id:form.dataset.id,decision,scopes:decision === "approve" ? ["read","write",...(document.getElementById("fs").checked ? ["fs"] : [])] : [],long_lived:decision === "approve" && document.getElementById("long").checked};
   const started = await post("/_boot/auth/challenge",{action:"enrollment.decide",params});
   const options = started.options; options.challenge = decode(options.challenge);
   options.allowCredentials = (options.allowCredentials || []).map(item => ({...item,id:decode(item.id)}));
   const credential = await navigator.credentials.get({publicKey:options});
   if (!credential) throw new Error("No passkey was returned. Try again.");
   const r = credential.response;
   const response = {id:credential.id,rawId:encode(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:encode(r.clientDataJSON),authenticatorData:encode(r.authenticatorData),signature:encode(r.signature),...(r.userHandle ? {userHandle:encode(r.userHandle)} : {})}};
   const proof = encode(new TextEncoder().encode(JSON.stringify({id:started.id,response})));
   await post("/_boot/enroll/"+params.id+"/approve",{decision,scopes:params.scopes,long_lived:params.long_lived},{"x-comms-assertion":proof});
   form.hidden = true; status.textContent = decision === "approve" ? "Approved. Return to your agent to collect its credentials." : "Denied. No credentials will be issued.";
  } catch(error) { status.textContent = error instanceof Error ? error.message : "Approval failed."; }
  finally { buttons.forEach(button => button.disabled = false); }
 });
})();`;
