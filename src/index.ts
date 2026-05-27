/**
 * @vibecontrols/vibe-plugin-gitops-github
 *
 * GitHub provider plugin. Registers a GitHubProvider implementation under
 * type "gitops" with name "github" in the agent's service registry. The
 * meta plugin (`@vibecontrols/vibe-plugin-gitops`) discovers + dispatches
 * to it.
 *
 * No CLI prerequisites — talks straight to api.github.com over HTTPS.
 */

import {
  BoundLogger,
  createLifecycleHooks,
  ProviderRegistry,
  TelemetryEmitter,
} from "@vibecontrols/plugin-sdk";
import type {
  HostServices,
  ProfileContext,
  VibePlugin,
  VibePluginFactory,
} from "@vibecontrols/plugin-sdk/contract";

import { GitHubProvider } from "./provider.js";

const PLUGIN_NAME = "gitops-github";
const PLUGIN_VERSION = "0.1.0";
const PROVIDER_NAME = "github";

let provider: GitHubProvider | null = null;

export const createPlugin: VibePluginFactory = (
  _ctx: ProfileContext,
): VibePlugin => {
  const telemetry = new TelemetryEmitter(PLUGIN_NAME, PLUGIN_VERSION);

  const lifecycle = createLifecycleHooks({
    name: PLUGIN_NAME,
    telemetryEventName: "gitops.provider.ready",
    onInit: async (hostServices: HostServices) => {
      const log = new BoundLogger(hostServices.logger, PLUGIN_NAME);
      provider = new GitHubProvider(hostServices);
      await provider.init();

      new ProviderRegistry(hostServices).registerProvider(
        "gitops",
        PROVIDER_NAME,
        provider,
      );

      telemetry.emit("gitops.provider.ready", { provider: PROVIDER_NAME });
      log.info("GitHub gitops provider registered");
    },
    onShutdown: async () => {
      provider = null;
    },
  });

  return {
    capabilities: {
      storage: "rw",
      secrets: "rw",
      telemetry: true,
      audit: true,
    },
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "GitHub provider for the GitOps meta plugin. Repo / PR / Actions / Dependabot data over REST+GraphQL v4.",
    tags: ["backend", "provider", "integration"],

    onServerStart: lifecycle.onServerStart,
    onServerStop: lifecycle.onServerStop,
  };
};

export default createPlugin;
export { GitHubProvider } from "./provider.js";
export type * from "./types.js";
