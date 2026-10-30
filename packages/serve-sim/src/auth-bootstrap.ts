import { createHash } from "crypto";

/**
 * Page served (401) to a remote browser that has no auth cookie yet.
 *
 * Share links carry the token in the fragment (`<preview>/#token=<token>`),
 * which browsers never send to the server. This script reads it, scrubs it
 * from the address bar and history, and POSTs it in a header to the
 * same-origin exchange endpoint, which answers with the HttpOnly cookie; then
 * the page reloads authenticated. The page itself holds no secrets.
 */
export function authBootstrapPage(exchangePath: string): { html: string; csp: string } {
  // `<` escaped so the path can't close the script element.
  const path = JSON.stringify(exchangePath).replace(/</g, "\\u003c");
  const script = `(function () {
  var msg = document.getElementById("msg");
  var match = /(?:^#|&)token=([^&]*)/.exec(location.hash);
  var url = new URL(location.href);
  var hadQueryToken = url.searchParams.has("token");
  url.hash = "";
  url.searchParams.delete("token");
  if (match || hadQueryToken) history.replaceState(null, "", url.pathname + url.search);
  if (!match) {
    msg.textContent = hadQueryToken
      ? "Tokens in ?token= are not accepted (URLs end up in server logs). Open the share link as " + url.pathname + "#token=<token> instead."
      : "This serve-sim preview requires an auth token. Open the share link: " + url.pathname + "#token=<token>.";
    return;
  }
  var token;
  try { token = decodeURIComponent(match[1]); } catch (e) { token = ""; }
  msg.textContent = "Signing in\\u2026";
  fetch(${path}, { method: "POST", credentials: "same-origin", headers: { "X-Serve-Sim-Auth": token } })
    .then(function (res) {
      if (res.ok) { location.reload(); return; }
      msg.textContent = res.status === 429
        ? "Too many attempts. Wait a minute, then reopen the share link."
        : "Invalid serve-sim auth token.";
    }, function () { msg.textContent = "Could not reach the serve-sim server."; });
})();`;
  const hash = createHash("sha256").update(script).digest("base64");
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<title>serve-sim</title></head><body style="font:14px system-ui,sans-serif;padding:2em">` +
    `<p id="msg">This serve-sim preview requires an auth token.</p>` +
    `<script>${script}</script></body></html>`;
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}
