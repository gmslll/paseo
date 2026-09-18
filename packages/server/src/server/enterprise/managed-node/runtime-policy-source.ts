import type { Readable } from "node:stream";

import {
  type ManagedRuntimePolicy,
  type ManagedRuntimeStatus,
  managedRuntimeCapabilities,
} from "@getpaseo/protocol/managed-runtimes";

import type { ManagedRuntimeArtifactSource } from "../../managed-runtimes/runtime-installer.js";
import type { ManagedRuntimePolicySource } from "../../managed-runtimes/runtime-manager.js";
import { ManagementPlaneRequestError } from "./management-client.js";

export interface ManagedNodeRuntimeClient {
  refreshRuntimePolicy(): Promise<ManagedRuntimePolicy | null>;
  openRuntimeArtifact(sha256: string): Promise<Readable>;
}

export interface ManagedNodeRuntimeDistribution {
  readonly policySource: ManagedRuntimePolicySource;
  readonly artifactSource: ManagedRuntimeArtifactSource;
  reportStatus(provider: () => Promise<readonly ManagedRuntimeStatus[]>): void;
}

/** Holds the management plane's runtime policy for this node and reports runtime status (ADR-0039). */
export class ManagedNodeRuntimeDistributionState implements ManagedNodeRuntimeDistribution {
  readonly policySource: ManagedRuntimePolicySource;
  readonly artifactSource: ManagedRuntimeArtifactSource;
  private policy: ManagedRuntimePolicy | null = null;
  private statusProvider: (() => Promise<readonly ManagedRuntimeStatus[]>) | null = null;

  constructor(private readonly client: ManagedNodeRuntimeClient) {
    this.policySource = { installSource: "management_plane", current: () => this.policy };
    this.artifactSource = { open: (artifact) => this.client.openRuntimeArtifact(artifact.sha256) };
  }

  async refresh(): Promise<void> {
    try {
      this.policy = await this.client.refreshRuntimePolicy();
    } catch (error) {
      // COMPAT(managedRuntimes): planes before v0.9.0 have no runtime policy route; remove after 2027-03-16.
      if (
        error instanceof ManagementPlaneRequestError &&
        error.status === 404 &&
        error.message === "route not found"
      ) {
        this.policy = null;
        return;
      }
      throw error;
    }
  }

  reportStatus(provider: () => Promise<readonly ManagedRuntimeStatus[]>): void {
    this.statusProvider = provider;
  }

  async capabilities(): Promise<Record<string, string>> {
    return this.statusProvider ? managedRuntimeCapabilities(await this.statusProvider()) : {};
  }
}
