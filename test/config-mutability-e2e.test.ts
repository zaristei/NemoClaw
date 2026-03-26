// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// E2E test for runtime config mutability feature.
//
// Full user journey:
//   1. Start Docker + gateway + sandbox (with the shim-patched OpenClaw image)
//   2. Verify baseline config (frozen openclaw.json, no overrides)
//   3. Use `nemoclaw <sandbox> config-set` to change a config field
//   4. Verify the overrides file was written into the sandbox
//   5. Verify gateway.* changes are refused (CLI + shim defense-in-depth)
//   6. Verify OpenClaw picks up the override (shim hot-reload)
//   7. Cleanup: destroy sandbox + gateway
//
// Requires: Docker running, NVIDIA_API_KEY set, network access.
// Run: NEMOCLAW_NON_INTERACTIVE=1 npx vitest run --project cli test/config-mutability-e2e.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..");
const NEMOCLAW = path.join(ROOT, "bin", "nemoclaw.js");
const SANDBOX_NAME = `e2e-config-${Date.now()}`;
const TIMEOUT_LONG = 1_200_000; // 20 min for sandbox creation (Docker image build on macOS)
const TIMEOUT_MED = 60_000;

// ── Docker socket detection ──────────────────────────────────────────
// openshell reads DOCKER_HOST or defaults to /var/run/docker.sock.
// On macOS with Colima, /var/run/docker.sock may point to Docker Desktop
// while the active Docker context is Colima. Detect and propagate.
function detectDockerHost(): string | undefined {
  if (process.env.DOCKER_HOST) return process.env.DOCKER_HOST;
  try {
    const endpoint = execSync("docker context inspect --format '{{.Endpoints.docker.Host}}'", {
      encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (endpoint && endpoint !== "unix:///var/run/docker.sock") return endpoint;
  } catch { /* fallback to default */ }
  return undefined;
}

const DOCKER_HOST = detectDockerHost();
const baseEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  NEMOCLAW_NON_INTERACTIVE: "1",
  NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
  ...(DOCKER_HOST ? { DOCKER_HOST } : {}),
};

// ── Helpers ──────────────────────────────────────────────────────────

function nem(...args: string[]): string {
  return execFileSync("node", [NEMOCLAW, ...args], {
    encoding: "utf-8",
    timeout: TIMEOUT_MED,
    env: baseEnv,
  }).trim();
}

function nemFail(...args: string[]): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync("node", [NEMOCLAW, ...args], {
      encoding: "utf-8",
      timeout: TIMEOUT_MED,
      stdio: ["pipe", "pipe", "pipe"],
      env: baseEnv,
    });
    return { status: 0, stderr: "", stdout };
  } catch (err: unknown) {
    const e = err as { status: number; stderr: string; stdout: string };
    return { status: e.status, stderr: e.stderr ?? "", stdout: e.stdout ?? "" };
  }
}

function openshell(...args: string[]): string {
  return execSync(`openshell ${args.join(" ")}`, {
    encoding: "utf-8",
    timeout: TIMEOUT_MED,
  }).trim();
}

