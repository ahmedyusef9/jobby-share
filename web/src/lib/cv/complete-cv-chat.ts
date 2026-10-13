import { tenantSecretEnv } from "@/lib/key-store";
import { tenantId } from "@/lib/tenant";

type ChatMsg = { role: "system" | "user" | "assistant"; content: string };

function stripProviderPrefix(model: string): string {
  return model.replace(/^omniroute\//, "").replace(/^openrouter\//, "");
}

async function postCompletions(
  url: string,
  apiKey: string,
  model: string,
  messages: ChatMsg[],
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: 8000,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
  };
  if (!res.ok) {
    throw new Error(data.error?.message || `LLM HTTP ${res.status}`);
  }
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty model reply");
  return content;
}

/** OmniRoute (preferred) or OpenRouter. Does not write files. */
export async function completeCvChat(messages: ChatMsg[]): Promise<{ text: string; via: string }> {
  // This call bills a key directly rather than through a spawn, so it resolves the
  // same way a job does: from the caller's own store. In multi-tenant mode the
  // operator's OmniRoute key is not in this fragment, so no tenant spends it.
  const secrets = tenantSecretEnv(tenantId()) as Record<string, string>;

  const omniBase = (process.env.JOBBY_OMNIROUTE_BASE_URL || "").trim().replace(/\/$/, "");
  const omniKey = (secrets.JOBBY_OMNIROUTE_API_KEY || "").trim();
  if (omniBase && omniKey) {
    const model = stripProviderPrefix(process.env.OPENCODE_MODEL || "auto/best-coding");
    const text = await postCompletions(`${omniBase}/chat/completions`, omniKey, model, messages);
    return { text, via: `omniroute/${model}` };
  }
  const orKey = (secrets.OPENROUTER_API_KEY || "").trim();
  if (orKey) {
    const model = process.env.CAREER_OPS_MODEL?.trim() || "openrouter/free";
    const text = await postCompletions("https://openrouter.ai/api/v1/chat/completions", orKey, model, messages);
    return { text, via: model };
  }
  throw new Error("No AI key on this account — add an OpenRouter key in Config to use CV chat.");
}
