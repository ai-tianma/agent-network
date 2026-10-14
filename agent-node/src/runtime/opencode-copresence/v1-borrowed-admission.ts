import { randomBytes } from "node:crypto";
import { loadV1HostRegistry, type V1HostExpectation } from "./v1-host-registry";
import { createV1SharedReadClient, validateV1SharedBinding, type V1SharedSessionBinding } from "./v1-shared-read";
import { openV1ScopedCommhubMcp } from "./v1-scoped-mcp";
import { fetchOpenCodeJson } from "./http";
import { OPENCODE_DEFAULT_DISABLED_TOOLS } from "../../shared/opencode-preset";
import type { PinnedOpencodeBinaryAttestation } from "../opencode-acp/binary";

export class V1BorrowedAdmissionError extends Error {
  readonly code = "opencode_v1_borrowed_admission_refused";
  constructor(reason: string) { super(`OpenCode V1 borrowed admission refused: ${reason}`); this.name = "V1BorrowedAdmissionError"; }
}
function refuse(reason: string): never { throw new V1BorrowedAdmissionError(reason); }
export interface V1BorrowedAdmissionOptions {
  readonly mode: "borrowed-v1";
  readonly hostRoot: string;
  /** Independent Owner-selected expectation, not populated from this registry. */
  readonly expectedHost: V1HostExpectation;
  readonly attestation: PinnedOpencodeBinaryAttestation;
  readonly expectedBinding: V1SharedSessionBinding;
  readonly readBinding: () => V1SharedSessionBinding;
  /** Explicit equivalent-policy/provider cohort selection; not credential isolation. */
  readonly selectedCohortId: string;
  readonly model: { readonly providerID: string; readonly modelID: string };
  readonly stateRoot: string;
  readonly alias: string;
  readonly hubMcpUrl: string;
  readonly hubToken: string;
}

/** Lifecycle admission only. No Server spawn/stop, session create/fork/latest,
 * prompt, abort, dispose or TUI ownership. Runtime/CLI and turn integration are
 * still separate; this handle proves a scoped MCP connection, not a whole Node. */
export async function openV1BorrowedAdmission(options: V1BorrowedAdmissionOptions) {
  if (options.mode !== "borrowed-v1") refuse("explicit borrowed mode required");
  const host = Object.freeze({ ...options.expectedHost });
  const binding = Object.freeze({ ...options.expectedBinding });
  const model = Object.freeze({ ...options.model });
  const hostRoot = options.hostRoot, attestation = options.attestation;
  const readBinding = options.readBinding;
  if (!options.selectedCohortId || options.selectedCohortId !== host.cohortId) refuse("unselected or mismatched trust cohort");
  if (!model.providerID || !model.modelID || model.providerID.includes("/") || model.modelID.includes("/")) refuse("exact per-node model required");
  const readServer = () => loadV1HostRegistry(hostRoot, host, attestation).server;
  validateV1SharedBinding(binding, readBinding());
  const initialServer = readServer();
  if (initialServer.identity !== binding.serverIdentity) refuse("binding is not this Host incarnation");
  const reader = () => createV1SharedReadClient(readServer(), binding, readBinding());
  await reader().readSession(); // Native initial config annotation precedes backup.
  async function scoped(path: string, method = "GET", body?: unknown) {
    validateV1SharedBinding(binding, readBinding());
    const server = readServer();
    const value = await fetchOpenCodeJson(server.url, server.password, path, { method,
      headers: { "x-opencode-directory": encodeURIComponent(binding.directory) }, redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    validateV1SharedBinding(binding, readBinding()); readServer();
    return value;
  }
  async function policy() {
    const config = await scoped("/config");
    if (config?.model !== `${model.providerID}/${model.modelID}` || !config.provider?.[model.providerID]?.models?.[model.modelID]) refuse("model/provider selection mismatch");
    if (config.permission?.["*"] === "deny" || config.permission?.["commhub_*"] !== "allow") refuse("Host is not selected for scoped CommHub MCP");
    for (const tool of OPENCODE_DEFAULT_DISABLED_TOOLS) {
      if (config.tools?.[tool] !== false || config.permission?.[tool] !== "deny") refuse("built-in policy mismatch");
    }
    if (config.permission?.external_directory !== "deny") refuse("external directory policy mismatch");
  }
  await policy();
  const before = await scoped("/mcp");
  if (!before || typeof before !== "object" || Array.isArray(before)) refuse("unreadable native MCP state");
  for (const [name, value] of Object.entries(before) as [string, any][]) {
    if ((name === "commhub" || name.startsWith("commhub_")) && value?.status !== "disabled") refuse("existing or unknown native CommHub registration");
  }
  // Native /mcp status identifies the name, not a trustworthy remote URL. A new
  // unpredictable reserved name plus exclusive directory/config lease is this
  // cooperative cohort's registration authority; never disconnect bare commhub.
  const mcpName = `commhub_${randomBytes(16).toString("hex")}`;
  const proxy = await openV1ScopedCommhubMcp({ expected: binding, readBinding, readServer,
    alias: options.alias, hubMcpUrl: options.hubMcpUrl, hubToken: options.hubToken,
    stateRoot: options.stateRoot, registrationName: mcpName });
  let maybeRegistered = false, admitted = false;
  let closePromise: Promise<void> | undefined;
  async function nativeStatus() {
    await proxy.verify();
    const state = await scoped("/mcp");
    const status = state?.[mcpName]?.status;
    if (typeof status !== "string") refuse("native registration missing/unknown; retain recovery");
    return status;
  }
  async function close() {
    return closePromise ??= (async () => {
      admitted = false;
      try {
        if (maybeRegistered) {
          const status = await nativeStatus();
          if (status === "connected") {
            await proxy.verify();
            await scoped(`/mcp/${encodeURIComponent(mcpName)}/disconnect`, "POST");
            if (await nativeStatus() !== "disabled") refuse("native disconnect unconfirmed; retain recovery");
          } else if (status !== "disabled") { refuse("native registration unknown; retain recovery"); }
        }
        await proxy.close();
      } catch {
        // Unknown native completion must not release the directory or restore
        // over edited config. Revoke only this proxy; keep all recovery files.
        await proxy.revoke(); refuse("MCP cleanup incomplete; capability revoked, recovery retained");
      }
    })();
  }
  try {
    await proxy.verify(); maybeRegistered = true; // Set before potentially ambiguous write.
    const state = await scoped("/mcp", "POST", { name: mcpName, config: proxy.mcpConfig });
    if (state?.[mcpName]?.status !== "connected" || await nativeStatus() !== "connected") refuse("scoped MCP did not connect");
    await policy(); await proxy.verify(); admitted = true;
  } catch {
    await close(); refuse("startup not admitted; no retry or Host fallback");
  }
  return Object.freeze({ binding, mcpName, model,
    get isAdmitted() { return admitted; },
    async verifyReady() {
      if (!admitted) refuse("borrowed admission closed");
      if (await nativeStatus() !== "connected") refuse("native MCP no longer connected");
      await policy(); return Object.freeze({ state: "mcp-connected" as const, binding, mcpName, model });
    },
    async readSession() { if (!admitted) refuse("borrowed admission closed"); await proxy.verify(); return reader().readSession(); },
    async readMessages() { if (!admitted) refuse("borrowed admission closed"); await proxy.verify(); return reader().readMessages(); },
    close,
  });
}
