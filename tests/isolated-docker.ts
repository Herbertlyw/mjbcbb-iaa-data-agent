import { spawn } from "node:child_process";

/** Test-only Docker invocation: never print its arguments or raw stderr, which
 * can contain temporary credentials. Error categories are safe diagnostics. */
export function isolatedDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 32_000) stdout += chunk.slice(0, 32_000 - stdout.length); });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 32_000) stderr += chunk.slice(0, 32_000 - stderr.length); });
    child.once("error", () => reject(new Error("docker_process_unavailable")));
    child.once("close", (code) => {
      if (code === 0) return resolve(stdout.trim());
      const category = /address already in use|port is already allocated|failed to bind|bind:.*allocated/iu.test(stderr) ? "port_bind"
        : /no space left|out of memory|cannot allocate memory|resource temporarily unavailable|too many open files/iu.test(stderr) ? "resource_exhausted"
        : /unable to find image|no such image|pull access denied/iu.test(stderr) ? "image_unavailable"
        : /cannot connect to the docker daemon|is the docker daemon running/iu.test(stderr) ? "daemon_unavailable"
        : /conflict.*container name|name .* already in use/iu.test(stderr) ? "name_conflict" : "unclassified";
      reject(new Error(`docker_${args[0] === "run" ? "run" : args[0] === "port" ? "port" : args[0] === "inspect" ? "inspect" : "operation"}_failed_${category}_exit_${code ?? "signal"}`));
    });
  });
}

/** If a failed docker run created a stopped container, claim it for cleanup
 * only after its invocation-specific label proves that this test owns it. */
export async function runOwnedContainer(args: string[], name: string, run: string, created: string[]): Promise<void> {
  try { await isolatedDocker(args); created.push(name); }
  catch (error) {
    const label = await isolatedDocker(["inspect", "--format", '{{ index .Config.Labels "dataagent.test.run" }}', name]).catch(() => "");
    if (label === run) created.push(name);
    throw error;
  }
}

export async function loopbackPort(name: string, containerPort: number): Promise<number> {
  const output = await isolatedDocker(["port", name, `${containerPort}/tcp`]);
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(output);
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("docker_port_not_loopback");
  return port;
}
