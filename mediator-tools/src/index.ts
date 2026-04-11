// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * mediator-tools — standalone OpenClaw plugin that registers OpenShell
 * mediator syscalls as native agent tools.
 *
 * Connects directly to the mediator daemon's UDS socket using the
 * length-prefixed JSON frame protocol. No shell, no child_process.
 *
 * This is a SEPARATE plugin from NemoClaw. It has zero dependencies on
 * the NemoClaw plugin code and can be loaded independently.
 */

import { createConnection } from "node:net";
import { readFileSync, accessSync } from "node:fs";

// ── Minimal OpenClaw plugin SDK types ──────────────────────────────────

interface PluginToolResult {
  content: Array<{ type: string; text: string }>;
}

interface PluginToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => PluginToolResult | Promise<PluginToolResult>;
}

interface PluginApi {
  logger: { info(msg: string): void; warn(msg: string): void; debug(msg: string): void };
  registerTool: (tool: PluginToolDefinition) => void;
}

// ── Mediator UDS client ───────────────────────────────────────────────

const DEFAULT_SOCKET = "/sandbox/.mediator/mediator.sock";
const DEFAULT_TOKEN_FILE = "/sandbox/.mediator/mediator.sock.token";

let cachedToken = "";

function getToken(): string {
  if (cachedToken) return cachedToken;
  try {
    cachedToken =
      process.env["MEDIATOR_TOKEN"] ||
      readFileSync(DEFAULT_TOKEN_FILE, "utf-8").trim();
  } catch {
    cachedToken = process.env["MEDIATOR_TOKEN"] || "";
  }
  return cachedToken;
}

