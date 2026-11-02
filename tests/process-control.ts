import type { ChildProcess } from "node:child_process";

/** Stop only the child created by this test. A child terminated by a signal has
 * exitCode === null, even though its exit event has already fired. */
export async function stopProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(deadline);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish();
    const onError = () => finish(new Error("test_child_stop_failed"));
    const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
    const deadline = setTimeout(() => finish(new Error("test_child_stop_timeout")), 10000);
    child.once("exit", onExit);
    child.once("error", onError);
    // Recheck after adding the listeners so an already delivered exit is not
    // missed and a process that no longer belongs to this ChildProcess is not signalled.
    if (child.exitCode !== null || child.signalCode !== null) finish();
    else child.kill(signal);
  });
}
