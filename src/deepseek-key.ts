import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

/** Read a local credential without echoing it. Environment overrides the
 * explicitly ignored file. Never follow links or accept a shared file. */
export function deepSeekKey(env: NodeJS.ProcessEnv, runtimeDir: string): string {
  const fromEnvironment = env.DEEPSEEK_API_KEY?.trim();
  if (fromEnvironment) return valid(fromEnvironment);
  let fd: number | undefined;
  try {
    if (lstatSync(runtimeDir).isSymbolicLink()) throw new Error("credential_file_unsafe");
    fd = openSync(path.join(runtimeDir, "deepseek-api-key"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size < 1 || stat.size > 4096) throw new Error("credential_file_unsafe");
    return valid(readFileSync(fd, "utf8").trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "";
    throw new Error("本机 DeepSeek 密钥文件不可用或权限不安全，请检查 .local-runtime/deepseek-api-key（仅本人可读）。");
  } finally { if (fd !== undefined) closeSync(fd); }
}

function valid(value: string): string {
  if (!value || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error("DeepSeek 密钥格式无效；请在本机更新配置。");
  return value;
}
