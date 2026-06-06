import type express from "express";
import { Buffer } from "node:buffer";
import { supabaseAdmin } from "../supabase";
import { executeCoderAction, type CoderActionType, type CoderRiskLevel, type CoderProposal } from "./sandbox";

const RISK_MAP: Record<CoderActionType, CoderRiskLevel> = {
  read_file: "safe",
  generate_preview: "safe",
  explain_code: "safe",
  write_file: "confirm",
  install_package: "confirm",
  run_command: "danger",
  delete_file: "danger",
  github_issue: "confirm",
  deploy: "danger"
};

type RegisterCoderRoutesOptions = {
  userId: (req: express.Request) => string;
};

export function registerCoderRoutes(app: express.Express, options: RegisterCoderRoutesOptions) {
  const getUserId = options.userId;

  app.post("/api/automations/whatsapp", async (req, res, next) => {
    try {
      const taskTitle = String(req.body.taskTitle || "").trim();
      const customMessage = String(req.body.message || "").trim();
      const taskStatus = String(req.body.status || "todo").trim();
      const body = customMessage || `AI Agents task reminder\n\nTask: ${taskTitle}\nStatus: ${taskStatus}`;

      if (!body.trim() || (!taskTitle && !customMessage)) {
        res.status(400).json({ error: "Task title or message is required" });
        return;
      }

      const result = await sendWhatsAppMessage(body.slice(0, 1500));
      res.json({ ok: true, detail: `WhatsApp message sent with ${result.provider}.`, result });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/coder/proposals", async (req, res, next) => {
    try {
      const { data, error } = await supabaseAdmin
        .from("coder_action_proposals")
        .select("id,session_id,action_type,risk_level,payload,description,approved_by_user,rejected,executed,created_at,expires_at")
        .eq("user_id", getUserId(req))
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      res.json({ proposals: data ?? [] });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/coder/propose", async (req, res, next) => {
    try {
      const actionType = String(req.body.action_type || "") as CoderActionType;
      const risk = RISK_MAP[actionType] ?? "danger";
      const payload = sanitizePayload(req.body.payload);
      const description = String(req.body.description || "").trim();
      const sessionId = String(req.body.session_id || req.body.sessionId || "default").slice(0, 160);

      if (!actionType || !description) {
        res.status(400).json({ error: "action_type and description are required" });
        return;
      }

      const { data: proposal, error } = await supabaseAdmin
        .from("coder_action_proposals")
        .insert({
          user_id: getUserId(req),
          session_id: sessionId,
          action_type: actionType,
          risk_level: risk,
          payload,
          description,
          approved_by_user: risk === "safe",
          expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
        })
        .select("*")
        .single();

      if (error) throw error;

      if (risk === "safe") {
        const result = await executeCoderAction(proposal as CoderProposal);
        await markExecuted(proposal.id);
        await writeAudit(getUserId(req), proposal as CoderProposal, "auto_executed");
        res.json({ status: "executed", proposal, result });
        return;
      }

      res.json({ status: "pending_confirmation", proposal });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/coder/approve/:proposalId", async (req, res, next) => {
    try {
      const proposal = await findPendingProposal(req.params.proposalId, getUserId(req));
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found, expired, or already actioned" });
        return;
      }

      const { error: approveError } = await supabaseAdmin
        .from("coder_action_proposals")
        .update({ approved_by_user: true })
        .eq("id", proposal.id)
        .eq("user_id", getUserId(req));
      if (approveError) throw approveError;

      const result = await executeCoderAction(proposal);
      await markExecuted(proposal.id);
      await writeAudit(getUserId(req), proposal, "approved");
      res.json({ status: "executed", result });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/coder/reject/:proposalId", async (req, res, next) => {
    try {
      const proposal = await findPendingProposal(req.params.proposalId, getUserId(req));
      if (!proposal) {
        res.status(404).json({ error: "Proposal not found, expired, or already actioned" });
        return;
      }

      const { error } = await supabaseAdmin
        .from("coder_action_proposals")
        .update({ rejected: true })
        .eq("id", proposal.id)
        .eq("user_id", getUserId(req));
      if (error) throw error;

      await writeAudit(getUserId(req), proposal, "rejected");
      res.json({ status: "rejected" });
    } catch (error) {
      next(error);
    }
  });
}

function firstEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value && !isPlaceholder(value)) return value;
  }
  return "";
}

