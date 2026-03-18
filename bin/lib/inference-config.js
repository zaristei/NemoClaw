// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const INFERENCE_ROUTE_URL = "https://inference.local/v1";
const DEFAULT_CLOUD_MODEL = "nvidia/nemotron-3-super-120b-a12b";
const DEFAULT_OLLAMA_MODEL = "nemotron-3-nano:30b";

function getProviderSelectionConfig(provider, model) {
  switch (provider) {
    case "nvidia-nim":
      return {
        endpointType: "build",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_CLOUD_MODEL,
        profile: "default",
        credentialEnv: "NVIDIA_API_KEY",
      };
    case "vllm-local":
      return {
        endpointType: "vllm",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || "vllm-local",
        profile: "vllm",
        credentialEnv: "OPENAI_API_KEY",
      };
    case "ollama-local":
      return {
        endpointType: "ollama",
        endpointUrl: INFERENCE_ROUTE_URL,
        ncpPartner: null,
        model: model || DEFAULT_OLLAMA_MODEL,
        profile: "ollama",
        credentialEnv: "OLLAMA_API_KEY",
      };
    default:
      return null;
  }
}

function getOpenClawPrimaryModel(provider, model) {
  switch (provider) {
    case "nvidia-nim":
      return model || DEFAULT_CLOUD_MODEL;
    case "vllm-local":
      return `vllm/${model || "vllm-local"}`;
    case "ollama-local":
      return `ollama/${model || DEFAULT_OLLAMA_MODEL}`;
    default:
      return model || null;
  }
}

module.exports = {
  DEFAULT_CLOUD_MODEL,
  DEFAULT_OLLAMA_MODEL,
  INFERENCE_ROUTE_URL,
  getOpenClawPrimaryModel,
  getProviderSelectionConfig,
};
