import type express from "express";
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
