// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { buildSandboxConfigSyncScript } = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and updates the selected model", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "ollama",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "ollama",
      credentialEnv: "OLLAMA_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OLLAMA_API_KEY"/);
    assert.match(script, /openclaw models set 'ollama\/nemotron-3-nano:30b'/);
    assert.match(script, /cfg\.setdefault\('agents', \{\}\)\.setdefault\('defaults', \{\}\)\.setdefault\('model', \{\}\)\['primary'\]/);
    assert.match(script, /providers_cfg\["ollama"\]/);
    assert.match(script, /"apiKey":"ollama-local"/);
    assert.match(script, /ollama\/nemotron-3-nano:30b/);
    assert.match(script, /^exit$/m);
  });
});
