import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { JobPauseDetails } from "@/lib/tax/fbr-pause-details";

const ROW_STATUS_BADGE: Record<
  NonNullable<JobPauseDetails["rows"][number]["status"]>,
  { label: string; className: string }
> = {
  differs: {
    label: "Differs",
    className: "border-red-200 bg-red-50 text-red-800",
  },
  missing_in_packet: {
    label: "Not in packet",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
  missing_in_iris: {
    label: "Not yet in FBR",
    className: "border-slate-200 bg-slate-50 text-slate-700",
  },
  needs_review: {
    label: "Needs review",
    className: "border-amber-200 bg-amber-50 text-amber-800",
  },
};

export function FbrPausePanel({
  details,
}: Readonly<{ details: JobPauseDetails }>) {
  const isRed = details.tone === "red";
  return (
    <div className="space-y-4">
      <div
        className={`flex items-start gap-3 rounded-lg border p-3 ${
          isRed
            ? "border-red-200 bg-red-50/50"
            : "border-amber-200 bg-amber-50/40"
        }`}
      >
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            isRed ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
          }`}
        >
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">
              {details.title}
            </p>
            {details.badge && (
              <span
                className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  isRed
                    ? "border-red-200 bg-red-100/70 text-red-800"
                    : "border-amber-300 bg-amber-100/70 text-amber-900"
                }`}
              >
                {details.badge}
              </span>
            )}
          </div>
          {details.summary && details.summary !== details.title && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {details.summary}
            </p>
          )}
        </div>
      </div>

      {details.rows.length > 0 && (
        <ul className="space-y-2.5">
          {details.rows.map((row, idx) => {
            const badge = row.status ? ROW_STATUS_BADGE[row.status] : null;
            return (
              <li
                key={`${row.code || row.label}-${idx}`}
                className="rounded-lg border bg-background p-3 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground">
                    {row.code ? (
                      <span className="mr-1.5 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {row.code}
                      </span>
                    ) : null}
                    {row.label}
                  </p>
                  {badge && (
                    <span
                      className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                  )}
                </div>
                {(row.irisValue || row.packetValue) && (
                  <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    {row.irisValue && (
                      <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                        <dt className="font-medium text-muted-foreground">
                          In FBR IRIS
                        </dt>
                        <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                          {row.irisValue}
                        </dd>
                      </div>
                    )}
                    {row.packetValue && (
                      <div className="rounded-md bg-muted/40 px-2.5 py-1.5">
                        <dt className="font-medium text-muted-foreground">
                          In TaxRocket Packet
                        </dt>
                        <dd className="mt-0.5 font-medium tabular-nums text-foreground">
                          {row.packetValue}
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {details.steps.length > 0 && (
        <div className="rounded-lg border bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What to do next
          </p>
          <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-foreground">
            {details.steps.map((step, idx) => (
              <li key={idx}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      {details.safetyNote && (
        <p className="flex items-start gap-2 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
          <ShieldCheck
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-700"
            aria-hidden="true"
          />
          <span>{details.safetyNote}</span>
        </p>
      )}
    </div>
  );
}
