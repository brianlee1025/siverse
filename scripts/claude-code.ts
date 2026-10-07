// Connects Siverse to Claude Code by adding (or removing) hooks in your Claude Code settings.
//
//   npm run cc:connect                         all projects (~/.claude/settings.json)
//   npm run cc:connect -- --project ../my-app  one project (.claude/settings.local.json)
//   npm run cc:disconnect                      remove Siverse's hooks again
import { PORT } from "../server/config";
import { install, uninstall } from "../server/claudeCodeHooks";

const [command, ...args] = process.argv.slice(2);
const projectFlag = args.indexOf("--project");
const project = projectFlag >= 0 ? args[projectFlag + 1] : undefined;

try {
  if (command === "install") {
    const file = install(PORT, project);
    console.log(`✅ Siverse hooks added to ${file}`);
    console.log("   Start a new Claude Code session (or restart open ones) and run `npm run dev` here to watch.");
  } else if (command === "uninstall") {
    const file = uninstall(project);
    console.log(`👋 Siverse hooks removed from ${file}`);
  } else {
    console.log("Usage: tsx scripts/claude-code.ts <install|uninstall> [--project <dir>]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
