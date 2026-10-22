// Targmanich relay: lets the public page use one Gemini key without ever
// showing it. The browser opens a WebSocket here; this function opens the
// real Live API WebSocket with the secret key and passes frames both ways.
//
// Guard rails: only the two free Live models, only from the Targmanich page
// (or localhost while testing), bounded frame size and session length.
// Deploy with JWT verification off: browsers cannot send headers on a WebSocket.

const UPSTREAM =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const MODELS = new Set(["gemini-3.8-live", "gemini-3.8-live-extended-thinking"]);
const ORIGINS = [
  /^https:\/\/forgit-dc\.github\.io$/i,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];
const MAX_FRAME = 400_000; // characters
const MAX_SESSION_MS = 120_000;

// Browsers only accept 1000 or 3000-4999 from close(); 1011 becomes 4011.
const relayCode = (code: number) => (code === 1000 || (code >= 3000 && code < 5000) ? code : 4000 + (code % 1000));
const clip = (reason: string) => new TextEncoder().encode(reason).length > 120 ? reason.slice(0, 60) : reason;

Deno.serve((req) => {
  if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("Targmanich relay: WebSocket only.", { status: 426 });
  }
  const origin = req.headers.get("origin") || "";
  if (!ORIGINS.some((re) => re.test(origin))) {
    return new Response("Origin not allowed.", { status: 403 });
  }
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return new Response("Relay not configured.", { status: 503 });

  const { socket: client, response } = Deno.upgradeWebSocket(req, { idleTimeout: 0 });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  // @ts-ignore EdgeRuntime is provided by the Supabase runtime.
  EdgeRuntime.waitUntil(closed);

  let upstream: WebSocket | null = null;
  const pending: string[] = [];
  let done = false;

  const shut = (code: number, reason: string) => {
    if (done) return;
    done = true;
    clearTimeout(limit);
    try { client.close(relayCode(code), clip(reason)); } catch { /* already closed */ }
    try { upstream?.close(1000); } catch { /* already closed */ }
    resolveClosed();
  };
  const limit = setTimeout(() => shut(4000, "Session time limit reached."), MAX_SESSION_MS);

  client.onmessage = (ev) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
    if (data.length > MAX_FRAME) return shut(4009, "Frame too large.");

    if (!upstream) {
      // The first frame must be the setup, for one of the allowed models.
      let model = "";
      try { model = String(JSON.parse(data)?.setup?.model || "").replace(/^models\//, ""); } catch { /* not JSON */ }
      if (!MODELS.has(model)) return shut(4008, "Model not allowed on this relay.");

      upstream = new WebSocket(`${UPSTREAM}?key=${encodeURIComponent(key)}`);
      upstream.binaryType = "arraybuffer";
      upstream.onopen = () => {
        for (const frame of pending.splice(0)) upstream!.send(frame);
      };
      upstream.onmessage = (up) => {
        if (client.readyState !== WebSocket.OPEN) return;
        client.send(typeof up.data === "string" ? up.data : new TextDecoder().decode(up.data as ArrayBuffer));
      };
      upstream.onclose = (up) => shut(up.code === 1005 ? 1000 : up.code, up.reason || "");
      upstream.onerror = () => shut(4006, "Upstream connection failed.");
      pending.push(data);
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    else pending.push(data);
  };

  client.onclose = () => shut(1000, "");
  client.onerror = () => shut(1000, "");

  return response;
});
