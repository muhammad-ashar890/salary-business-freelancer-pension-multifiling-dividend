export type JobPauseRow = {
  code?: string;
  label: string;
  irisValue?: string;
  packetValue?: string;
  status?: "differs" | "missing_in_packet" | "missing_in_iris" | "needs_review";
};

export type JobPauseDetails = {
  title: string;
  summary: string;
  tone: "amber" | "red";
  badge?: string;
  rows: JobPauseRow[];
  steps: string[];
  safetyNote?: string;
  requiresFbrAction: boolean;
};

export function readJobPauseDetails(value: unknown): JobPauseDetails | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (v: unknown, max = 500) =>
    typeof v === "string" ? v.trim().slice(0, max) : "";
  const title = text(raw.title, 200);
  const summary = text(raw.summary, 1000);
  if (!title && !summary) return null;
  const rows: JobPauseRow[] = (Array.isArray(raw.rows) ? raw.rows : [])
    .slice(0, 24)
    .flatMap((entry): JobPauseRow[] => {
      if (!entry || typeof entry !== "object") return [];
      const row = entry as Record<string, unknown>;
      const label = text(row.label, 200);
      if (!label) return [];
      const status = [
        "differs",
        "missing_in_packet",
        "missing_in_iris",
        "needs_review",
      ].includes(String(row.status))
        ? (String(row.status) as JobPauseRow["status"])
        : undefined;
      return [
        {
          ...(text(row.code, 24) ? { code: text(row.code, 24) } : {}),
          label,
          ...(text(row.irisValue, 200)
            ? { irisValue: text(row.irisValue, 200) }
            : {}),
          ...(text(row.packetValue, 200)
            ? { packetValue: text(row.packetValue, 200) }
            : {}),
          ...(status ? { status } : {}),
        },
      ];
    });
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .slice(0, 10)
    .map((s) => text(s, 300))
    .filter(Boolean);
  return {
    title: title || "Action needed",
    summary: summary || title,
    tone: raw.tone === "red" ? "red" : "amber",
    ...(text(raw.badge, 60) ? { badge: text(raw.badge, 60) } : {}),
    rows,
    steps,
    ...(text(raw.safetyNote, 300)
      ? { safetyNote: text(raw.safetyNote, 300) }
      : {}),
    requiresFbrAction: raw.requiresFbrAction !== false,
  };
}

