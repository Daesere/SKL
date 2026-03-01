export function helpCommand(): void {
  console.log(`skl — Structured Knowledge Layer CLI

Usage: skl <command> [options]

Commands:
  status              Show current SKL state and recent activity
  log                 Show full activity history
    --agent <id>        Filter by agent ID
    --scope <name>      Filter by semantic scope
    --limit <n>         Limit output (default: 20)
    --pending           Show only pending proposals
  init                Initialise SKL Phase 0 in this repo
  upgrade             Upgrade from Phase 0 to full SKL

Examples:
  skl status
  skl log --agent Agent-1 --limit 10
  skl init`);
}
