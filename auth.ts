import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "./supabase";

export type AuthedRequest = Request & {
  user: { id: string; email?: string };
};

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid session" });
    return;
  }

  (req as AuthedRequest).user = {
    id: data.user.id,
    email: data.user.email ?? undefined
  };
  next();
}
