import { keywordSearch } from "./search";
import { supabaseAdmin } from "./supabase";

export type Connector = {
  id: string;
  user_id: string;
  label: string;
  type: "memory_search" | "web_search" | "google_drive" | "local_files" | "custom_api";
  enabled: boolean;
  config: Record<string, unknown>;
};

export type ConnectorSource = {
  label: string;
  type: Connector["type"];
  status: "used" | "available" | "error";
  resultCount: number;
  note?: string;
  links?: Array<{ title: string; url: string }>;
};

export async function listConnectors(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("connectors")
    .select("id,label,type,enabled,config,created_at,updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function saveConnector(params: {
  userId: string;
  label: string;
  type: Connector["type"];
  enabled: boolean;
  config: Record<string, unknown>;
}) {
  const { data, error } = await supabaseAdmin
    .from("connectors")
    .insert({
      user_id: params.userId,
      label: params.label,
      type: params.type,
      enabled: params.enabled,
      config: params.config
    })
    .select("id,label,type,enabled,config,created_at,updated_at")
    .single();

  if (error) throw new Error(error.message);
  return data;
}


export async function testConnectorConnection(userId: string, connectorId: string) {
  const { data, error } = await supabaseAdmin
    .from("connectors")
    .select("id,label,type,enabled,config")
    .eq("user_id", userId)
    .eq("id", connectorId)
    .maybeSingle();

  if (error || !data) throw new Error(error?.message || "Connector not found");
  const connector = data as Connector;
  if (!connector.enabled) return { ok: false, detail: "Connector is saved but disabled." };

  if (connector.type === "memory_search") {
    const results = await keywordSearch(userId, "jarvis", "connection test");
    return { ok: true, detail: `Memory connector is reachable (${results.length} test result(s)).` };
  }

  if (connector.type === "web_search") {
    const provider = String(connector.config.provider || "").toLowerCase();
    const apiKey = String(connector.config.apiKey || connector.config.api_key || "");
    if (!provider || !apiKey) return { ok: false, detail: "Web search needs provider and apiKey in config." };
    const results = await fetchWebResults(connector.config, "AI agents");
    return { ok: true, detail: `Web search connected through ${provider} (${results.length} result(s)).` };
  }

  return { ok: true, detail: `${connector.type} is saved. Live testing for this connector type is not wired yet.` };
}
export async function buildConnectorContext(userId: string, agentId: string, query: string) {
  const { data: connectors, error } = await supabaseAdmin
    .from("connectors")
    .select("id,label,type,enabled,config")
    .eq("user_id", userId)
    .eq("enabled", true);

  if (error || !connectors?.length) return { context: "", sources: [] as ConnectorSource[] };

  const contextBlocks: string[] = [];
  const sources: ConnectorSource[] = [];

  for (const connector of connectors as Connector[]) {
    try {
      if (connector.type === "memory_search") {
        const results = await keywordSearch(userId, agentId, query);
        await logConnectorRun(userId, connector.id, query, "ok", results.length);
        sources.push({
          label: connector.label,
          type: connector.type,
          status: results.length ? "used" : "available",
          resultCount: results.length,
          note: results.length ? "Matched saved memory/search records." : "Searched but found no matching records."
        });
        if (results.length) {
          contextBlocks.push([
            `Connector: ${connector.label} (memory_search)`,
            ...results.slice(0, 5).map((item: { title: string; body: string }) => `- ${item.title}: ${item.body}`)
          ].join("\n"));
        }
      } else if (connector.type === "web_search") {
        const results = await fetchWebResults(connector.config, query);
        await logConnectorRun(userId, connector.id, query, results.length ? "ok" : "skipped", results.length, results.length ? undefined : "No web search provider/apiKey configured.");
        sources.push({
          label: connector.label,
          type: connector.type,
          status: results.length ? "used" : "available",
          resultCount: results.length,
          note: results.length ? "Fetched live web search results." : "Add provider/apiKey in connector config to fetch live results.",
          links: results.slice(0, 5).map(item => ({ title: item.title, url: item.url }))
        });
        if (results.length) {
          contextBlocks.push([
            `Connector: ${connector.label} (web_search)`,
            ...results.map(item => `- ${item.title} (${item.url}): ${item.snippet}`)
          ].join("\n"));
        } else {
          contextBlocks.push(`Connector: ${connector.label} (web_search) is available but needs config like {"provider":"brave","apiKey":"..."}.`);
        }
      } else {
        await logConnectorRun(userId, connector.id, query, "skipped", 0, "Connector type is configured but not implemented yet.");
        sources.push({
          label: connector.label,
          type: connector.type,
          status: "available",
          resultCount: 0,
          note: "Configured but not yet wired to fetch live data."
        });
        contextBlocks.push(`Connector: ${connector.label} (${connector.type}) is available but needs its external API credentials/implementation before it can fetch live data.`);
      }
    } catch (runError) {
      const message = runError instanceof Error ? runError.message : "Connector failed";
      await logConnectorRun(userId, connector.id, query, "error", 0, message);
      sources.push({ label: connector.label, type: connector.type, status: "error", resultCount: 0, note: message.slice(0, 160) });
    }
  }

  return {
    context: contextBlocks.length ? `\n\n[CONNECTOR CONTEXT]\n${contextBlocks.join("\n\n")}` : "",
    sources
  };
}


async function fetchWebResults(config: Record<string, unknown>, query: string) {
  const provider = String(config.provider || "").toLowerCase();
  const apiKey = String(config.apiKey || config.api_key || "");
  if (!provider || !apiKey) return [] as Array<{ title: string; url: string; snippet: string }>;

  if (provider === "brave") {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
      headers: { "X-Subscription-Token": apiKey, Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Brave search failed: ${response.status}`);
    const data = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return (data.web?.results ?? []).slice(0, 5).map(item => ({
      title: item.title || "Untitled result",
      url: item.url || "",
      snippet: item.description || ""
    }));
  }

  if (provider === "serper") {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 5 })
    });
    if (!response.ok) throw new Error(`Serper search failed: ${response.status}`);
    const data = await response.json() as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
    return (data.organic ?? []).slice(0, 5).map(item => ({
      title: item.title || "Untitled result",
      url: item.link || "",
      snippet: item.snippet || ""
    }));
  }

  return [] as Array<{ title: string; url: string; snippet: string }>;
}
async function logConnectorRun(userId: string, connectorId: string, query: string, status: "ok" | "error" | "skipped", resultCount: number, error?: string) {
  await supabaseAdmin.from("connector_runs").insert({
    user_id: userId,
    connector_id: connectorId,
    query,
    status,
    result_count: resultCount,
    error: error ?? null
  });
}