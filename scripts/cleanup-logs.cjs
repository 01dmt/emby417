const fs = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const root = process.cwd();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const targets = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^(run|tmp)-.*\.(out|err)\.log$/i.test(name));

  let removed = 0;
  for (const name of targets) {
    await fs.rm(path.join(root, name), { force: true });
    removed += 1;
  }

  console.log(`removed ${removed} legacy log files`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
