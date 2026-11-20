/**
 * Bank Profit packet pipeline — explicit enablement switch.
 *
 * The Bank Profit evidence, packet plan, freshness validator and desktop
 * driver were built and tested before any of them could run: the production
 * packet action refused every BANK_PROFIT filing with a hard gate. This module
 * is the single source of truth for that gate so it can be opened for a
 * supervised run without changing what an unconfigured deployment does.
 *
 * Default is OFF. `on` admits a TY2026 Myself Bank-Profit-only packet; every
 * evidence, freshness and desktop guard downstream still applies unchanged.
 *
 * Deliberately NOT combined into one switch with Dividend or Capital Gains:
 * each route keeps its own gate so one can be opened (or rolled back) without
 * touching the other two.
 */
export type BankProfitEnablement = {
  enabled: boolean;
  /** The exact reason the value was accepted/refused, for the packet error. */
  source: "env_on" | "default_off";
};

/**
 * The ambient environment, or an empty record when `process` is not reachable.
 * Packet-action harnesses run the real action inside a `vm` context that does
 * not always expose Node globals; a missing `process` must read as "not set"
 * (blocked) rather than throw and surface as a generic packet failure.
 */
function ambientEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process?.env ? process.env : {};
  } catch {
    return {};
  }
}

/** Reads `TAXROCKET_BANK_PROFIT_PACKET`; only the exact value `on` enables it. */
export function bankProfitEnablement(
  env: Record<string, string | undefined> = ambientEnv(),
): BankProfitEnablement {
  const raw = env?.TAXROCKET_BANK_PROFIT_PACKET;
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return normalized === "on"
    ? { enabled: true, source: "env_on" }
    : { enabled: false, source: "default_off" };
}

/** Convenience wrapper used by the packet action. */
export function isBankProfitPacketEnabled(
  env: Record<string, string | undefined> = ambientEnv(),
): boolean {
  return bankProfitEnablement(env).enabled;
}

/**
 * The versioned envelope name a Bank Profit packet must carry. Kept beside the
 * switch so a flag/contract mismatch is a single grep away.
 */
export const BANK_PROFIT_ENVELOPE_VERSION = "bank-profit-final-tax-v1" as const;
