import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, sourceArg, automationArg, forkPackageArg] = process.argv.slice(2);
assert.ok((mode === "official" || mode === "fork") && sourceArg && automationArg && (mode !== "fork" || forkPackageArg),
  "Usage: ci-compat.mjs official|fork SOURCE AUTOMATION [FORK_PACKAGE]");
const source = resolve(sourceArg);
const scripts = resolve(automationArg, "scripts");
const { isolatedEnvironment, run, stageSource } = await import(pathToFileURL(join(scripts, "common.mjs")));
const { hostIdentity, prepareHost, selectDevelopmentHost } = await import(pathToFileURL(join(scripts, "hosts.mjs")));
const { checkResources, probeCli } = await import(pathToFileURL(join(scripts, "cli-probe.mjs")));
const root = mkdtempSync(join(tmpdir(), "pi-todo-compat-"));
const env = isolatedEnvironment(root);

try {
  const host = mode === "fork"
    ? await prepareHost(join(root, "host"), "fork", resolve(forkPackageArg), env)
    : hostIdentity(source, env);
  if (mode === "fork") {
    const development = join(root, "development");
    stageSource(source, development);
    selectDevelopmentHost(development, host, env);
    run("node", ["--test", "tests/native-runtime.test.ts"], {
      cwd: development, env: { ...env, PI_COMPAT_HOST: "fork" },
    });
    run("npm", ["run", "typecheck"], { cwd: development, env });
  }

  const consumer = join(root, "consumer");
  stageSource(source, consumer);
  run("npm", ["install", "--omit=dev"], { cwd: consumer, env });
  checkResources(consumer);
  const observed = probeCli(host, consumer, join(root, "probe"), env);
  assert.ok(observed.activeTools.includes("todo_list"), "Installed todo_list tool is missing");
  assert.ok(observed.commands.some((command) => command.name === "todos"), "Installed /todos command is missing");
  console.log(`${mode} Pi ${host.version}: native package loads todo_list and /todos`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
