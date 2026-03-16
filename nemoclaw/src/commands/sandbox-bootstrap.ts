// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import type { PluginLogger } from "../index.js";

export interface EnsureSandboxOpenClawBootstrapOptions {
  sandboxName: string;
  logger: PluginLogger;
}

type SandboxOpenClawCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  detail: string;
};

type GatewayInstallJson = {
  ok?: boolean;
  message?: string;
  warnings?: string[];
};

function isSystemdUnavailableDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("systemctl --user unavailable") ||
    normalized.includes("systemctl not available") ||
    normalized.includes("systemd user services are required") ||
    normalized.includes("failed to connect to bus") ||
    normalized.includes("dbus_session_bus_address") ||
    normalized.includes("xdg_runtime_dir")
  );
}

function readExecStream(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value instanceof Buffer) {
    return value.toString("utf-8").trim();
  }
  return "";
}

function runSandboxOpenClawCommand(
  sandboxName: string,
  args: string[],
): SandboxOpenClawCommandResult {
  try {
    const stdout = execFileSync("openshell", ["sandbox", "connect", sandboxName, "--", "openclaw", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: "",
      detail: stdout.trim(),
    };
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? readExecStream((err as { stderr?: unknown }).stderr)
        : "";
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? readExecStream((err as { stdout?: unknown }).stdout)
        : "";
    const detail = stderr || stdout || String(err);
    return {
      ok: false,
      stdout,
      stderr,
      detail,
    };
  }
}

function parseGatewayInstallJson(stdout: string): GatewayInstallJson | null {
  if (!stdout) {
    return null;
  }
  try {
    return JSON.parse(stdout) as GatewayInstallJson;
  } catch {
    return null;
  }
}

function runSandboxShellCommand(sandboxName: string, script: string): SandboxOpenClawCommandResult {
  try {
    const stdout = execFileSync(
      "openshell",
      ["sandbox", "connect", sandboxName, "--", "sh", "-lc", script],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: "",
      detail: stdout.trim(),
    };
  } catch (err: unknown) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? readExecStream((err as { stderr?: unknown }).stderr)
        : "";
    const stdout =
      err && typeof err === "object" && "stdout" in err
        ? readExecStream((err as { stdout?: unknown }).stdout)
        : "";
    const detail = stderr || stdout || String(err);
    return {
      ok: false,
      stdout,
      stderr,
      detail,
    };
  }
}

function startSandboxGatewayWithoutSystemd(
  sandboxName: string,
  logger: PluginLogger,
): SandboxOpenClawCommandResult {
  logger.warn(
    "Sandbox user-systemd is unavailable. Falling back to a direct background Gateway process.",
  );
  return runSandboxShellCommand(
    sandboxName,
    [
      'mkdir -p "$HOME/.openclaw/logs"',
      'if ! openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then',
      '  nohup openclaw gateway run --force >"$HOME/.openclaw/logs/gateway.log" 2>&1 < /dev/null &',
      "fi",
      "for i in 1 2 3 4 5 6 7 8; do",
      "  if openclaw gateway status --deep --require-rpc >/dev/null 2>&1; then",
      '    echo "gateway-ready"',
      "    exit 0",
      "  fi",
      "  sleep 2",
      "done",
      'echo "gateway-not-ready" >&2',
      "exit 1",
    ].join("\n"),
  );
}

export function ensureSandboxOpenClawBootstrap(
  opts: EnsureSandboxOpenClawBootstrapOptions,
): boolean {
  const { sandboxName, logger } = opts;

  const setup = runSandboxOpenClawCommand(sandboxName, ["setup"]);
  if (!setup.ok) {
    logger.error(`Failed to initialize OpenClaw inside the sandbox: ${setup.detail}`);
    logger.info(
      `After resolving the issue, run 'openshell sandbox connect ${sandboxName} -- openclaw setup'.`,
    );
    return false;
  }

  // Keep bootstrap headless. `gateway install` auto-generates and persists a
  // gateway token when one is missing, then installs the managed service.
  const install = runSandboxOpenClawCommand(sandboxName, ["gateway", "install", "--json"]);
  const parsed = parseGatewayInstallJson(install.stdout);
  const installFailure = !install.ok || parsed?.ok === false;
  const installFailureDetail = parsed?.message || install.detail || "Sandbox Gateway install failed.";

  if (installFailure && isSystemdUnavailableDetail(installFailureDetail)) {
    const fallback = startSandboxGatewayWithoutSystemd(sandboxName, logger);
    if (!fallback.ok) {
      logger.error(`Failed to start the sandbox Gateway without systemd: ${fallback.detail}`);
      logger.info(
        `After resolving the issue, run 'openshell sandbox connect ${sandboxName} -- openclaw gateway run --force'.`,
      );
      return false;
    }
    for (const warning of parsed?.warnings ?? []) {
      logger.warn(warning);
    }
    logger.info("Initialized OpenClaw config and started the Gateway directly inside the sandbox.");
    return true;
  }

  if (installFailure) {
    logger.error(`Failed to install the sandbox Gateway service: ${installFailureDetail}`);
    logger.info(
      `After resolving the issue, run 'openshell sandbox connect ${sandboxName} -- openclaw gateway install'.`,
    );
    return false;
  }
  for (const warning of parsed?.warnings ?? []) {
    logger.warn(warning);
  }

  logger.info("Initialized OpenClaw config and installed the Gateway service inside the sandbox.");
  return true;
}