function isPlaceholder(value: string) {
  const lowered = value.toLowerCase();
  return ["your api key", "api key", "placeholder", "changeme", "your whatsapp token", "your twilio token"].includes(lowered) || lowered.startsWith("your-") || lowered.startsWith("replace");
}

async function sendWhatsAppMessage(body: string) {
  if (firstEnv("TWILIO_ACCOUNT_SID") && firstEnv("TWILIO_AUTH_TOKEN")) return sendTwilioWhatsApp(body);
  if (firstEnv("WHATSAPP_CLOUD_ACCESS_TOKEN") && firstEnv("WHATSAPP_CLOUD_PHONE_NUMBER_ID")) return sendMetaWhatsApp(body);
  throw new Error("WhatsApp is not configured. Add Twilio or Meta WhatsApp env vars in Render.");
}

async function sendTwilioWhatsApp(body: string) {
  const sid = firstEnv("TWILIO_ACCOUNT_SID");
  const token = firstEnv("TWILIO_AUTH_TOKEN");
  const from = ensureWhatsAppPrefix(firstEnv("TWILIO_WHATSAPP_FROM"));
  const to = ensureWhatsAppPrefix(firstEnv("TWILIO_WHATSAPP_TO"));
  if (!sid || !token || !from || !to) throw new Error("Missing Twilio WhatsApp env vars.");

  const form = new URLSearchParams({ From: from, To: to });
  const contentSid = firstEnv("TWILIO_CONTENT_SID");
  if (contentSid) {
    form.set("ContentSid", contentSid);
    form.set("ContentVariables", buildTwilioContentVariables(body));
  } else {
    form.set("Body", body);
  }

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Twilio WhatsApp failed: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { sid?: string; status?: string };
  return { provider: "Twilio", id: payload.sid, status: payload.status };
}

async function sendMetaWhatsApp(body: string) {
  const token = firstEnv("WHATSAPP_CLOUD_ACCESS_TOKEN");
  const phoneNumberId = firstEnv("WHATSAPP_CLOUD_PHONE_NUMBER_ID");
  const to = firstEnv("WHATSAPP_TO").replace(/[^\d]/g, "");
  const version = firstEnv("WHATSAPP_CLOUD_API_VERSION") || "v20.0";
  if (!token || !phoneNumberId || !to) throw new Error("Missing Meta WhatsApp Cloud API env vars.");

  const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Meta WhatsApp failed: ${text.slice(0, 500)}`);
  const payload = JSON.parse(text) as { messages?: Array<{ id?: string }> };
  return { provider: "Meta Cloud API", id: payload.messages?.[0]?.id, status: "sent" };
}

function ensureWhatsAppPrefix(value: string) {
  if (!value) return "";
  return value.startsWith("whatsapp:") ? value : `whatsapp:${value}`;
}

function buildTwilioContentVariables(body: string) {
  const custom = firstEnv("TWILIO_CONTENT_VARIABLES");
  if (custom) return custom;
  const now = new Date();
  return JSON.stringify({
    "1": now.toLocaleDateString("en-IN"),
    "2": body.slice(0, 80) || now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
  });
}

function sanitizePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

async function findPendingProposal(proposalId: string, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("coder_action_proposals")
    .select("*")
    .eq("id", proposalId)
    .eq("user_id", userId)
    .eq("approved_by_user", false)
    .eq("rejected", false)
    .eq("executed", false)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) throw error;
  return data as CoderProposal | null;
}

async function markExecuted(proposalId: string) {
  const { error } = await supabaseAdmin
    .from("coder_action_proposals")
    .update({ executed: true })
    .eq("id", proposalId);
  if (error) throw error;
}

async function writeAudit(
  userId: string,
  proposal: CoderProposal,
  outcome: "approved" | "rejected" | "expired" | "auto_executed"
) {
  const { error } = await supabaseAdmin.from("coder_audit_log").insert({
    user_id: userId,
    proposal_id: proposal.id,
    action_type: proposal.action_type,
    risk_level: proposal.risk_level,
    payload: proposal.payload,
    outcome
  });
  if (error) throw error;
}
