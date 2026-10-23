import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const input = z.object({
  endpoint: z.string().url().max(300), // e.g. https://<run>.greenops.example/v2
  key: z.string().min(1).max(200),
  secret: z.string().min(1).max(300),
  path: z.string().regex(/^\/[A-Za-z0-9/_\-.]*$/).max(200), // e.g. /instance
});

async function sign(secret: string, message: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Read-only GET against an Exoscale-compatible v2 API (the run's Feint/GreenOps endpoint),
 * signed with EXO2-HMAC-SHA256. Credentials are passed per call and never stored.
 */
export const exoGet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }) => {
    const base = new URL(data.endpoint);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Unsupported protocol");
    const url = new URL(base.pathname.replace(/\/$/, "") + data.path, base);
    const expires = Math.floor(Date.now() / 1000) + 300;
    const msg = [`GET ${url.pathname}`, "", "", "", String(expires)].join("\n");
    const signature = await sign(data.secret, msg);
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `EXO2-HMAC-SHA256 credential=${data.key},expires=${expires},signature=${signature}`,
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, ok: res.ok, body: body as never };
  });

const gridInput = z.object({
  endpoint: z.string().url().max(300), // e.g. https://<host>/runs/<id>/grid/v4
  secret: z.string().min(1).max(300),
  path: z.string().regex(/^\/[A-Za-z0-9/_\-.]*$/).max(200), // e.g. /carbon-intensity/latest
  query: z.record(z.string(), z.string()).default({}),
});

/** Read-only GET against the run's Electricity-Maps-compatible grid API (auth-token header). */
export const gridGet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => gridInput.parse(d))
  .handler(async ({ data }) => {
    const url = new URL(data.endpoint.replace(/\/$/, "") + data.path);
    for (const [k, v] of Object.entries(data.query)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Accept: "application/json", "auth-token": data.secret } });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, ok: res.ok, body: body as never };
  });
