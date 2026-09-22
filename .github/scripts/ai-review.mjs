// Automated PR reviewer: sends the PR diff to OpenAI and posts the review as a
// PR comment. Runs on pull_request events. Requires the OPENAI_API_KEY repo
// secret; exits quietly (green) when it is not configured yet.
//
// Two-pass pipeline (rebuilt 2026-09-21 after four diff-scoping false
// positives on PR #12):
//   1. Diff is packed test-first: test files are shown to the model before
//      source hunks, so budget cuts land on source, never on test evidence.
//      Files that don't fit are disclosed to the model as "omitted from
//      view" so it can't claim anything about what it didn't see.
//   2. Pass 1 writes a draft review with evidence rules (file:line + quote
//      per issue, check-before-claim on test coverage, verdict gating).
//   3. Pass 2 verifies the draft against the diff and file list and kills
//      unsupported issues; the pruned review is what gets published.
import { readFileSync } from "node:fs";
import { buildSignalBody } from "./ai-review-signal.mjs";
import { packDiffFiles } from "./ai-review-pack.mjs";
import {
  buildSystemPrompt,
  buildReviewPrompt,
  buildVerifySystemPrompt,
  buildVerifyPrompt,
} from "./ai-review-prompt.mjs";

const MARKER = "<!-- ai-pr-review -->";
const MAX_DIFF_CHARS = 100000;
const ALLOWED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|ya?ml|md)$/i;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.git)\//;

const eventPath = process.env.GITHUB_EVENT_PATH;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4o";
const token = process.env.GITHUB_TOKEN;
if (!eventPath || !token) {
  console.log("Missing GITHUB_EVENT_PATH or GITHUB_TOKEN; skipping.");
  process.exit(0);
}
if (!apiKey) {
  // Not configured yet: stay green and quiet, no comment.
  console.log("OPENAI_API_KEY not configured; skipping AI review.");
  process.exit(0);
}

const event = JSON.parse(readFileSync(eventPath, "utf8"));
const prNumber = event.pull_request?.number;
const owner = event.repository.owner.login;
const repo = event.repository.name;
const headSha = (event.pull_request.head.sha || "").slice(0, 7);
if (!prNumber) {
  console.log("No pull_request in event; skipping.");
  process.exit(0);
}

const gh = (path, opts = {}) =>
  fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`GitHub API ${r.status} on ${path}: ${await r.text()}`);
    return r;
  });

// 1. Fetch the full PR diff and split it into per-file chunks.
const diffText = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: "application/vnd.github.diff" },
}).then((r) => r.text());

const files = [];
for (const chunk of diffText.split(/^diff --git /m).slice(1)) {
  const m = /^a\/(.+?) b\//m.exec(chunk);
  if (!m) continue;
  const path = m[1];
  if (!ALLOWED_EXT.test(path) || SKIP_DIR.test(path)) continue;
  files.push({ path, chunk: "diff --git " + chunk });
}
if (files.length === 0) {
  console.log("No reviewable files in diff; skipping.");
  process.exit(0);
}

// 2. Pack test-first so the budget cut never eats test evidence.
const { packed: combined, included, omitted } = packDiffFiles(files, MAX_DIFF_CHARS);
const allFiles = [...included, ...omitted];

const isReasoningModel = /^(o\d|gpt-5)/.test(model);
async function chat(messages, maxOut) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      ...(isReasoningModel
        ? { max_completion_tokens: maxOut }
        : { temperature: 0.2, max_tokens: maxOut }),
      messages,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices[0].message.content;
}

// 3. Pass 1: draft review with evidence and check-before-claim rules.
const draft = await chat(
  [
    { role: "system", content: buildSystemPrompt() },
    {
      role: "user",
      content: buildReviewPrompt({ diff: combined, allFiles, omitted }),
    },
  ],
  isReasoningModel ? 6000 : 1500
);

// 4. Pass 2: verify the draft and kill unsupported issues. Skipped when the
// draft already finds nothing — there is nothing to prune.
let review = draft;
if (!/^\s*looks good/i.test(draft)) {
  review = await chat(
    [
      { role: "system", content: buildVerifySystemPrompt() },
      {
        role: "user",
        content: buildVerifyPrompt({ draft, diff: combined, allFiles, omitted }),
      },
    ],
    isReasoningModel ? 6000 : 1500
  );
}

// 5. Create or update the bot's full-review comment so re-pushes don't spam
// the thread. The gh helper throws on any non-OK response, so reaching the
// signal step already confirms the comment was created/updated.
const comments = await gh(
  `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
).then((r) => r.json());
const existing = comments.find((c) => c.body?.includes(MARKER));
let reviewCommentId;
if (existing) {
  await gh(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: `${MARKER}\n## 🤖 AI code review (${model}) — \`${headSha}\`\n\n${review}\n\n<sub>Automated review — treat as a second opinion, not a verdict.</sub>`,
    }),
  });
  reviewCommentId = existing.id;
  console.log(`Updated review comment ${existing.id}.`);
} else {
  const created = await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: `${MARKER}\n## 🤖 AI code review (${model}) — \`${headSha}\`\n\n${review}\n\n<sub>Automated review — treat as a second opinion, not a verdict.</sub>`,
    }),
  }).then((r) => r.json());
  reviewCommentId = created.id;
  console.log(`Created review comment ${created.id}.`);
}

// 6. Post a short per-run signal comment. The full review above is edited in
// place, which produces no thread event — without this, a new verdict on a
// new push is invisible and nobody knows the review landed. The signal
// embeds this run's verdict and review verbatim: the linked full-review
// comment always shows the latest run, so a bare link would go stale and
// mislead.
const verdictLine =
  review
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0)
    ?.slice(0, 200) ?? "review posted";
const signalBody = buildSignalBody({
  sha: headSha,
  verdictLine,
  review,
  reviewCommentId,
  owner,
  repo,
  prNumber,
  runAt: new Date().toISOString(),
});
await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body: signalBody }),
});
console.log(`Posted review signal for ${headSha}.`);