export function buildFallbackPauseDetails(
  pauseAction: string | null,
  pauseMessage: string | null,
  parsedResult: Record<string, unknown>,
): JobPauseDetails | null {
  const action = String(pauseAction || "").trim();
  const msg = String(pauseMessage || "").trim();
  if (!action && !msg) return null;

  const autofillObj =
    parsedResult?.autofill && typeof parsedResult.autofill === "object"
      ? (parsedResult.autofill as Record<string, unknown>)
      : null;
  const existingCheck = (parsedResult?.bankExistingCheck ||
    autofillObj?.bankExistingCheck ||
    parsedResult?.existingIncomeCheck ||
    autofillObj?.existingIncomeCheck) as
    | { reason?: unknown; conflicts?: unknown }
    | undefined;

  if (
    existingCheck &&
    typeof existingCheck === "object" &&
    Array.isArray(existingCheck.conflicts) &&
    existingCheck.conflicts.length > 0
  ) {
    const isBank = Boolean(
      parsedResult?.bankExistingCheck || autofillObj?.bankExistingCheck,
    );
    const fmt = (n: unknown) =>
      Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US") : "0";
    const rows: JobPauseRow[] = existingCheck.conflicts
      .slice(0, 20)
      .map((c: unknown) => {
        const row = (
          c && typeof c === "object" ? c : {}
        ) as Record<string, unknown>;
        const reason = String(row.reason || "");
        return {
          code: String(row.code || "").slice(0, 24) || undefined,
          label: String(row.description || row.code || "Existing row").slice(
            0,
            200,
          ),
          irisValue: `Gross: PKR ${fmt(row.gross)} | Tax Deducted: PKR ${fmt(row.tax)}`,
          packetValue: /not part of|not included/i.test(reason)
            ? "Not in approved packet"
            : "Differs from packet",
          status: /not part of|not included/i.test(reason)
            ? "missing_in_packet"
            : "differs",
        };
      });
    return {
      title: isBank
        ? "Existing FBR IRIS Bank Profit figures differ from your packet"
        : "Existing FBR IRIS Dividend figures differ from your packet",
      summary:
        typeof existingCheck.reason === "string" && existingCheck.reason.trim()
          ? existingCheck.reason.trim().slice(0, 500)
          : "FBR IRIS already holds figures that differ from your approved packet.",
      tone: "amber",
      badge: "Differs from packet",
      rows,
      steps: [
        isBank
          ? "Compare the FBR IRIS figures above against your bank profit certificates (FBR auto-fills bank u/s 165 withholding even in a fresh return)."
          : "Compare the FBR IRIS figures above against your Dividend certificate(s).",
        "Update and approve matching certificates in TaxRocket (never delete genuine income or invent balancing numbers).",
        "Cancel this paused run below and start a fresh FBR autofill once aligned.",
      ],
      safetyNote:
        "No amounts were entered, changed, deleted, saved, or submitted in FBR IRIS.",
      requiresFbrAction: false,
    };
  }

  // Legacy already-persisted Bank Profit / Dividend conflict messages that
  // lacked `pauseDetails` / `bankExistingCheck` on resultJson.
  const legacyConflictMatches = Array.from(
    msg.matchAll(
      /([^.!?\n]+?)\s+\[(\d{6,10})\]:\s*gross\s+([\d,]+),\s*tax deducted\s+([\d,]+)\s*(?:—|-)\s*([^.!?\n]+)\.?/gi,
    ),
  );
  if (legacyConflictMatches.length > 0) {
    const isBank = /bank|profit on debt|640400/i.test(msg);
    const rows: JobPauseRow[] = legacyConflictMatches.map((m) => ({
      code: m[2],
      label: m[1]
        .replace(/^Existing IRIS income differs[^:]*:\s*/i, "")
        .trim(),
      irisValue: `Gross: PKR ${m[3]} | Tax Deducted: PKR ${m[4]}`,
      packetValue: /not part of|not included/i.test(m[5])
        ? "Not in approved packet"
        : "Differs from packet",
      status: /not part of|not included/i.test(m[5])
        ? "missing_in_packet"
        : "differs",
    }));
    const leadSentence =
      msg.match(/^[^.?!]+\./)?.[0]?.trim() ||
      "Existing FBR IRIS figures differ from your approved packet.";
    return {
      title: isBank
        ? "Existing FBR IRIS Bank Profit figures differ from your packet"
        : "Existing FBR IRIS Dividend figures differ from your packet",
      summary: leadSentence,
      tone: "amber",
      badge: "Differs from packet",
      rows,
      steps: [
        isBank
          ? "Compare the FBR IRIS figures above against your bank profit certificates (FBR auto-fills bank u/s 165 withholding even in a fresh return)."
          : "Compare the FBR IRIS figures above against your Dividend certificate(s).",
        "Update and approve matching certificates in TaxRocket (never delete genuine income or invent balancing numbers).",
        "Cancel this paused run below and start a fresh FBR autofill once aligned.",
      ],
      safetyNote:
        "No amounts were entered, changed, deleted, saved, or submitted in FBR IRIS.",
      requiresFbrAction: false,
    };
  }

  const preset: Record<
    string,
    Omit<JobPauseDetails, "rows"> & { rows?: JobPauseRow[] }
  > = {
    portal_reconciliation_review: {
      title: "Resolve Wealth reconciliation in TaxRocket first",
      summary:
        msg ||
        "Your TaxRocket filing still has an unresolved reconciliation gap.",
      tone: "amber",
      badge: "Reconciliation pending",
      steps: [
        "Open the Wealth / Reconciliation step in TaxRocket and resolve the difference so it becomes PKR 0.",
        "Approve a fresh packet and start FBR filing again.",
      ],
      safetyNote: "No portal action was taken in FBR IRIS.",
      requiresFbrAction: false,
    },
    missing_residency_context: {
      title: "Select Resident or Non-Resident before starting",
      summary: msg || "Your filing packet is missing a residency status.",
      tone: "amber",
      badge: "Missing context",
      steps: [
        "Open your filing in TaxRocket and select Resident or Non-Resident.",
        "Approve a fresh packet and start FBR filing again.",
      ],
      safetyNote: "No portal action was taken in FBR IRIS.",
      requiresFbrAction: false,
    },
    portal_business_retry: {
      title: "Business grid stayed locked in FBR IRIS",
      summary:
        msg ||
        "One or more business figures stayed read-only while IRIS was loading.",
      tone: "amber",
      badge: "Retry available",
      steps: [
        "Wait a few seconds for IRIS to finish loading or calculating in the FBR window.",
        "Click Retry automatic filing below (no manual entry or confirmation checkbox is needed).",
      ],
      safetyNote:
        "Locked controls are never bypassed. Nothing was saved or submitted.",
      requiresFbrAction: false,
    },
    portal_expense_retry: {
      title: "Personal expense row was not ready in IRIS",
      summary:
        msg ||
        "A pop-up or slow IRIS load blocked entering a supported personal-expense row.",
      tone: "amber",
      badge: "Retry available",
      steps: [
        "Close any open pop-up in the FBR window and let IRIS finish loading.",
        "Click Retry automatic filing below.",
      ],
      safetyNote: "Nothing was saved, submitted, calculated, or paid.",
      requiresFbrAction: false,
    },
    portal_autofill_off: {
      title: "Desktop agent is running in view-only mode",
      summary:
        msg ||
        "Autofill is switched off in this desktop agent process, so no figures were entered.",
      tone: "amber",
      badge: "Autofill off",
      steps: [
        "Close the TaxRocket Desktop Agent window.",
        "Start it again using start-live.ps1 in the electron-connect folder.",
        "Click Continue below once reconnected.",
      ],
      safetyNote: "Nothing was entered, saved, submitted, calculated, or paid.",
      requiresFbrAction: false,
    },
    portal_taxpayer_mismatch: {
      title: "FBR taxpayer does not match this filing",
      summary:
        msg ||
        "The signed-in CNIC / NTN in FBR IRIS does not match this TaxRocket filing.",
      tone: "red",
      badge: "Taxpayer mismatch",
      steps: [
        "Check the signed-in account in the open FBR window.",
        "Log in with the matching FBR taxpayer account, or cancel and switch filing in TaxRocket.",
      ],
      safetyNote: "No tax values were entered, changed, saved, or submitted.",
      requiresFbrAction: true,
    },
    portal_document_mismatch: {
      title: "Open FBR return does not match this filing",
      summary:
        msg ||
        "The open return in FBR does not match the expected 114(1) form, full-year period, or tax year.",
      tone: "red",
      badge: "Return mismatch",
      steps: [
        "Open the intended Original / Normal 114(1) return for this Tax Year in the FBR window.",
        "Choose Continue below once the right draft return is open.",
      ],
      safetyNote: "No tax values were entered, changed, saved, or submitted.",
      requiresFbrAction: true,
    },
    portal_economic_transactions_gate: {
      title: "Complete FBR return setup questions",
      summary:
        msg ||
        "FBR IRIS is waiting for you to select your income sources and residency status.",
      tone: "amber",
      badge: "Setup question",
      steps: [
        "Select the expected income source(s) and residency option described above in the FBR window.",
        "Choose Continue filing below (do not submit the return).",
      ],
      safetyNote: "Nothing was submitted.",
      requiresFbrAction: true,
    },
    portal_popup: {
      title: "Close or complete the open dialog in FBR",
      summary: msg || "An open dialog or prompt in FBR is blocking progress.",
      tone: "amber",
      badge: "Dialog open",
      steps: [
        "Complete any OTP / CAPTCHA / verification prompt in the FBR window, or close/cancel the dialog.",
        "Choose Continue below once the return screen is clear.",
      ],
      safetyNote: "The agent never bypasses protected dialogs.",
      requiresFbrAction: true,
    },
    portal_employer_review: {
      title: "Add employer details in FBR before autofill",
      summary:
        msg ||
        "An employer could not be matched automatically by exact registered name.",
      tone: "amber",
      badge: "Employer needed",
      steps: [
        "In the FBR window, open Employment > Salary > Add Employer Details and add the employer.",
        "Tick the confirmation box below and click Continue.",
      ],
      safetyNote:
        "No salary or wealth figures were entered, saved, or submitted.",
      requiresFbrAction: true,
    },
    portal_handoff_review: {
      title: "Review the rest of your return in FBR",
      summary:
        msg ||
        "Approved fields were handled; review the remaining sections directly in FBR.",
      tone: "amber",
      badge: "Final check",
      steps: [
        "Review Property, Payments, Computations, and Wealth reconciliation in FBR.",
        "Tick the confirmation box below and click Continue when ready.",
      ],
      safetyNote: "Nothing was submitted or paid.",
      requiresFbrAction: true,
    },
    portal_unsupported_route: {
      title: "Unsupported FBR return form",
      summary:
        msg || "This return type is not supported for automated entry yet.",
      tone: "red",
      badge: "Unsupported form",
      steps: [
        "Cancel this run below and review your filing route in TaxRocket.",
      ],
      safetyNote: "No return was opened or changed in FBR.",
      requiresFbrAction: false,
    },
    session_reconnect: {
      title: "Sign in to FBR IRIS to continue",
      summary: msg || "FBR IRIS session expired or sign-in is required.",
      tone: "amber",
      badge: "Sign-in needed",
      steps: [
        "Sign in to FBR IRIS in the open window.",
        "Choose Continue below once logged in.",
      ],
      safetyNote: "Nothing was changed in FBR.",
      requiresFbrAction: true,
    },
    otp_captcha_pin: {
      title: "Complete verification in FBR",
      summary: msg || "Enter the OTP, CAPTCHA, or PIN in the FBR window.",
      tone: "amber",
      badge: "Verification needed",
      steps: [
        "Complete the OTP / CAPTCHA / PIN prompt in the FBR window.",
        "Click Continue below once done.",
      ],
      safetyNote:
        "Sensitive codes stay inside FBR and are never sent to TaxRocket.",
      requiresFbrAction: true,
    },
    payment_psid: {
      title: "Tax payment / PSID step in FBR",
      summary: msg || "Complete or verify PSID payment directly in FBR.",
      tone: "amber",
      badge: "Payment step",
      steps: [
        "Follow the PSID / payment step in the FBR window if tax is payable.",
        "Click Continue below when ready.",
      ],
      safetyNote: "TaxRocket never initiates payments automatically.",
      requiresFbrAction: true,
    },
  };

  if (preset[action]) {
    return {
      rows: [],
      ...preset[action],
    };
  }

  if (action === "portal_state_confirmation") {
    const packetRefused =
      /packet refused|unexpected schedules|missing required evidence|Regenerate and approve/i.test(
        msg,
      );
    return {
      title: packetRefused
        ? "Approved packet check failed"
        : "Action needed before FBR entry",
      summary: msg || "The filing run paused to keep your FBR return safe.",
      tone: packetRefused ? "red" : "amber",
      badge: packetRefused ? "Packet check failed" : "Needs confirmation",
      rows: [],
      steps: packetRefused
        ? [
            "Open Documents & Review in TaxRocket and approve a fresh packet.",
            "Cancel this paused run below and start a fresh FBR autofill.",
          ]
        : [
            "Check the message above and verify the open FBR return window.",
            "Choose Continue below or cancel this run if you need to update TaxRocket first.",
          ],
      safetyNote:
        "No amounts were entered, changed, deleted, saved, or submitted in FBR IRIS.",
      requiresFbrAction: !packetRefused,
    };
  }

  return {
    title: "Action needed in FBR",
    summary: msg || "The filing run paused and needs your review.",
    tone: "amber",
    badge: "Paused",
    rows: [],
    steps: [
      "Check the message above and review the open FBR window.",
      "Click Continue below when ready, or cancel this run.",
    ],
    requiresFbrAction: true,
  };
}
