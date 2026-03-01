const [,, command, ...args] = process.argv;
switch (command) {
  case 'status':  require('./commands/status').statusCommand(); break;
  case 'log':     require('./commands/log').logCommand(args); break;
  case 'init':    require('./commands/init').initCommand(); break;
  case 'upgrade': require('./commands/upgrade').upgradeCommand(); break;
  default:
    require('./commands/help').helpCommand();
}
