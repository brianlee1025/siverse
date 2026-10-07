import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";

// The server can spend money on your API key, so only pages served from this machine may talk
// to it. Checking Host blocks DNS-rebinding; checking Origin blocks other websites you have open
// from sending requests to localhost.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

export function isLocalRequest(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host || !LOCAL_HOSTNAMES.has(hostnameOf(host) ?? "")) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL_HOSTNAMES.has(hostnameOf(origin) ?? "");
}

export function localOnly(req: Request, res: Response, next: NextFunction) {
  if (isLocalRequest(req)) return next();
  res.status(403).json({ error: "Siverse only accepts requests from this computer." });
}
