import type { NextFunction, Request, Response } from "express";
import { supabaseAuth } from "./supabase";

export type AuthedRequest = Request & {
  accessToken: string;
  user: { id: string; email?: string };
};

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired session. Please sign in again." });
    return;
  }

  (req as AuthedRequest).accessToken = token;
  (req as AuthedRequest).user = {
    id: data.user.id,
    email: data.user.email ?? undefined
  };
  next();
}
