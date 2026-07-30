"use strict";

// Conventional Comments (https://conventionalcomments.org) — same vocabulary
// Plannotator uses, so agent-side handling is identical.
const LABELS = ["suggestion", "nit", "question", "issue", "praise", "thought", "note", "todo", "chore"];

function scopeLabel(scope) {
  if (!scope) return "working tree";
  if (scope.type === "commit") return `commit ${String(scope.sha).slice(0, 8)}`;
  if (scope.type === "range") return `${scope.base}...${scope.head}`;
  return "local changes (working tree vs HEAD)";
}

/**
 * Render annotations as markdown the agent can act on directly.
 * Grouped by file, ordered by line, blocking items called out.
 */
function render({ annotations = [], summary = "", decision = "annotated", scope, repo }) {
  if (decision === "approved" && !annotations.length && !summary.trim()) {
    return "The user approved.";
  }
  if (decision === "dismissed") {
    return "Review session closed without feedback.";
  }

  const out = [];
  out.push("# Code review feedback");
  out.push("");
  out.push(
    `Reviewed \`${repo || "repository"}\` — ${scopeLabel(scope)}. ` +
      `${annotations.length} comment${annotations.length === 1 ? "" : "s"}.`
  );

  if (summary.trim()) {
    out.push("");
    out.push("## Overall");
    out.push("");
    out.push(summary.trim());
  }

  const blocking = annotations.filter((a) => a.blocking);
  if (blocking.length) {
    out.push("");
    out.push(
      `> **${blocking.length} blocking comment${blocking.length === 1 ? "" : "s"}** — these must be resolved.`
    );
  }

  const byFile = new Map();
  for (const a of annotations) {
    const key = a.file || "(general)";
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(a);
  }

  for (const [file, list] of byFile) {
    list.sort((a, b) => (a.line || 0) - (b.line || 0));
    out.push("");
    out.push(`## \`${file}\``);
    for (const a of list) {
      const label = LABELS.includes(a.label) ? a.label : "comment";
      const loc =
        a.endLine && a.endLine !== a.line ? `L${a.line}-L${a.endLine}` : `L${a.line}`;
      const side = a.side === "old" ? " (old side)" : "";
      out.push("");
      out.push(`### ${file}:${a.line} — ${label}${a.blocking ? " (blocking)" : ""}`);
      out.push("");
      out.push(`*${loc}${side}*`);
      if (a.code) {
        out.push("");
        out.push("```" + (a.lang || ""));
        out.push(a.code);
        out.push("```");
      }
      out.push("");
      out.push((a.body || "").trim() || "_(no comment text)_");
      if (a.suggestion && a.suggestion.trim()) {
        out.push("");
        out.push("Suggested replacement:");
        out.push("");
        out.push("```" + (a.lang || "suggestion"));
        out.push(a.suggestion.replace(/\n+$/, ""));
        out.push("```");
      }
    }
  }

  out.push("");
  out.push("---");
  out.push("");
  out.push(
    "Address every comment above. For each one, either make the change or explain why not. " +
      "Blocking comments must be resolved before proceeding."
  );
  return out.join("\n");
}

module.exports = { render, LABELS };
