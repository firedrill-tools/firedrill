import type { ToolPackageManifest } from "@firedrill/contracts";
import { startHttpWorldBinding } from "@firedrill/protocol-http";
import type { BoundWorldClient } from "@firedrill/world-kernel";

export const FIREDRILL_CLI_URL = "FIREDRILL_CLI_URL";
export const FIREDRILL_CLI_TOKEN = "FIREDRILL_CLI_TOKEN";

export interface StartCliWorldBindingOptions {
  readonly client: BoundWorldClient;
  readonly tools: readonly ToolPackageManifest[];
  readonly hostname?: "127.0.0.1" | "::1";
  readonly port?: number;
  readonly token?: string;
}

export interface CliWorldBinding {
  readonly kind: "cli";
  readonly baseUrl: string;
  readonly token: string;
  readonly environment: Readonly<Record<string, string>>;
  close(): Promise<void>;
}

/**
 * Exposes a world to the `firedrill world` command. The wire transport is the
 * same loopback HTTP adapter used by HTTP-bound agents; CLI is an invocation
 * shape, not a second implementation of Tool behavior.
 */
export async function startCliWorldBinding(options: StartCliWorldBindingOptions): Promise<CliWorldBinding> {
  const binding = await startHttpWorldBinding(options);
  return {
    kind: "cli",
    baseUrl: binding.baseUrl,
    token: binding.token,
    environment: Object.freeze({
      [FIREDRILL_CLI_URL]: binding.baseUrl,
      [FIREDRILL_CLI_TOKEN]: binding.token,
    }),
    close: () => binding.close(),
  };
}
