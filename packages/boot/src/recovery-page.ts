/** Immutable recovery needs no app process, editable source, or compiled board assets. */
export const recoveryPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>comms recovery</title>
<style>body{font:17px/1.6 system-ui;max-width:40rem;margin:8vh auto;padding:1.5rem}button{font:inherit;padding:.6rem}a{color:inherit}</style>
<h1>Recover app source</h1><p>Revert the last app source change. Messages, pages and identities are preserved. Pending edits must be resolved first; another editor’s lock is not broken.</p>
<button id="revert">Revert last source change</button><p id="status" role="status"></p>
<p><a href="/auth/login">Sign in with a passkey</a> · <a href="/_boot/status">Boot diagnostics</a> · <a href="/_boot">open recovery help</a> · <a href="/">Open board</a></p>
<script>(() => {
 const button=document.getElementById("revert"), status=document.getElementById("status");
 const request=async(path,method="GET",body,headers={}) => {
  const response=await fetch(path,{method,headers:{"content-type":"application/json",...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(120000)});
  const value=await response.json();
  if(!response.ok) throw new Error(value.error?.hint || "Request refused. Sign in again if needed, then check boot diagnostics.");
  return value;
 };
 button.addEventListener("click",async() => {
  button.disabled=true;status.textContent="Reverting the last source change…";
  try {
   const key = crypto.randomUUID();
   const current=await request("/_boot/lock");
   if(!current.lock) {
    try {await request("/_boot/lock","POST",{});}
    catch(error) {if(!(await request("/_boot/lock")).lock) throw error;}
   }
   const result=await request("/_boot/revert","POST",{},{"Idempotency-Key":key});
   if(result.status!=="live" && result.status!=="failed") throw new Error("Unreadable revert response. Check boot diagnostics.");
   status.textContent=result.status==="live" ? "Source reverted. Open the board to check it." : "Revert failed: "+(result.error || "check boot diagnostics")+". Repair source before another change.";
  } catch(error) {status.textContent=(error instanceof Error?error.message:"The response was lost.")+" An undo may have completed. Check boot diagnostics before leaving this page or starting another undo.";}
  finally {button.textContent="Undo requested — check boot diagnostics";}
 });
})();</script></html>`;
