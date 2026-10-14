/** POSIX single-quote one argument so a shell sees it as one literal word. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Join an argv array into a shell command line, quoting every element. */
export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
