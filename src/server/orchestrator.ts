import { fallbackAgents, getFallbackAgent } from "./agents";

const ROUTES: Array<{ agentId: string; pattern: RegExp }> = [
  { agentId: "coder", pattern: /\b(code|coding|coder|program|programming|bug|debug|fix app|upgrade app|typescript|react|vite|express|node|github|repo|repository|commit|branch|pull request|openhands|aider|cline|continue|playwright|test|build error|lint)\b/i },
  { agentId: "history", pattern: /\b(history|historical|ancient|medieval|timeline|civilization|empire|war|revolution|dynasty|archaeology)\b/i },
  { agentId: "nova", pattern: /\b(news|current|world|science|gk|general knowledge)\b/i },
  { agentId: "phil", pattern: /\b(company|market|research|competitor|product|business|r&d)\b/i },
  { agentId: "mastermind", pattern: /\b(finance|stock|invest|sip|fund|crypto|market)\b/i },
  { agentId: "homelander", pattern: /\b(skill|learn|practice|roadmap|milestone|progress)\b/i },
  { agentId: "noir", pattern: /\b(study|exam|notes|academic|revision|homework|concept)\b/i },
  { agentId: "kuhu", pattern: /\b(website|ui|ux|seo|landing|frontend|deploy|backend|supabase)\b/i },
  { agentId: "sage", pattern: /\b(quote|wisdom|stoic|philosophy|meaning|reflect)\b/i },
  { agentId: "automate", pattern: /\b(automate|automation|workflow|script|task|reminder|schedule|repeat|process|zapier|make.com|shortcut)\b/i }
];

export function routeAgent(requestedAgentId: string, userText: string) {
  if (requestedAgentId !== "jarvis") return getFallbackAgent(requestedAgentId);
  const match = ROUTES.find(route => route.pattern.test(userText));
  return getFallbackAgent(match?.agentId ?? "jarvis");
}

export function buildSystemPrompt(params: {
  routedAgentId: string;
  requestedAgentId: string;
  memories: Array<{ category: string; learning: string }>;
}) {
  const agent = getFallbackAgent(params.routedAgentId);
  const roster = fallbackAgents.map(item => `${item.name}: ${item.role}`).join("\n");
  const memory = params.memories.map(item => `- ${item.category}: ${item.learning}`).join("\n");
  const supervisorNote = params.requestedAgentId === "jarvis" && params.routedAgentId !== "jarvis"
    ? `Jarvis routed this turn to ${agent.name}. Mention the handoff in one short sentence, then answer as the specialist.`
    : "";

  return [
    `You are ${agent.name}, ${agent.role}.`,
    agent.systemPrompt,
    supervisorNote,
    `Available agent roster:\n${roster}`,
    memory ? `Learned user patterns. Use as guidance, do not recite:\n${memory}` : "",
    "Prefer durable learning over memorization: infer goals, habits, progress, constraints, and reusable lessons from prompts.",
    "Be concise before being exhaustive. If the user asks for app improvements or implementation work, return concrete tasks tied to the actual AI Agents app: reliability, provider fallback, memory, source trail, Coder safety, mobile UI, history, connectors, and deployment. Avoid generic checklists unless explicitly asked.",
    "When the user gives multiple tasks, multitask aggressively but clearly: decompose the work into parallel tracks, assign the right specialist perspective, keep dependencies visible, and return coordinated next actions. For simple one-question prompts, stay fast and direct.",
    "For Coder-style answers, never claim code was changed unless a tool or approved workflow actually changed it. For risky work involving commands, secrets, deploys, database changes, or file writes, first give a plan/diff and wait for confirmation.",
    "Be source-aware on every reply. Use the automatic Source Trail appended by the app as the truth about where context came from. If your answer depends on search results, uploaded sources, links, news, companies, laws, prices, or any current factual claim, add a Source Quality section before the Source Trail. List title/organization, URL if available, date published or accessed, source type, confidence, and what claim it supports. If you cannot verify a source or do not have browsing access, say that clearly and separate verified facts from assumptions."
  ].filter(Boolean).join("\n\n");
}