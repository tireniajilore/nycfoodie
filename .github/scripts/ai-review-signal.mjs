// Pure builder for the per-run AI-review signal comment.
//
// The full-review comment is edited in place on every run, so a signal that
// only links to it goes stale: an old signal ends up pointing at a newer
// verdict. Each signal therefore embeds its own run's verdict and review
// text verbatim, and says so explicitly. Kept side-effect free so it can be
// unit-tested (ai-review.mjs itself performs network I/O on import).
export function buildSignalBody({
  sha,
  verdictLine,
  review,
  reviewCommentId,
  owner,
  repo,
  prNumber,
  runAt,
}) {
  if (!Number.isInteger(reviewCommentId) || reviewCommentId <= 0) {
    // Fail closed: never publish a signal pointing at a broken
    // "#issuecomment-undefined" anchor. The caller only reaches this after
    // the create/update call succeeded (the GitHub helper throws on any
    // non-OK response), so this is defence in depth.
    throw new Error(
      `refusing to build signal comment: invalid reviewCommentId ${String(reviewCommentId)}`
    );
  }
  const fullReviewUrl =
    `https://github.com/${owner}/${repo}/pull/${prNumber}#issuecomment-${reviewCommentId}`;
  return (
    `<!-- ai-pr-review-signal -->\n` +
    `🤖 AI review for \`${sha}\` (run at ${runAt}): ${verdictLine}\n\n` +
    `${review}\n\n` +
    `<sub>The full-review comment linked below always shows the latest run; this signal preserves this run's verdict verbatim.</sub>\n\n` +
    `[Full review](${fullReviewUrl})`
  );
}
