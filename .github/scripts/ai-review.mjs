// Automated PR reviewer: sends the PR diff to OpenAI and posts the review as a
// PR comment. Runs on pull_request events. Requires the OPENAI_API_KEY repo
// secret; exits quietly (green) when it is not configured yet.
import { readFileSync } from "node:fs";
import { buildSignalBody } from "./ai-review-signal.mjs";

const MARKER = "<!-- ai-pr-review -->";
const MAX_DIFF_CHARS = 50000;

const token = process.env.GITHUB_TOKEN;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REVIEW_MODEL || "gpt-4o";
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");

// Reasoning models (gpt-5*, o1/o3/o4*) reject sampling params and max_tokens
// on the chat completions endpoint — they need max_completion_tokens instead
// (generous: hidden reasoning tokens count against the same budget).
const isReasoningModel = /^(gpt-5|o1|o3|o4)([.-]|$)/i.test(model);

if (!apiKey) {
  console.log("OPENAI_API_KEY not set — skipping AI review.");
  process.exit(0);
}

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const prNumber = event.pull_request?.number;
if (!prNumber) {
  console.log("No pull request in event payload — skipping.");
  process.exit(0);
}
const headSha = (event.pull_request?.head?.sha ?? "unknown").slice(0, 7);

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

// 1. Fetch the diff.
const diff = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
  headers: { Accept: "application/vnd.github.diff" },
}).then((r) => r.text());

// 2. Keep only reviewable code files, drop lockfiles/build output/databases.
const files = [];
for (const chunk of diff.split(/^diff --git /m).slice(1)) {
  const pathMatch = chunk.match(/^a\/(.+?) b\//m);
  const path = pathMatch ? pathMatch[1] : "unknown";
  if (!/\.(ts|tsx|js|mjs|cjs)$/.test(path)) continue;
  if (/(^|\/)(dist|build|node_modules)\//.test(path)) continue;
  files.push({ path, chunk: "diff --git " + chunk });
}
if (files.length === 0) {
  console.log("No reviewable code files in this PR — skipping.");
  process.exit(0);
}

let combined = files.map((f) => f.chunk).join("\n");
let truncated = false;
if (combined.length > MAX_DIFF_CHARS) {
  combined = combined.slice(0, MAX_DIFF_CHARS);
  truncated = true;
}

// 3. Ask OpenAI to review.
const system = `You are a senior engineer reviewing a pull request for nycfoodie, a TypeScript npm-workspaces monorepo: an MCP server (Streamable HTTP on Railway) that gives AI agents structured editorial NYC restaurant recommendations, backed by SQLite with numbered migrations. The database layer does atomic volume releases with deliberate defensive code.

Review the unified diff below. Focus on, in order:
1. Correctness bugs and broken invariants (highest priority — be specific, cite file and line).
2. Security issues (injection, credential handling, SSRF, unsafe shell use).
3. Missing or inadequate tests for the changed behaviour.
4. Minor nits (style, naming) — keep these brief and clearly separated.

Do NOT flag:
- Verbose defensive code in the database release / migration path — that verbosity is deliberate crash-safety, verified by kill -9 tests.
- British English spellings.
- Pre-existing style you would have written differently; only flag what is wrong or risky.

Write the review in British English. Format: a short verdict line first, then "Issues" (numbered, with file:line refs), then "Nits" if any. If nothing is wrong, say so in one line and stop. Keep the whole review under 400 words.`;

const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    // Reasoning models only accept the default temperature and need
    // max_completion_tokens; classic models keep the tuned sampling params.
    ...(isReasoningModel ? { max_completion_tokens: 6000 } : { temperature: 0.2, max_tokens: 1500 }),
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          `Review this pull request diff${truncated ? " (truncated to fit)" : ""}:\n\n${combined}`,
      },
    ],
  }),
});
if (!aiRes.ok) throw new Error(`OpenAI API ${aiRes.status}: ${await aiRes.text()}`);
const review = (await aiRes.json()).choices[0].message.content;

const body =
  `${MARKER}\n` +
  `## 🤖 AI code review (${model}) — \`${headSha}\`\n\n${review}\n\n` +
  `<sub>Automated review — treat as a second opinion, not a verdict.</sub>`;

// 4. Create or update the bot's comment so re-pushes don't spam the thread.
const comments = await gh(
  `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`
).then((r) => r.json());
const existing = comments.find((c) => c.body?.includes(MARKER));
let reviewCommentId;
if (existing) {
  await gh(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  });
  reviewCommentId = existing.id;
  console.log(`Updated review comment ${existing.id}.`);
} else {
  const created = await gh(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).then((r) => r.json());
  reviewCommentId = created.id;
  console.log("Posted new review comment.");
}

// 5. Post a short per-run signal comment. The full review above is edited in
// place, which produces no thread event — without this, a new verdict on a
// new push is invisible and nobody knows the review landed. The signal embeds
// this run's verdict and review verbatim: the linked full-review comment
// always shows the latest run, so a bare link would go stale and mislead.
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
  // The gh helper above throws on any non-OK response, so reaching this line
  // already confirms the full-review comment was created/updated; the builder
  // additionally fails closed on an invalid id rather than posting a broken
  // "#issuecomment-undefined" anchor.
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
