import { supabaseAdmin } from "./supabase";

export async function keywordSearch(userId: string, agentId: string, query: string) {
  const { data } = await supabaseAdmin.rpc("keyword_search", {
    search_user_id: userId,
    search_agent_id: agentId,
    query,
    match_count: 10
  });

  return data ?? [];
}
