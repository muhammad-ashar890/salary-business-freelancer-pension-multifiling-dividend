const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const compiled = new Map();

function loadTsModule(relPath, mocks = {}) {
  const cache = new Map();
  function load(name, parent = root) {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    const absolute = name.startsWith("@/")
      ? path.join(root, name.slice(2))
      : name.startsWith(".")
        ? path.resolve(parent, name)
        : null;
    if (!absolute) return require(name);
    const resolved =
      [absolute, `${absolute}.ts`, `${absolute}.tsx`, `${absolute}.js`, path.join(absolute, "index.ts")].find(
        (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile(),
      ) || absolute;
    if (cache.has(resolved)) return cache.get(resolved).exports;
    if (!resolved.endsWith(".ts") && !resolved.endsWith(".tsx")) {
      return require(resolved);
    }
    let outputText = compiled.get(resolved);
    if (!outputText) {
      outputText = ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
        fileName: resolved,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
      compiled.set(resolved, outputText);
    }
    const module = { exports: {} };
    cache.set(resolved, module);
    vm.runInNewContext(
      outputText,
      {
        module,
        exports: module.exports,
        require: (id) => load(id, path.dirname(resolved)),
        __filename: resolved,
        __dirname: path.dirname(resolved),
        process,
        console,
        Buffer,
        URL,
      },
      { filename: resolved },
    );
    return module.exports;
  }
  return load(relPath.startsWith("@/") ? relPath : `@/${relPath}`);
}

const pauseDetailsMod = loadTsModule("lib/tax/fbr-pause-details.ts");

test("readJobPauseDetails sanitizes structured pause payload and caps fields", () => {
  const parsed = pauseDetailsMod.readJobPauseDetails({
    title: "  Existing FBR IRIS Bank Profit figures differ from your packet  ",
    summary: "Summary line",
    tone: "red",
    badge: "Differs",
    rows: [
      {
        code: "64040052",
        label: "Profit on Debt u/s 151",
        irisValue: "Gross: PKR 2,465 | Tax Deducted: PKR 494",
        packetValue: "Not in approved packet",
        status: "missing_in_packet",
      },
      { code: "IGNORED", label: "" },
    ],
    steps: ["Step 1", "   ", "Step 2"],
    safetyNote: "Nothing was saved.",
    requiresFbrAction: false,
  });
  assert.equal(
    parsed.title,
    "Existing FBR IRIS Bank Profit figures differ from your packet",
  );
  assert.equal(parsed.tone, "red");
  assert.equal(parsed.requiresFbrAction, false);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].code, "64040052");
  assert.equal(parsed.rows[0].status, "missing_in_packet");
  assert.deepEqual(parsed.steps, ["Step 1", "Step 2"]);
  assert.equal(pauseDetailsMod.readJobPauseDetails(null), null);
  assert.equal(pauseDetailsMod.readJobPauseDetails({ title: "", summary: "" }), null);
});

test("buildFallbackPauseDetails parses legacy Bank Profit conflict jobs (live DB payload shape)", () => {
  const legacyResult = {
    autofill: {
      bankExistingCheck: {
        ok: false,
        reason:
          "Existing IRIS income differs from your approved Bank Profit filing.",
        conflicts: [
          {
            code: "64040052",
            description:
              "Profit on Debt u/s 151 (Bank / Financial Institution)",
            gross: 2465,
            tax: 494,
            reason: "This IRIS row is not included in the approved packet",
          },
        ],
      },
    },
  };
  const out = pauseDetailsMod.buildFallbackPauseDetails(
    "portal_state_confirmation",
    "Existing IRIS income differs from your approved Bank Profit filing. ...",
    legacyResult,
  );
  assert.equal(
    out.title,
    "Existing FBR IRIS Bank Profit figures differ from your packet",
  );
  assert.equal(out.requiresFbrAction, false);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].code, "64040052");
  assert.equal(out.rows[0].status, "missing_in_packet");
  assert.match(out.rows[0].irisValue, /2,465/);
  assert.match(out.rows[0].irisValue, /494/);

  const fromTextOnly = pauseDetailsMod.buildFallbackPauseDetails(
    "portal_state_confirmation",
    "Existing IRIS income differs from your approved Bank Profit filing. Profit on Debt u/s 151 (Bank) [64040052]: gross 2,465, tax deducted 494 — This IRIS row is not included in the approved packet. No amounts were entered.",
    {},
  );
  assert.equal(fromTextOnly.requiresFbrAction, false);
  assert.equal(fromTextOnly.rows.length, 1);
  assert.equal(fromTextOnly.rows[0].code, "64040052");
  assert.match(fromTextOnly.rows[0].irisValue, /2,465/);
});

