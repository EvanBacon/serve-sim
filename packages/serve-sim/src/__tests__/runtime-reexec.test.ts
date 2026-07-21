import { describe, expect, test } from "bun:test";
import { reExecCommand } from "../runtime";

describe("reExecCommand", () => {
  test("keeps an extensionless npm bin shim when running under Node", () => {
    expect(reExecCommand(["--detach"], {
      execPath: "/opt/homebrew/bin/node",
      entrypoint: "/project/node_modules/.bin/serve-sim",
    })).toEqual({
      command: "/opt/homebrew/bin/node",
      args: ["/project/node_modules/.bin/serve-sim", "--detach"],
    });
  });

  test("keeps a source entrypoint when running under Bun", () => {
    expect(reExecCommand(["--tunnel-child"], {
      execPath: "/opt/homebrew/bin/bun",
      entrypoint: "/project/packages/serve-sim/src/index.ts",
    })).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: ["/project/packages/serve-sim/src/index.ts", "--tunnel-child"],
    });
  });

  test("re-executes a compiled binary without its virtual Bun entrypoint", () => {
    expect(reExecCommand(["--tunnel-child"], {
      execPath: "/project/packages/serve-sim/dist/serve-sim",
      entrypoint: "/$bunfs/root/serve-sim",
    })).toEqual({
      command: "/project/packages/serve-sim/dist/serve-sim",
      args: ["--tunnel-child"],
    });
  });
});
