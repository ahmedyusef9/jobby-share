"use client";

import { useState } from "react";
import { Check, Loader2, Send, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Turn = { role: "user" | "assistant"; text: string };

export function CvChat({
  content,
  onApply,
}: {
  content: string;
  onApply: (markdown: string) => void;
}) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<{
    markdown: string;
    summary: string;
    diff?: { lines: number; sections: string[] };
  } | null>(null);

  async function send() {
    const instruction = input.trim();
    if (!instruction || busy) return;
    setInput("");
    setError("");
    setProposal(null);
    setTurns((t) => [...t, { role: "user", text: instruction }]);
    setBusy(true);
    try {
      const res = await fetch("/api/cv/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, content }),
      });
      const data = (await res.json()) as {
        error?: string;
        proposed?: string;
        summary?: string;
        unchanged?: boolean;
        diff?: { lines: number; sections: string[] };
      };
      if (!res.ok) throw new Error(data.error || "chat failed");
      if (data.unchanged) {
        setTurns((t) => [...t, { role: "assistant", text: data.summary || "No change needed." }]);
        return;
      }
      if (!data.proposed) throw new Error("No proposal returned");
      const diffLabel =
        data.diff && data.diff.lines > 0
          ? `${data.diff.lines} lines` +
            (data.diff.sections.length ? ` in ${data.diff.sections.join(", ")}` : "")
          : "";
      setProposal({
        markdown: data.proposed,
        summary: data.summary || "Proposed edit",
        diff: data.diff,
      });
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          text: [data.summary, diffLabel && `Changed ${diffLabel}.`, "Accept puts it in the editor; Save writes cv.md."]
            .filter(Boolean)
            .join(" "),
        },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "chat failed";
      setError(msg);
      setTurns((t) => [...t, { role: "assistant", text: msg }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 rounded-2xl border border-border bg-surface/30 p-4">
      <p className="text-xs font-medium text-foreground">Ask to edit the CV</p>
      <p className="mt-0.5 text-xs text-muted">
        Rephrase or reorder what is already in cv.md. Accept applies to the editor; Save writes the file.
      </p>

      {turns.length > 0 && (
        <ul className="mt-3 max-h-40 space-y-2 overflow-auto text-xs">
          {turns.map((turn, i) => (
            <li key={i} className={cn(turn.role === "user" ? "text-foreground" : "text-muted")}>
              <span className="font-medium text-faint">{turn.role === "user" ? "You" : "jobby"} · </span>
              {turn.text}
            </li>
          ))}
        </ul>
      )}

      {proposal && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-foreground">
            {proposal.summary}
            {proposal.diff && proposal.diff.lines > 0 && (
              <span className="mt-0.5 block text-muted">
                {proposal.diff.lines} lines
                {proposal.diff.sections.length > 0 ? ` · ${proposal.diff.sections.join(" · ")}` : ""}
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              onApply(proposal.markdown);
              setProposal(null);
            }}
            className="inline-flex items-center gap-1 rounded-full bg-brand px-3 py-1 font-medium text-brand-foreground max-sm:min-h-[44px]"
          >
            <Check className="size-3.5" /> Accept
          </button>
          <button
            type="button"
            onClick={() => setProposal(null)}
            className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-muted hover:text-foreground max-sm:min-h-[44px]"
          >
            <X className="size-3.5" /> Reject
          </button>
        </div>
      )}

      {error && !turns.length && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}

      <div className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={busy}
          placeholder="e.g. Shorten the summary to 3 lines"
          dir="auto"
          className="min-h-[44px] flex-1 rounded-full border border-border bg-surface px-4 text-sm outline-none placeholder:text-faint focus:border-brand/40"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-brand hover:bg-brand-soft disabled:opacity-40"
          aria-label="Send"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </button>
      </div>
    </div>
  );
}
