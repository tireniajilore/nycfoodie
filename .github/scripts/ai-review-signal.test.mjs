// Tests for the AI-review signal comment builder. The signal must stay
// accurate forever: the full-review comment it links to is edited in place
// on every later run, so a signal that only linked to it would silently
// start describing a different verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSignalBody } from "./ai-review-signal.mjs";

const base = {
  sha: "6f7d77c",
  verdictLine: "Needs changes: two findings.",
  review: "Needs changes: two findings.\n\nIssues\n\n1. something specific",
  reviewCommentId: 5762819061,
  owner: "tireniajilore",
  repo: "nycfoodie",
  prNumber: 12,
  runAt: "2026-09-21T19:42:50.000Z",
};

test("signal embeds the run's verdict and full review text verbatim", () => {
  const body = buildSignalBody(base);
  assert.match(body, /`6f7d77c`/);
  assert.ok(body.includes(base.verdictLine), "verdict line embedded");
  assert.ok(body.includes(base.review), "full review text embedded");
  assert.ok(body.includes(base.runAt), "run timestamp embedded");
});

test("signal links the exact full-review comment id", () => {
  const body = buildSignalBody(base);
  assert.ok(
    body.includes(
      "https://github.com/tireniajilore/nycfoodie/pull/12#issuecomment-5762819061"
    ),
    "exact anchor linked"
  );
  assert.ok(!body.includes("undefined"), "no broken anchor");
});

test("signal says the linked comment always shows the latest run", () => {
  const body = buildSignalBody(base);
  assert.match(body, /always shows the latest run/);
});

test("an invalid review comment id fails closed instead of posting a broken link", () => {
  for (const bad of [undefined, null, 0, -3, 1.5, "5762819061"]) {
    assert.throws(
      () => buildSignalBody({ ...base, reviewCommentId: bad }),
      /invalid reviewCommentId/,
      `rejects ${String(bad)}`
    );
  }
});
