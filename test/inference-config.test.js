// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_OLLAMA_MODEL,
  INFERENCE_ROUTE_URL,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
} = require("../bin/lib/inference-config");

describe("inference selection config", () => {
  it("maps ollama-local to the sandbox inference route and default model", () => {
    assert.deepEqual(getProviderSelectionConfig("ollama-local"), {
      endpointType: "ollama",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: DEFAULT_OLLAMA_MODEL,
      profile: "ollama",
      credentialEnv: "OLLAMA_API_KEY",
    });
  });

  it("maps nvidia-nim to the sandbox inference route", () => {
    assert.deepEqual(getProviderSelectionConfig("nvidia-nim", "nvidia/nemotron-3-super-120b-a12b"), {
      endpointType: "build",
      endpointUrl: INFERENCE_ROUTE_URL,
      ncpPartner: null,
      model: "nvidia/nemotron-3-super-120b-a12b",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
    });
  });

  it("builds a qualified OpenClaw primary model for ollama-local", () => {
    assert.equal(
      getOpenClawPrimaryModel("ollama-local", "nemotron-3-nano:30b"),
      "ollama/nemotron-3-nano:30b",
    );
  });
});
