import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export type CoderRiskLevel = "safe" | "confirm" | "danger";

export type CoderActionType =
  | "read_file"
  | "generate_preview"
  | "explain_code"
  | "write_file"
  | "run_command"
  | "install_package"
  | "delete_file"
  | "github_issue"
  | "deploy";

export type CoderProposal = {
  id: string;
  user_id: string;
  session_id: string;
  action_type: CoderActionType;
  risk_level: CoderRiskLevel;
  payload: Record<string, unknown>;
  description: string;
};

const execFileAsync = promisify(execFile);
const SANDBOX = path.resolve(process.env.CODER_SANDBOX_DIR || path.join(process.cwd(), ".coder-sandbox"));
const ALLOWED_COMMANDS = ["npm run build", "npm test", "npm run lint", "git status"];

export function assertSandboxed(filePath: unknown): string {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("SANDBOX_VIOLATION: missing file path");
  }

  const candidate = path.isAbsolute(filePath) ? filePath : path.join(SANDBOX, filePath);
  const resolved = path.resolve(candidate);
  const sandboxResolved = path.resolve(SANDBOX);

  if (resolved !== sandboxResolved && !resolved.startsWith(`${sandboxResolved}${path.sep}`)) {
    console.error(`[SECURITY] Sandbox violation attempt: ${filePath}`);
    throw new Error(`SANDBOX_VIOLATION: path '${filePath}' is outside sandbox`);
  }

  return resolved;
}

export async function executeCoderAction(proposal: CoderProposal) {
  const payload = proposal.payload ?? {};

  switch (proposal.action_type) {
    case "write_file": {
      const safePath = assertSandboxed(payload.path);
      const content = String(payload.content ?? "");
      await fs.mkdir(path.dirname(safePath), { recursive: true });
      await fs.writeFile(safePath, content, "utf8");
      return { written: safePath, bytes: Buffer.byteLength(content, "utf8") };
    }
    case "read_file": {
      const safePath = assertSandboxed(payload.path);
      const content = await fs.readFile(safePath, "utf8");
      return { content };
    }
    case "delete_file": {
      const safePath = assertSandboxed(payload.path);
      await fs.rm(safePath, { force: true });
      return { deleted: safePath };
    }
    case "run_command": {
      const command = String(payload.command ?? "").trim();
      if (!ALLOWED_COMMANDS.some(allowed => command === allowed || command.startsWith(`${allowed} `))) {
        throw new Error(`COMMAND_NOT_ALLOWLISTED: ${command}`);
      }

      const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
        cwd: SANDBOX,
        timeout: 30_000,
        maxBuffer: 1024 * 1024
      });
      return { stdout, stderr };
    }
    case "install_package": {
      const packageName = String(payload.packageName ?? payload.package ?? "").trim();
      const allowlist = String(process.env.CODER_PACKAGE_ALLOWLIST || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);
      if (!packageName || !allowlist.includes(packageName)) {
        throw new Error(`PACKAGE_NOT_ALLOWLISTED: ${packageName || "missing package"}`);
      }

      const { stdout, stderr } = await execFileAsync("npm", ["install", packageName], {
        cwd: SANDBOX,
        timeout: 60_000,
        maxBuffer: 1024 * 1024
      });
      return { stdout, stderr };
    }
    case "generate_preview":
    case "explain_code":
      return { preview: String(payload.content ?? payload.diff ?? "") };
    case "github_issue":
    case "deploy":
      throw new Error(`${proposal.action_type.toUpperCase()}_REQUIRES_MANUAL_OPERATOR`);
    default:
      throw new Error(`Unknown action type: ${proposal.action_type}`);
  }
}
