/** POSIX single-quote one argument so a shell sees it as one literal word. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Join an argv array into a shell command line, quoting every element. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * Command line for `serve-sim exec <command...>`. A single argument is already
 * a shell command line (`exec "xcrun simctl list | head"`) and passes through
 * as-is; several arguments are an argv, quoted so each stays one word.
 */
export function execCommandLine(argv: readonly string[]): string {
  return argv.length === 1 ? argv[0]! : shellJoin(argv);
}
