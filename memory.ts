import { supabaseAdmin } from "./supabase";

const LEARNING_RULES: Array<{ category: string; pattern: RegExp; build: (text: string) => string }> = [
  {
    category: "Goal",
    pattern: /\b(i want|i need|make|build|create|add|fix|improve|deploy)\b/i,
    build: text => `User goal or task: ${text.slice(0, 220)}`
  },
  {
    category: "Learning Style",
    pattern: /\b(learn|learning|teach|study|practice|quiz|understand|over memorizing)\b/i,
    build: () => "User wants agents to learn durable patterns and progress from prompts, not merely memorize raw chat."
  },
  {
    category: "Tool Preference",
    pattern: /\b(standalone|accounts|supabase|backend|deployment|auth|streaming|upload)\b/i,
    build: text => `Tooling preference or system requirement: ${text.slice(0, 220)}`
  },
  {
    category: "Accessibility",
    pattern: /\b(accessible|mobile|responsive|screen reader|keyboard|aria)\b/i,
    build: () => "User values accessible, mobile-responsive interfaces with clear controls."
  }
];

export async function learnFromMessage(params: {
  userId: string;
  agentId: string;
  messageId: string;
  userText: string;
  fileNames: string[];
}) {
  const rows = [];

  for (const rule of LEARNING_RULES) {
    if (rule.pattern.test(params.userText)) {
      rows.push({
        user_id: params.userId,
        agent_id: params.agentId,
        category: rule.category,
        learning: rule.build(params.userText),
        source_message_id: params.messageId,
        confidence: 0.75
      });
    }
  }

  if (params.fileNames.length) {
    rows.push({
      user_id: params.userId,
      agent_id: params.agentId,
      category: "File Context",
      learning: `User uploaded files for this task: ${params.fileNames.join(", ")}`,
      source_message_id: params.messageId,
      confidence: 0.8
    });
  }

  if (!rows.length) return;

  await supabaseAdmin.from("memories").upsert(rows, {
    onConflict: "user_id,agent_id,category,learning",
    ignoreDuplicates: true
  });

  await supabaseAdmin.from("search_documents").insert(
    rows.map(row => ({
      user_id: params.userId,
      agent_id: params.agentId,
      source_type: "memory",
      source_id: params.messageId,
      title: row.category,
      body: row.learning
    }))
  );
}

export async function getRelevantMemory(userId: string, agentId: string) {
  const { data } = await supabaseAdmin
    .from("memories")
    .select("category, learning")
    .eq("user_id", userId)
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(12);

  return data ?? [];
}

export async function listMemories(userId: string, agentId?: string) {
  let query = supabaseAdmin
    .from("memories")
    .select("id,agent_id,category,learning,confidence,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(80);

  if (agentId) query = query.eq("agent_id", agentId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function updateMemory(userId: string, id: string, params: { category?: string; learning?: string; confidence?: number }) {
  const updates: Record<string, string | number> = {};
  if (params.category) updates.category = params.category;
  if (params.learning) updates.learning = params.learning;
  if (typeof params.confidence === "number") updates.confidence = params.confidence;

  const { data, error } = await supabaseAdmin
    .from("memories")
    .update(updates)
    .eq("user_id", userId)
    .eq("id", id)
    .select("id,agent_id,category,learning,confidence,created_at")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function deleteMemory(userId: string, id: string) {
  const { error } = await supabaseAdmin
    .from("memories")
    .delete()
    .eq("user_id", userId)
    .eq("id", id);

  if (error) throw new Error(error.message);
}