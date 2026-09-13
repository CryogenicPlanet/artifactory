/** Self-contained recovery styling: no editable assets or external requests. */
export const chirpMark = `<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4h13v4h5v4h-8v9H8V11H3z"/><path fill="#161b1d" d="M12 6h2v2h-2z"/></svg>`;

export const authStyles = `
*{box-sizing:border-box}body{margin:0;background:#161b1d;color:#eeeee7;font:16px/1.65 system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.auth-shell{max-width:32rem;margin:10vh auto;padding:1.5rem}
.brand{display:inline-flex;align-items:center;gap:.6rem;font-size:1.6rem;font-weight:650;letter-spacing:-.06em;text-decoration:none;color:#eeeee7}.brand svg{color:#e69b83}.brand span{color:#b8d7c3;margin-left:-.55rem}
h1,p{margin-top:0}h1{font:normal clamp(2.7rem,6vw,4.5rem)/1.1 Georgia,serif;letter-spacing:-.04em;margin:2.8rem 0 1.1rem}p{color:#a8b4b4}
label,input,button{display:block}label{font-size:.85rem;color:#bcc8c6}input,button{font:inherit;padding:.75rem 1rem;border-radius:4px}input{width:100%;margin:.5rem 0 1rem;border:1px solid #52625e;background:#1e2728;color:#eeeee7;letter-spacing:.12em}button{border:0;background:#b8d7c3;color:#17201d;cursor:pointer;font-weight:550;width:100%}button:disabled{opacity:.5;cursor:wait}a{color:#b8d7c3}a:hover{color:#d5ecde}button:hover{background:#c9e3d2}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #c9bfdf;outline-offset:4px}
#status{min-height:1.6em;color:#c9bfdf;margin-top:1rem}
@media(max-width:600px){.auth-shell{margin:4vh auto}h1{margin-top:2rem}}
`;