function callMediator(
  method: string,
  params?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const socket = process.env["MEDIATOR_SOCKET"] || DEFAULT_SOCKET;
    const token = getToken();

    if (!token) {
      resolve({ ok: false, error: "MEDIATOR_TOKEN not set and token file not readable" });
      return;
    }

    const request = {
      id: `mt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      workflow_token: token,
      params: params ?? {},
    };

    const payload = Buffer.from(JSON.stringify(request), "utf-8");
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);

    const conn = createConnection(socket);
    const chunks: Buffer[] = [];
    let headerParsed = false;
    let expectedLen = 0;

    conn.on("connect", () => conn.write(frame));

    conn.on("data", (data: Buffer) => {
      chunks.push(data);
      const buf = Buffer.concat(chunks);

      if (!headerParsed && buf.length >= 4) {
        expectedLen = buf.readUInt32BE(0);
        headerParsed = true;
      }

      if (headerParsed && buf.length >= 4 + expectedLen) {
        const respJson = buf.subarray(4, 4 + expectedLen).toString("utf-8");
        conn.destroy();
        try {
          const resp = JSON.parse(respJson) as {
            ok: boolean;
            result?: unknown;
            error?: { code: string; message: string };
          };
          if (resp.ok) {
            resolve({ ok: true, result: resp.result });
          } else {
            const err = resp.error ?? { code: "?", message: "unknown error" };
            resolve({ ok: false, error: `[${err.code}] ${err.message}` });
          }
        } catch (e) {
          resolve({ ok: false, error: `bad response JSON: ${(e as Error).message}` });
        }
      }
    });

    conn.on("error", (err: Error) => {
      resolve({ ok: false, error: `cannot connect to mediator at ${socket}: ${err.message}` });
    });

    conn.setTimeout(310_000, () => {
      conn.destroy();
      resolve({ ok: false, error: "mediator request timed out (5min)" });
    });
  });
}

function result(outcome: { ok: boolean; result?: unknown; error?: string }): PluginToolResult {
  return { content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }] };
}

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS: PluginToolDefinition[] = [
  {
    name: "policy_propose",
    description:
      "Propose a new child policy for operator approval. This is how you acquire " +
      "capabilities (web access, file mounts, etc.). Blocks until approved/denied (5min timeout).\n\n" +
      "TRIFECTA RULE: never combine (1) sensitive data + (2) untrusted input + (3) external egress in one policy.",
    parameters: {
      type: "object",
      properties: {
        config: {
          type: "object",
          description: "Full MediationPolicy. All fields required.",
          properties: {
            policy_name: { type: "string", description: "Unique name (e.g. 'nutrition_fetcher_v1')" },
            rationale: { type: "string", description: "Why needed — shown to operator" },
            http_allowlist: { type: "array", items: { type: "string" }, description: "URL patterns child can reach" },
            external_mounts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, mode: { type: "string" } } } },
            allowed_child_policies: { type: "array", items: { type: "object", properties: { policy_name: { type: "string" }, inherit: { type: "boolean" } } } },
            bind_ports: { description: "[low, high] or null" },
            allowed_ipc_targets: { type: "array", items: { type: "string" }, description: "Use ['init'] to reply to parent" },
            allowed_signal_targets: { type: "array", items: { type: "object", properties: { policy_name: { type: "string" }, signals: { type: "array", items: { type: "string" } } } } },
            allowed_launch_commands: { type: "array", items: { type: "string" }, description: "Glob patterns for allowed fork commands (e.g. 'openclaw agent --local *'). Empty = any command allowed." },
          },
          required: ["policy_name", "rationale", "http_allowlist", "external_mounts", "allowed_child_policies", "allowed_ipc_targets", "allowed_signal_targets"],
        },
      },
      required: ["config"],
    },
    execute: async (_id, params) => result(await callMediator("policy_propose", params)),
  },
  {
    name: "fork_with_policy",
    description: "Fork a child workflow under an approved policy. Spawns the command specified in the `command` field under the child's UID. Returns workflow_id, token, UID.",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "Unique ID for child" },
        policy_name: { type: "string", description: "Approved policy" },
        inherit: { type: "boolean", description: "Inherit parent capabilities (usually false)" },
        command: { type: "array", items: { type: "string" }, description: "Command to run in the child process (e.g. ['openclaw', 'agent', '--local', '-m', 'fetch info']). Must match policy's allowed_launch_commands if set." },
      },
      required: ["workflow_id", "policy_name", "inherit"],
    },
    execute: async (_id, params) => result(await callMediator("fork_with_policy", params)),
  },
  {
    name: "ipc_send",
    description: "Send a one-shot message to another workflow.",
    parameters: {
      type: "object",
      properties: {
        target_workflow_id: { type: "string" },
        message: { description: "Arbitrary JSON payload" },
      },
      required: ["target_workflow_id", "message"],
    },
    execute: async (_id, params) => result(await callMediator("ipc_send", params)),
  },
  {
    name: "mediator_ps",
    description: "List all workflows visible to you.",
    parameters: { type: "object", properties: {} },
    execute: async () => result(await callMediator("ps")),
  },
  {
    name: "policy_list",
    description: "List all approved policies.",
    parameters: { type: "object", properties: {} },
    execute: async () => result(await callMediator("policy_list")),
  },
  {
    name: "policy_get",
    description: "Get details of an approved policy.",
    parameters: {
      type: "object",
      properties: { policy_name: { type: "string" } },
      required: ["policy_name"],
    },
    execute: async (_id, params) => result(await callMediator("policy_get", params)),
  },
  {
    name: "signal_workflow",
    description: "Send a signal (term/kill/stop/cont) to a workflow.",
    parameters: {
      type: "object",
      properties: {
        target_workflow_id: { type: "string" },
        signal: { type: "string", enum: ["term", "kill", "stop", "cont"] },
      },
      required: ["target_workflow_id", "signal"],
    },
    execute: async (_id, params) => result(await callMediator("signal", params)),
  },
  {
    name: "request_port",
    description: "Allocate a port from your policy's bind range.",
    parameters: { type: "object", properties: {} },
    execute: async () => result(await callMediator("request_port")),
  },
  {
    name: "revoke_policy",
    description: "Revoke a policy. hard=true also kills running workflows.",
    parameters: {
      type: "object",
      properties: { policy_name: { type: "string" }, hard: { type: "boolean" } },
      required: ["policy_name", "hard"],
    },
    execute: async (_id, params) => result(await callMediator("revoke_policy", params)),
  },
];

// ── Plugin entry ──────────────────────────────────────────────────────

export default function register(api: PluginApi): void {
  // Only register if the mediator token file exists.
  const tokenFile = process.env["MEDIATOR_TOKEN_FILE"] || DEFAULT_TOKEN_FILE;
  try {
    accessSync(tokenFile);
  } catch {
    api.logger.debug(
      "mediator-tools: token file not found — skipping (mediator daemon may not be running)",
    );
    return;
  }

  let count = 0;
  for (const tool of TOOLS) {
    try {
      api.registerTool(tool);
      count++;
    } catch (err) {
      api.logger.warn(`mediator-tools: failed to register '${tool.name}': ${(err as Error).message}`);
    }
  }

  if (count > 0) {
    api.logger.info(`mediator-tools: registered ${count} syscall tools`);
  }
}