test("buildFallbackPauseDetails builds crisp non-FBR and FBR pause guidance across key pause actions", () => {
  const recon = pauseDetailsMod.buildFallbackPauseDetails(
    "portal_reconciliation_review",
    "Gap of PKR 5,000",
    {},
  );
  assert.equal(recon.requiresFbrAction, false);
  assert.match(recon.title, /Wealth reconciliation/i);

  const retry = pauseDetailsMod.buildFallbackPauseDetails(
    "portal_business_retry",
    "Locked grid",
    {},
  );
  assert.equal(retry.requiresFbrAction, false);
  assert.equal(retry.badge, "Retry available");

  const mismatch = pauseDetailsMod.buildFallbackPauseDetails(
    "portal_taxpayer_mismatch",
    "Wrong CNIC",
    {},
  );
  assert.equal(mismatch.tone, "red");
  assert.equal(mismatch.requiresFbrAction, true);

  const autofillOff = pauseDetailsMod.buildFallbackPauseDetails(
    "portal_autofill_off",
    "Autofill off",
    {},
  );
  assert.equal(autofillOff.requiresFbrAction, false);
  assert.match(autofillOff.steps.join(" "), /start-live\.ps1/);
});

test("getLocalAgentJobsAction forwards bank_profit/dividend routes and structured pauseDetails", async () => {
  const fbrJobs = loadTsModule("app/actions/fbr-jobs.ts", {
    "next-auth/next": {
      getServerSession: async () => ({ user: { email: "user@example.com" } }),
    },
    "@/lib/auth": { authOptions: {} },
    "@/app/actions/notifications": { createNotification: async () => {} },
    "@/lib/prisma": {
      prisma: {
        user: { findUnique: async () => ({ id: "u1" }) },
        filingDraft: {
          findFirst: async () => ({ id: "d1", userId: "u1", taxYear: 2026 }),
        },
        localAgentJob: {
          findMany: async () => [
            {
              id: "j1",
              jobType: "tax_assisted_filing",
              status: "awaiting_user_action",
              pauseAction: "portal_state_confirmation",
              pauseMessage: "Raw pause message",
              errorMessage: null,
              createdAt: new Date("2026-11-20T10:00:00Z"),
              startedAt: new Date("2026-11-20T10:01:00Z"),
              completedAt: null,
              resultJson: JSON.stringify({
                pauseDetails: {
                  title: "Existing FBR IRIS Bank Profit figures differ from your packet",
                  summary: "Check your bank certificates.",
                  tone: "amber",
                  badge: "Differs from packet",
                  rows: [
                    {
                      code: "64040052",
                      label: "Profit on Debt u/s 151",
                      irisValue: "Gross: PKR 2,465 | Tax Deducted: PKR 494",
                      packetValue: "Not in approved packet",
                      status: "missing_in_packet",
                    },
                  ],
                  steps: ["Cancel and update TaxRocket."],
                  safetyNote: "No amounts changed.",
                  requiresFbrAction: false,
                },
                handoffScope: {
                  route: {
                    id: "bank_profit",
                    label: "Bank Profit",
                    incomeSources: ["bank_profit"],
                  },
                  salary: "not_applicable",
                  bankProfit: "needs_review",
                  wealthStatement: "pending",
                },
              }),
            },
          ],
        },
      },
    },
  });
  const res = await fbrJobs.getLocalAgentJobsAction("d1");
  assert.equal(res.success, true);
  assert.equal(res.jobs.length, 1);
  assert.deepStrictEqual([...res.jobs[0].handoffScope.route.incomeSources], ["bank_profit"]);
  assert.equal(res.jobs[0].handoffScope.bankProfit, "needs_review");
  assert.equal(res.jobs[0].pauseDetails.requiresFbrAction, false);
  assert.equal(res.jobs[0].pauseDetails.rows[0].code, "64040052");
});

