import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/** Loads .env into process.env (no override, safe when absent) so GREENOPS_* run credentials stay server-side only. */
function loadEnv(): NodeJS.ProcessEnv {
  try {
    process.loadEnvFile();
  } catch {
    /* no .env at cwd — rely on already exported environment */
  }
  return process.env;
}

/** True when the server has GREENOPS_* set (via .env or the shell). Returns flags only, never the values. */
export const hasEnvConfig = createServerFn({ method: "GET" }).handler(() => {
  const env = loadEnv();
  return {
    cloud: Boolean(
      env["GREENOPS_CLOUD_ENDPOINT"] && env["EXOSCALE_API_KEY"] && env["EXOSCALE_API_SECRET"],
    ),
    work: Boolean(env["GREENOPS_WORK_ENDPOINT"]),
    grid: Boolean(env["GREENOPS_GRID_ENDPOINT"] && env["GREENOPS_GRID_SECRET"]),
  };
});

const input = z.object({
  endpoint: z.string().url().max(300).optional(), // explicit zone endpoint; omitted → env fallback
  key: z.string().min(1).max(200).optional(),
  secret: z.string().min(1).max(300).optional(),
  workFallback: z.boolean().optional(), // true → endpoint falls back to GREENOPS_WORK_ENDPOINT
  path: z
    .string()
    .regex(/^\/[A-Za-z0-9/_\-.]*$/)
    .max(200), // e.g. /instance
});

async function sign(secret: string, message: string) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Read-only GET against an Exoscale-compatible v2 API (the run's Feint/GreenOps endpoint),
 * signed with EXO2-HMAC-SHA256. Credentials are passed per call and never stored.
 */
export const exoGet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data }: { data: z.infer<typeof input> }) => {
    const env = loadEnv();
    const endpoint =
      data.endpoint ??
      (data.workFallback ? env["GREENOPS_WORK_ENDPOINT"] : env["GREENOPS_CLOUD_ENDPOINT"]) ??
      "";
    const key = data.key ?? env["EXOSCALE_API_KEY"] ?? "";
    const secret = data.secret ?? env["EXOSCALE_API_SECRET"] ?? "";
    if (!endpoint || !key || !secret)
      throw new Error(
        "Missing cloud credentials — type them in the page or set GREENOPS_* in .env",
      );
    const base = new URL(endpoint);
    if (base.protocol !== "https:" && base.protocol !== "http:")
      throw new Error("Unsupported protocol");
    const url = new URL(base.pathname.replace(/\/$/, "") + data.path, base);
    const expires = Math.floor(Date.now() / 1000) + 300;
    const msg = [`GET ${url.pathname}`, "", "", "", String(expires)].join("\n");
    const signature = await sign(secret, msg);
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `EXO2-HMAC-SHA256 credential=${key},expires=${expires},signature=${signature}`,
      },
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, ok: res.ok, body: body as never };
  });

const gridInput = z.object({
  endpoint: z.string().url().max(300).optional(), // e.g. https://<host>/runs/<id>/grid/v4; omitted → env fallback
  secret: z.string().min(1).max(300).optional(),
  path: z
    .string()
    .regex(/^\/[A-Za-z0-9/_\-.]*$/)
    .max(200), // e.g. /carbon-intensity/latest
  query: z.record(z.string(), z.string()).default({}),
});

/** Read-only GET against the run's Electricity-Maps-compatible grid API (auth-token header). */
export const gridGet = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => gridInput.parse(d))
  .handler(async ({ data }: { data: z.infer<typeof gridInput> }) => {
    const env = loadEnv();
    const endpoint = data.endpoint ?? env["GREENOPS_GRID_ENDPOINT"] ?? "";
    const secret = data.secret ?? env["GREENOPS_GRID_SECRET"] ?? "";
    if (!endpoint || !secret)
      throw new Error(
        "Missing grid credentials — type them in the page or set GREENOPS_GRID_* in .env",
      );
    const url = new URL(endpoint.replace(/\/$/, "") + data.path);
    for (const [k, v] of Object.entries(data.query)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Accept: "application/json", "auth-token": secret } });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, ok: res.ok, body: body as never };
  });
