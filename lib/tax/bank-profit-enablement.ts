/**
 * Bank Profit packet pipeline — explicit enablement switch.
 *
 * The Bank Profit evidence, packet plan, freshness validator and desktop
 * driver are active by default for TY2026 Myself Bank-Profit-only filings.
 * `TAXROCKET_BANK_PROFIT_PACKET=off` remains available as an explicit kill
 * switch without touching Dividend or Capital Gains. Every evidence,
 * freshness and desktop guard downstream still applies unchanged.
 */
export type BankProfitEnablement = {
  enabled: boolean;
  /** The exact reason the value was accepted/refused, for the packet error. */
  source: "default_on" | "env_on" | "env_off";
};

/**
 * The ambient environment, or an empty record when `process` is not reachable.
 */
function ambientEnv(): Record<string, string | undefined> {
  try {
    return typeof process !== "undefined" && process?.env ? process.env : {};
  } catch {
    return {};
  }
}

/** Reads `TAXROCKET_BANK_PROFIT_PACKET`; enabled by default unless `off`/`false`. */
export function bankProfitEnablement(
  env: Record<string, string | undefined> = ambientEnv(),
): BankProfitEnablement {
  const raw = env?.TAXROCKET_BANK_PROFIT_PACKET;
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "off" || normalized === "false") {
    return { enabled: false, source: "env_off" };
  }
  return normalized === "on"
    ? { enabled: true, source: "env_on" }
    : { enabled: true, source: "default_on" };
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