test("fbr-connect-client and fbr-pause-panel preserve existing verification contracts and Bank Profit completion UX", () => {
  const client = fs.readFileSync(
    path.join(__dirname, "../components/tax/fbr-connect-client.tsx"),
    "utf8",
  );
  const panel = fs.readFileSync(
    path.join(__dirname, "../components/tax/fbr-pause-panel.tsx"),
    "utf8",
  );
  assert.equal(
    (client.match(/whitespace-pre-line text-muted-foreground/g) || []).length,
    2,
  );
  assert.match(client, /<FbrAttentionPanel attention=\{activeJob\.attention\} \/>/);
  assert.match(client, /<FbrPausePanel details=\{activeJob\.pauseDetails\} \/>/);
  assert.match(client, /isBankProfitRoute/);
  assert.match(client, /isDividendRoute/);
  assert.match(client, /Bank Profit on Debt \(Other Sources\)/);
  assert.match(client, /Desktop agent connected/);
  assert.match(client, /Desktop agent running/);
  assert.match(client, /FBR window not open/);
  assert.match(client, /Sign in to FBR/);
  assert.match(client, /Reopen FBR window/);
  assert.match(client, /else if \(agentReady \|\| agentDesktopOnline\) phase = "start";/);
  assert.match(client, /How supervised filing works/);
  assert.match(client, /findReadyDevice\(latestDevices\)/);
  const connectSlice = client.slice(
    client.indexOf('{phase === "connect" && ('),
    client.indexOf('{phase === "connecting" && ('),
  );
  assert.equal(connectSlice.includes("Start filing"), false);
  assert.match(connectSlice, /Download for Windows/);
  assert.match(connectSlice, /I installed the FBR connection app/);
  assert.match(connectSlice, /Continue to FBR/);
  const startSlice = client.slice(
    client.indexOf('{phase === "start" && ('),
    client.indexOf('{phase === "working" &&'),
  );
  const splitIdx = startSlice.indexOf("            ) : (\n              <>");
  assert.ok(splitIdx > 0);
  const fbrClosedBranch = startSlice.slice(splitIdx);
  assert.equal(fbrClosedBranch.includes("Start filing"), false);
  assert.equal(fbrClosedBranch.includes("handleStartFiling"), false);
  assert.match(fbrClosedBranch, /Reconnect securely/);
  assert.match(fbrClosedBranch, /Reopen FBR window/);
  assert.match(panel, /In FBR IRIS/);
  assert.match(panel, /In TaxRocket Packet/);
  assert.match(panel, /What to do next/);
});

