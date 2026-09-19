#!/usr/bin/env node
// nycfoodie-crawler CLI. Subcommands (crawl-reviews, crawl-guides, …) land in step 4.

const [cmd] = process.argv.slice(2);

switch (cmd) {
  case undefined:
  case "help":
  case "--help":
    console.log(`nycfoodie-crawler — crawl editorial sources into nycfoodie-db.

Usage:
  nycfoodie-crawl help

Subcommands are not implemented yet. The Infatuation data-surface mapping
(step 2) and the schema proposal (step 3) come first; crawler subcommands
land in step 4, after schema sign-off.`);
    break;
  default:
    console.error(`Unknown command: ${cmd}. Run \`nycfoodie-crawl help\`.`);
    process.exit(1);
}