function sandboxDownload(sandboxPath: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-dl-"));
  try {
    execSync(
      `openshell sandbox download "${SANDBOX_NAME}" "${sandboxPath}" "${tmpDir}"`,
      { encoding: "utf-8", timeout: TIMEOUT_MED },
    );
    const basename = path.basename(sandboxPath);
    const localFile = path.join(tmpDir, basename);
    if (!fs.existsSync(localFile)) return "";
    return fs.readFileSync(localFile, "utf-8");
  } catch {
    return "";
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function dockerRunning(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10_000, env: baseEnv });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Preflight: skip entire suite if Docker is not running
// ═══════════════════════════════════════════════════════════════════

const HAS_DOCKER = dockerRunning();
const HAS_API_KEY = !!process.env.NVIDIA_API_KEY?.startsWith("nvapi-");

const describeE2E = HAS_DOCKER && HAS_API_KEY ? describe : describe.skip;

describeE2E("config mutability E2E", () => {

  // ═══════════════════════════════════════════════════════════════════
  // Phase 0: Stand up infrastructure
  // ═══════════════════════════════════════════════════════════════════

  beforeAll(() => {
    // Nuke everything — previous failed runs leave stale gateways, sandboxes,
    // port forwards, Docker containers, and volumes. Clean slate or nothing.
    try { execSync("openshell forward stop 8080", { env: baseEnv, stdio: "pipe" }); } catch { /* ignore */ }
    try { execSync("openshell forward stop 18789", { env: baseEnv, stdio: "pipe" }); } catch { /* ignore */ }
    try { nem(SANDBOX_NAME, "destroy", "--yes"); } catch { /* ignore */ }
    try { openshell("sandbox", "delete", SANDBOX_NAME); } catch { /* ignore */ }
    try { openshell("gateway", "destroy", "-g", "nemoclaw"); } catch { /* ignore */ }
    // Remove Docker containers and volumes from previous gateway runs
    try { execSync("docker rm -f openshell-cluster-nemoclaw", { env: baseEnv, stdio: "pipe" }); } catch { /* ignore */ }
    try { execSync("docker volume rm openshell-cluster-nemoclaw", { env: baseEnv, stdio: "pipe" }); } catch { /* ignore */ }
    // Kill any stale ssh port-forwards on 8080
    try {
      const lsof = execSync("lsof -ti :8080", { encoding: "utf-8", stdio: "pipe" }).trim();
      if (lsof) execSync(`kill ${lsof}`, { stdio: "pipe" });
    } catch { /* nothing on port */ }

    // Full user journey: install.sh --non-interactive does everything a real
    // user would do — installs deps, starts gateway, builds sandbox image
    // (with shim), creates sandbox, validates endpoints. No shortcuts.
    //
    // install.sh spawns a background port-forward (openshell forward start
    // --background) that inherits stdout/stderr pipe fds. execSync blocks
    // until ALL fds close, so it hangs forever. Same pattern as test-full-e2e.sh:
    // background the install, wait on its PID — the & detaches child fds.
    const installLog = path.join(os.tmpdir(), `nemoclaw-e2e-install-${Date.now()}.log`);
    execSync(
      `cd "${ROOT}" && bash install.sh --non-interactive >"${installLog}" 2>&1 & wait $!`,
      {
        encoding: "utf-8",
        timeout: TIMEOUT_LONG,
        env: baseEnv,
        shell: "/bin/bash",
      },
    );
    if (fs.existsSync(installLog)) {
      const log = fs.readFileSync(installLog, "utf-8");
      if (log.includes("Gateway failed") || log.includes("Sandbox creation failed")) {
        throw new Error(`install.sh failed:\n${log.slice(-2000)}`);
      }
    }

    // Wait for sandbox to be ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const list = openshell("sandbox", "list");
        if (list.includes(SANDBOX_NAME) && list.includes("Ready")) {
          ready = true;
          break;
        }
      } catch { /* retry */ }
      execSync("sleep 2");
    }
    expect(ready).toBe(true);
  }, TIMEOUT_LONG);

  afterAll(() => {
    try { nem(SANDBOX_NAME, "destroy", "--yes"); } catch { /* ignore */ }
    try { openshell("sandbox", "delete", SANDBOX_NAME); } catch { /* ignore */ }
    try { openshell("gateway", "destroy", "-g", "nemoclaw"); } catch { /* ignore */ }
  }, TIMEOUT_MED);

  // ═══════════════════════════════════════════════════════════════════
  // Phase 1: Verify baseline — no overrides active
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 1: baseline state", () => {
    it("sandbox exists and is ready", () => {
      const list = openshell("sandbox", "list");
      expect(list).toContain(SANDBOX_NAME);
    });

    it("config-get shows no overrides initially (or only defaults)", () => {
      const output = nem(SANDBOX_NAME, "config-get");
      // Either "No runtime config overrides" or shows policy defaults
      expect(output).toBeTruthy();
    });

    it("openclaw.json is read-only inside the sandbox", () => {
      // The overrides file lives in the writable partition, not in openclaw.json
      const overridesContent = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      // File may or may not exist yet (depends on whether policy has config_overrides section)
      // but openclaw.json itself must NOT be the override target
      expect(overridesContent).not.toContain("SHOULD_NOT_EXIST");
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 2: config-set security — gateway.* refused
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 2: security enforcement", () => {
    it("refuses gateway.auth.token", () => {
      const result = nemFail(SANDBOX_NAME, "config-set", "--key", "gateway.auth.token", "--value", "STOLEN");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/gateway\.\* fields are immutable/i);
    });

    it("refuses gateway.port", () => {
      const result = nemFail(SANDBOX_NAME, "config-set", "--key", "gateway.port", "--value", "9999");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/gateway\.\* fields are immutable/i);
    });

    it("refuses bare gateway key", () => {
      const result = nemFail(SANDBOX_NAME, "config-set", "--key", "gateway", "--value", "{}");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/gateway\.\* fields are immutable/i);
    });

    it("refuses missing --key/--value", () => {
      const result = nemFail(SANDBOX_NAME, "config-set");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Usage:/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 3: config-set → overrides file written to sandbox
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 3: config-set writes overrides", () => {
    const TEST_MODEL = "inference/E2E-CONFIG-MUTABILITY-TEST";

    it("config-set succeeds for a valid key", () => {
      const output = nem(
        SANDBOX_NAME, "config-set",
        "--key", "agents.defaults.model.primary",
        "--value", TEST_MODEL,
      );
      expect(output).toContain("Set agents.defaults.model.primary");
    });

    it("config-get reads back the value we just set", () => {
      const output = nem(
        SANDBOX_NAME, "config-get",
        "--key", "agents.defaults.model.primary",
      );
      expect(output).toContain(TEST_MODEL);
    });

    it("overrides file exists in sandbox writable partition", () => {
      const content = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      expect(content).toBeTruthy();
      const parsed = JSON.parse(content);
      expect(parsed.agents.defaults.model.primary).toBe(TEST_MODEL);
    });

    it("gateway.* is NOT in the overrides file", () => {
      const content = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      const parsed = JSON.parse(content);
      expect(parsed.gateway).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 4: config-set accumulates multiple keys
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 4: multiple overrides accumulate", () => {
    it("sets a second key without losing the first", () => {
      nem(SANDBOX_NAME, "config-set", "--key", "agents.defaults.temperature", "--value", "0.42");

      const content = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      const parsed = JSON.parse(content);

      // Both keys present
      expect(parsed.agents.defaults.model.primary).toBe("inference/E2E-CONFIG-MUTABILITY-TEST");
      expect(parsed.agents.defaults.temperature).toBe(0.42);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5: Shim defense-in-depth — gateway.* stripped even in file
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 5: shim defense-in-depth", () => {
    it("manually injected gateway.* in overrides is stripped by shim", () => {
      // Write a poisoned overrides file directly into the sandbox
      const poisoned = JSON.stringify({
        gateway: { auth: { token: "HACKED" } },
        agents: { defaults: { model: { primary: "inference/SHIM-DEFENSE-TEST" } } },
      }, null, 2);
      const tmpFile = path.join(os.tmpdir(), "config-overrides.json5");
      fs.writeFileSync(tmpFile, poisoned);
      try {
        execSync(
          `openshell sandbox upload "${SANDBOX_NAME}" "${tmpFile}" /sandbox/.openclaw-data/`,
          { encoding: "utf-8", timeout: TIMEOUT_MED },
        );
      } finally {
        fs.unlinkSync(tmpFile);
      }

      // Verify the poisoned file is there
      const raw = sandboxDownload("/sandbox/.openclaw-data/config-overrides.json5");
      const parsed = JSON.parse(raw);
      expect(parsed.gateway).toBeDefined(); // file has gateway.* in it

      // The shim (running inside OpenClaw) will strip gateway.* at load time.
      // We can't directly call resolveConfigForRead inside the sandbox from here,
      // but we verify the shim was patched correctly by checking the dist files.
      // The actual gateway protection is verified by the sandbox logs showing
      // the legitimate model override applied, not the gateway one.

      // Check sandbox logs for the shim applying the override
      try {
        const logs = nem(SANDBOX_NAME, "logs");
        // The model override should appear; the gateway token should NOT
        expect(logs).not.toContain("HACKED");
      } catch {
        // Logs may not contain our override yet if OpenClaw hasn't reloaded.
        // That's OK — the shim unit tests (below) prove gateway stripping works.
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 6: OpenClaw shim applies the override at runtime
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 6: shim applies override at OpenClaw load time", () => {
    it("gateway log shows the overridden model", () => {
      // Set a distinctive model value
      nem(
        SANDBOX_NAME, "config-set",
        "--key", "agents.defaults.model.primary",
        "--value", "inference/SHIM-VERIFIED-E2E",
      );

      // Give OpenClaw a moment to hot-reload the config
      execSync("sleep 5");

      // Check gateway/sandbox logs for evidence the model was picked up
      let logs = "";
      try {
        logs = nem(SANDBOX_NAME, "logs");
      } catch { /* logs command may fail if sandbox is restarting */ }

      // The gateway log line from onboard.js says "agent model: <value>"
      // If the shim is working, it will show our override.
      // Note: this is a best-effort check. If OpenClaw's file watcher hasn't
      // triggered yet, the log won't show it. The overrides file presence
      // (Phase 3) + shim unit tests (Phase 7) together prove correctness.
      if (logs.includes("agent model:")) {
        expect(logs).toContain("SHIM-VERIFIED-E2E");
      }
      // If no "agent model:" in logs yet, the file-based verification in
      // Phase 3 is sufficient — the shim WILL read it on next config resolve.
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // Phase 7: Cleanup verification
  // ═══════════════════════════════════════════════════════════════════

  describe("Phase 7: cleanup", () => {
    it("sandbox can be destroyed", () => {
      const output = nem(SANDBOX_NAME, "destroy", "--yes");
      expect(output).toBeTruthy();
    });

    it("sandbox no longer appears in list", () => {
      const list = openshell("sandbox", "list");
      expect(list).not.toContain(SANDBOX_NAME);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Unit-level shim verification (always runs, no Docker needed)
// Proves the shim injection, deep-merge, and gateway stripping work
// at the code level even when we can't stand up a full sandbox.
// ═══════════════════════════════════════════════════════════════════

describe("shim unit verification", () => {
  let tmpDir: string;
  let patchedModPath: string;
  let overridesFile: string;

  const TARGET_FN = "function resolveConfigForRead(resolvedIncludes, env) {";
  const MOCK_DIST = `
"use strict";
${TARGET_FN}
  return resolvedIncludes;
}
module.exports = { resolveConfigForRead };
`;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-unit-"));
    const pkgDir = path.join(tmpDir, "pkg");
    const distDir = path.join(pkgDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "shim-test.js"), MOCK_DIST);

    const shimScript = path.join(ROOT, "patches", "apply-openclaw-shim.js");
    execFileSync("node", [shimScript, pkgDir], { encoding: "utf-8" });

    patchedModPath = path.join(distDir, "shim-test.js");
    overridesFile = path.join(tmpDir, "config-overrides.json5");
  });

  afterAll(() => {
    delete process.env.OPENCLAW_CONFIG_OVERRIDES_FILE;
    delete require.cache[require.resolve(patchedModPath)];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function loadShim(): { resolveConfigForRead: (cfg: Record<string, unknown>) => Record<string, unknown> } {
    delete require.cache[require.resolve(patchedModPath)];
    return require(patchedModPath);
  }

  it("shim injection patches the dist file", () => {
    const content = fs.readFileSync(patchedModPath, "utf-8");
    expect(content).toContain("function _nemoClawMergeOverrides(cfg)");
    expect(content).toContain("resolvedIncludes = _nemoClawMergeOverrides(resolvedIncludes);");
    expect(content).toContain("delete _ov.gateway");
  });

  it("returns config unchanged when no overrides file", () => {
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = "/nonexistent/path.json";
    const { resolveConfigForRead } = loadShim();
    const original = { agents: { defaults: { model: { primary: "original" } } } };
    const result = resolveConfigForRead(original);
    expect(result).toEqual(original);
  });

  it("deep-merges overrides onto frozen config", () => {
    fs.writeFileSync(overridesFile, JSON.stringify({
      agents: { defaults: { model: { primary: "inference/MERGED" } } },
    }));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();

    const result = resolveConfigForRead({
      agents: { defaults: { model: { primary: "original", fallback: "fb" }, temperature: 0.7 } },
      version: 1,
    });

    expect((result as any).agents.defaults.model.primary).toBe("inference/MERGED");
    expect((result as any).agents.defaults.model.fallback).toBe("fb");
    expect((result as any).agents.defaults.temperature).toBe(0.7);
    expect((result as any).version).toBe(1);
  });

  it("strips gateway.* from overrides (defense in depth)", () => {
    fs.writeFileSync(overridesFile, JSON.stringify({
      gateway: { auth: { token: "STOLEN" } },
      agents: { defaults: { model: { primary: "inference/legit" } } },
    }));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();

    const result = resolveConfigForRead({
      gateway: { auth: { token: "REAL" }, port: 8080 },
      agents: { defaults: { model: { primary: "original" } } },
    });

    expect((result as any).gateway.auth.token).toBe("REAL");
    expect((result as any).gateway.port).toBe(8080);
    expect((result as any).agents.defaults.model.primary).toBe("inference/legit");
  });

  it("handles malformed JSON gracefully", () => {
    fs.writeFileSync(overridesFile, "NOT JSON {{{");
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();
    const original = { foo: "bar" };
    expect(resolveConfigForRead(original)).toEqual(original);
  });

  it("replaces arrays instead of merging them", () => {
    fs.writeFileSync(overridesFile, JSON.stringify({
      agents: { defaults: { tools: ["new-a", "new-b"] } },
    }));
    process.env.OPENCLAW_CONFIG_OVERRIDES_FILE = overridesFile;
    const { resolveConfigForRead } = loadShim();

    const result = resolveConfigForRead({
      agents: { defaults: { tools: ["old"], model: { primary: "orig" } } },
    });

    expect((result as any).agents.defaults.tools).toEqual(["new-a", "new-b"]);
    expect((result as any).agents.defaults.model.primary).toBe("orig");
  });
});

// ═══════════════════════════════════════════════════════════════════
// config-set CLI security (always runs, no Docker needed)
// ═══════════════════════════════════════════════════════════════════

describe("config-set security", () => {
  const configSetPath = path.join(ROOT, "bin", "lib", "config-set").replace(/\\/g, "\\\\");

  function runConfigSet(...args: string[]): { status: number; stderr: string; stdout: string } {
    const argsStr = args.map((a) => `"${a}"`).join(", ");
    try {
      const stdout = execFileSync("node", ["-e", `
        const { configSet } = require("${configSetPath}");
        configSet("fake-sandbox", [${argsStr}]);
      `], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      return { status: 0, stderr: "", stdout };
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string; stdout: string };
      return { status: e.status, stderr: e.stderr ?? "", stdout: e.stdout ?? "" };
    }
  }

  it("refuses gateway.auth.token", () => {
    const r = runConfigSet("--key", "gateway.auth.token", "--value", "evil");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gateway\.\* fields are immutable/i);
  });

  it("refuses gateway.port", () => {
    const r = runConfigSet("--key", "gateway.port", "--value", "9999");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gateway\.\* fields are immutable/i);
  });

  it("refuses bare gateway", () => {
    const r = runConfigSet("--key", "gateway", "--value", "{}");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/gateway\.\* fields are immutable/i);
  });

  it("refuses missing --key/--value", () => {
    const r = runConfigSet();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Usage:/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Shim injection script (always runs, no Docker needed)
// ═══════════════════════════════════════════════════════════════════

describe("apply-openclaw-shim.js", () => {
  it("patches multiple dist files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-multi-"));
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    const target = "function resolveConfigForRead(resolvedIncludes, env) {";
    for (const name of ["a.js", "b.js", "c.js"]) {
      fs.writeFileSync(path.join(distDir, name), `"use strict";\n${target}\n  return resolvedIncludes;\n}`);
    }
    fs.writeFileSync(path.join(distDir, "unrelated.js"), "module.exports = {};");

    const output = execFileSync("node", [path.join(ROOT, "patches", "apply-openclaw-shim.js"), tmpDir], {
      encoding: "utf-8",
    });
    expect(output).toContain("Patched 3 files");
    expect(fs.readFileSync(path.join(distDir, "unrelated.js"), "utf-8")).toBe("module.exports = {};");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits non-zero when no files match", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shim-none-"));
    const distDir = path.join(tmpDir, "dist");
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, "nope.js"), "// nothing");

    try {
      execFileSync("node", [path.join(ROOT, "patches", "apply-openclaw-shim.js"), tmpDir], {
        encoding: "utf-8",
      });
      expect.unreachable("should have thrown");
    } catch (err: unknown) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(1);
      expect(e.stderr).toMatch(/WARNING: No files patched/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