test("desktop/ready and jobs/next clear stale localFbrConnectedAt when FBR window is closed or disconnected", async () => {
  const { hashToken } = loadTsModule("lib/tax/fbr-desktop.ts");
  const token = "dev-tok-123";
  let currentDevice = {
    id: "dev-1",
    userId: "user-1",
    status: "ACTIVE",
    partitionKey: "pk-1",
    deviceTokenHash: hashToken(token),
    localFbrConnectedAt: new Date("2026-11-20T10:00:00Z"),
    lastSeenAt: new Date("2026-11-20T10:00:00Z"),
  };
  let connectionStatus = "AGENT_CONNECTED";
  let auditEvents = [];
  const nextServerMock = {
    NextRequest: class {},
    NextResponse: {
      json(data, init = {}) {
        return { status: init.status || 200, data };
      },
    },
  };
  const prismaMock = {
    trustedDevice: {
      findUnique: async () => ({ ...currentDevice }),
      update: async ({ data }) => {
        currentDevice = { ...currentDevice, ...data };
        return currentDevice;
      },
    },
    fbrConnection: {
      updateMany: async ({ data }) => {
        connectionStatus = data.status;
        return { count: 1 };
      },
      findMany: async () => [],
      upsert: async () => ({}),
    },
    localAgentJob: {
      findFirst: async () => null,
    },
    taxAuditEvent: {
      findFirst: async () => auditEvents[auditEvents.length - 1] || null,
      create: async ({ data }) => {
        auditEvents.push(data);
        return data;
      },
    },
  };

  const readyRoute = loadTsModule("app/api/fbr-connect/desktop/ready/route.ts", {
    "next/server": nextServerMock,
    "@/lib/prisma": { prisma: prismaMock },
  });
  const jobsNextRoute = loadTsModule("app/api/local-agent/jobs/next/route.ts", {
    "next/server": nextServerMock,
    "@/lib/prisma": { prisma: prismaMock },
  });

  // 1. jobs/next with fbrConnected: false clears stale localFbrConnectedAt
  const nextRes = await jobsNextRoute.POST({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({ fbrConnected: false, fbrWindowOpen: false }),
  });
  assert.equal(nextRes.status, 200);
  assert.equal(currentDevice.localFbrConnectedAt, null);
  assert.equal(connectionStatus, "WAITING_FOR_AGENT");

  // 2. portal_window_opened sets DEVICE_FBR_WINDOW_OPEN while keeping localFbrConnectedAt null
  const openRes = await readyRoute.POST({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({
      connected: false,
      fbrWindowOpen: true,
      reason: "portal_window_opened",
    }),
  });
  assert.equal(openRes.status, 200);
  assert.equal(openRes.data.connected, false);
  assert.equal(openRes.data.fbrWindowOpen, true);
  assert.equal(currentDevice.localFbrConnectedAt, null);
  assert.equal(auditEvents[auditEvents.length - 1].eventType, "DEVICE_FBR_WINDOW_OPEN");

  // 3. Restore ready state, then explicit disconnect via desktop/ready
  currentDevice.localFbrConnectedAt = new Date();
  connectionStatus = "AGENT_CONNECTED";
  const discRes = await readyRoute.POST({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({ connected: false, fbrWindowOpen: false, reason: "portal_window_closed" }),
  });
  assert.equal(discRes.status, 200);
  assert.equal(discRes.data.connected, false);
  assert.equal(discRes.data.fbrWindowOpen, false);
  assert.equal(discRes.data.device.localFbrConnectedAt, null);
  assert.equal(currentDevice.localFbrConnectedAt, null);
  assert.ok(currentDevice.lastSeenAt && !Number.isNaN(new Date(currentDevice.lastSeenAt).getTime()));
  assert.equal(connectionStatus, "WAITING_FOR_AGENT");
  assert.equal(auditEvents[auditEvents.length - 1].eventType, "DEVICE_FBR_DISCONNECTED");

  // 4. agent_quit clears lastSeenAt so Step 1 returns immediately when TR Filing Agent closes
  currentDevice.localFbrConnectedAt = new Date();
  const quitRes = await readyRoute.POST({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({ connected: false, fbrWindowOpen: false, reason: "agent_quit" }),
  });
  assert.equal(quitRes.status, 200);
  assert.equal(currentDevice.localFbrConnectedAt, null);
  assert.equal(currentDevice.lastSeenAt, null);

  // 5. DEVICE_REGISTERED followed by jobs/next (fbrWindowOpen: true) writes DEVICE_FBR_WINDOW_OPEN
  currentDevice.lastSeenAt = new Date();
  auditEvents.push({ eventType: "DEVICE_REGISTERED" });
  const winOpenPollRes = await jobsNextRoute.POST({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({ fbrConnected: false, fbrWindowOpen: true }),
  });
  assert.equal(winOpenPollRes.status, 200);
  assert.equal(auditEvents[auditEvents.length - 1].eventType, "DEVICE_FBR_WINDOW_OPEN");

  // 6. jobs/next with fbrConnected: true self-heals null localFbrConnectedAt
  currentDevice.localFbrConnectedAt = null;
  connectionStatus = "WAITING_FOR_AGENT";
  const healRes = await jobsNextRoute.POST({
    headers: { get: () => `Bearer ${token}` },
    json: async () => ({ fbrConnected: true, fbrWindowOpen: true }),
  });
  assert.equal(healRes.status, 200);
  assert.ok(currentDevice.localFbrConnectedAt);
  assert.equal(connectionStatus, "AGENT_CONNECTED");
});

