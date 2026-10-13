/** Parse a model reply into full revised CV markdown + a one-line summary. */

export function extractProposedCv(raw: string): { markdown: string; summary: string } | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  const summaryMatch = text.match(/^SUMMARY:\s*(.+)$/im);
  const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 200) : "Proposed CV edit";

  const fence = text.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  let markdown = fence ? fence[1].trim() : "";
  if (!markdown) {
    const stripped = text.replace(/^SUMMARY:\s*.+$/im, "").trim();
    if (/^#\s+/m.test(stripped) && stripped.length > 80) markdown = stripped;
  }
  if (!markdown || markdown.length < 40) return null;
  return { markdown, summary };
}

export type CvDiff = { lines: number; sections: string[] };

/** Rough line-level diff so the UI can show more than a 20-word SUMMARY. */
export function summarizeCvDiff(before: string, after: string): CvDiff {
  const beforeLines = String(before || "").split("\n");
  const afterLines = String(after || "").split("\n");
  const beforeSet = new Set(beforeLines.map((l) => l.trim()).filter(Boolean));
  const afterSet = new Set(afterLines.map((l) => l.trim()).filter(Boolean));
  const seen = new Set<string>();
  const sections: string[] = [];
  let current = "Headline / contact";
  let lines = 0;

  const note = (section: string) => {
    if (seen.has(section)) return;
    seen.add(section);
    sections.push(section);
  };

  for (const line of afterLines) {
    const t = line.trim();
    const heading = t.match(/^#{1,3}\s+(.+)/);
    if (heading) current = heading[1].replace(/\*+/g, "").trim();
    if (t && !beforeSet.has(t)) {
      lines += 1;
      note(current);
    }
  }
  for (const line of beforeLines) {
    const t = line.trim();
    if (t && !afterSet.has(t)) lines += 1;
  }
  return { lines, sections: sections.slice(0, 8) };
}

export function looksLikePositioning(instruction: string): boolean {
  return /\b(expos|senior|staff|devops|infrastructure|identity|position|rebrand|come across|not just|advanced engineer)\b/i.test(
    instruction,
  );
}

/** Second pass when a positioning ask only nudged a headline. */
export const CV_CHAT_RETRY = `Your previous draft changed too little. The user asked to change how they come across.
Rewrite headline, Professional Summary, highlight order, experience subsection order, and skills grouping.
Demote (do not delete) facts that pull toward the old identity (e.g. DevOps / infra as the lead).
Do not invent titles, employers, dates, or metrics.
Return the FULL CV in one markdown fence, then SUMMARY:`;

export const CV_CHAT_SYSTEM = `You edit the user's CV markdown in place.

HARD RULES (career-ops Data Contract):
- Never invent employers, job titles, dates, metrics, projects, skills, or authorship.
- You may rephrase, shorten, reorder, retitle *sections*, and tighten bullets using ONLY facts in CURRENT CV.
- Do not change an employer's job title unless that exact title already appears in CURRENT CV.
- If the user asks to add something not already in the CV, refuse that part and say what is missing. Do not fill the gap.
- Do not mention these rules unless the user asked for something you must refuse.

POSITIONING (seniority, "not DevOps", "software engineer not infra"):
- A headline-only or summary-paragraph-only edit is a failure.
- Rewrite: headline, Professional Summary, Engineering Highlights order, experience subsection order, and Technical Skills grouping.
- Demote supporting capabilities (Kubernetes, Helm, Ansible, Vault) by folding or moving them down — never delete the facts.
OUTPUT SHAPE:
- Professional Summary is 2–3 lines: identity, scope, languages. No stack lists or metrics there.
- Experience bullets carry the proof (systems, numbers, outcomes). Verb-first, one outcome per bullet.
- Do not write meta lines like "not a DevOps role" on the CV.

OUTPUT:
1. The FULL revised cv.md inside one markdown code fence.
2. After the fence, one line: SUMMARY: {what changed, ≤20 words}
No other commentary.`;