test("electron main reports live FBR portal status truthfully and auto-captures even when restarted without deep-link token", async () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, "../electron-connect/main.js"),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "main.js",
    mainSrc,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const fns = [
    "hasLivePortalWindow",
    "isFbrPortalLive",
    "loadAgentState",
    "getApiBaseUrl",
    "clearAutoCaptureTimer",
    "scheduleAutoCapture",
    "attemptAutoCapture",
    "isCurrentPortalReadyUrl",
    "isLikelyReadyFbrUrl",
    "markTrustedDeviceReady",
  ]
    .map((name) =>
      ast.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      ),
    )
    .filter(Boolean);
  assert.equal(fns.length, 10);

  let readyCalls = [];
  const ctx = vm.createContext({
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    loginWindow: null,
    workerWindow: null,
    localWorkerRunning: false,
    autoCaptureTimer: null,
    autoCaptureState: { completed: false, inProgress: false },
    trustedDeviceState: {
      deviceAuthToken: "saved-dev-tok",
      apiBaseUrl: "http://127.0.0.1:3000",
    },
    launchState: {
      flow: "fbr",
      token: "",
      apiBaseUrl: "",
      deviceAuthToken: "",
      desktopAuthConfig: { useMockIris: false },
    },
    stateStore: { loadAgentState: () => ({}) },
    irisNavigation: {
      isAllowedPortalUrl: (u) => String(u || "").includes("iris.fbr.gov.pk"),
      probeFrames: async () => ({ frames: [{ authenticated: true }] }),
      isAuthenticated: () => true,
    },
    getTrustedDeviceReadyEndpoint: () => "/api/fbr-connect/desktop/ready",
    captureLoginWindowState: async () => ({ capturedUrl: "https://iris.fbr.gov.pk/Dashboard" }),
    pushStatus: () => {},
    fetch: async (url, init) => {
      readyCalls.push({ url, auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  vm.runInContext(fns.map((n) => n.getText(ast)).join("\n"), ctx);

  // Neither window open -> never live
  assert.equal(ctx.isFbrPortalLive(), false);

  // Login window open on login URL before capture -> not live
  ctx.loginWindow = {
    isDestroyed: () => false,
    webContents: { getURL: () => "https://iris.fbr.gov.pk/login" },
  };
  assert.equal(ctx.isFbrPortalLive(), false);

  // Dashboard URL with restarted agent (empty launchState.token, saved deviceAuthToken) -> auto-captures!
  ctx.loginWindow.webContents.getURL = () =>
    "https://iris.fbr.gov.pk/Dashboard";
  ctx.scheduleAutoCapture("login-detected");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(readyCalls.length, 1);
  assert.equal(readyCalls[0].url, "http://127.0.0.1:3000/api/fbr-connect/desktop/ready");
  assert.equal(readyCalls[0].auth, "Bearer saved-dev-tok");
  assert.equal(ctx.autoCaptureState.completed, true);
  assert.equal(ctx.isFbrPortalLive(), true);

  // Window closed/destroyed -> immediately false
  ctx.loginWindow = null;
  assert.equal(ctx.isFbrPortalLive(), false);

  assert.match(mainSrc, /fbrConnected:\s*isFbrPortalLive\(\)/);
  assert.match(mainSrc, /notifyFbrDisconnected\("portal_window_closed"\)/);
  assert.match(mainSrc, /notifyFbrDisconnected\("portal_window_opened", true\)/);
  assert.match(mainSrc, /notifyFbrDisconnected\("agent_quit", false\)/);
  assert.match(mainSrc, /if \(activeJobProcessing\) \{/);
  assert.doesNotMatch(mainSrc, /if \(localWorkerRunning\) \{\s*pushStatus\(\s*"error",\s*"A filing is already in progress/);
  assert.ok(
    mainSrc.indexOf("const handledDeepLink = deepLink ? applyLaunchUrl(deepLink) : false;") <
      mainSrc.indexOf("if (!handledDeepLink) {\n      startLocalWorkerLoop();"),
  );
});
