// From stablyai/orca v1.4.265 (src/shared/google/google-console-setup.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
import {
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICE_INFO,
  googleChoices
} from "./google-scopes.js";
const GOOGLE_CONSOLE_ORIGIN = "https://console.cloud.google.com";
function googleConsoleApiIds(choices) {
  return [
    GOOGLE_SERVICE_INFO.contacts.api,
    ...googleChoices(choices).flatMap(
      (choice) => GOOGLE_CHOICE_SERVICES[choice].map((service) => GOOGLE_SERVICE_INFO[service].api)
    )
  ];
}
function consoleUrl(path, params) {
  const url = new URL(path, GOOGLE_CONSOLE_ORIGIN);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
function withGoogleAccount(url, account) {
  if (!account) {
    return url;
  }
  const withAccount = new URL(url);
  withAccount.searchParams.set("authuser", account);
  return withAccount.toString();
}
function googleEnableApisUrl(choices, target = {}) {
  return consoleUrl("/apis/enableflow", {
    apiid: googleConsoleApiIds(choices).join(","),
    project: target.projectId
  });
}
function googleConsoleStepUrl(step, options) {
  const params = { project: options.projectId };
  switch (step) {
    case "project":
      return consoleUrl("/projectcreate", {});
    case "apis":
      return googleEnableApisUrl(options.choices, options);
    case "branding":
      return consoleUrl("/auth/overview", params);
    case "links":
      return consoleUrl("/auth/branding", params);
    case "publish":
      return consoleUrl("/auth/audience", params);
    case "client":
      return consoleUrl("/auth/clients/create", params);
  }
}
const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/;
function readGoogleConsoleAddress(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return { projectId: null, page: "other" };
  }
  const project = url.searchParams.get("project");
  const projectId = project && PROJECT_ID.test(project) ? project : null;
  if (url.hostname === "accounts.google.com") {
    const refused = url.pathname.includes("/signin/rejected") || url.search.includes("disallowed_useragent");
    return { projectId: null, page: refused ? "sign-in-refused" : "other" };
  }
  if (url.origin !== GOOGLE_CONSOLE_ORIGIN) {
    return { projectId: null, page: "other" };
  }
  const path = url.pathname.replace(/\/+$/, "");
  const page = path === "/projectcreate" ? "project-create" : path === "/apis/enableflow" ? "enable-flow" : path.startsWith("/apis/") ? "apis" : path.startsWith("/auth/overview/create") || path.startsWith("/auth/branding") ? "branding-wizard" : path === "/auth/overview" ? "branding-overview" : path === "/auth/audience" ? "audience" : path === "/auth/clients/create" ? "client-create" : "other";
  return { projectId, page };
}
const GOOGLE_CONSOLE_START = { done: [], projectId: null, seen: [] };
function tick(done, step) {
  return done.includes(step) ? [...done] : [...done, step];
}
function advanceGoogleConsole(progress, address) {
  const { page, projectId } = readGoogleConsoleAddress(address);
  const seen = progress.seen.includes(page) ? progress.seen : [...progress.seen, page];
  let done = progress.done;
  if (projectId && page !== "project-create" && seen.includes("project-create")) {
    done = tick(done, "project");
  }
  if (page === "apis" && seen.includes("enable-flow")) {
    done = tick(done, "apis");
  }
  if (page === "branding-overview" && seen.includes("branding-wizard")) {
    done = tick(done, "branding");
  }
  return { done, projectId: projectId ?? progress.projectId, seen };
}
export {
  GOOGLE_CONSOLE_ORIGIN,
  GOOGLE_CONSOLE_START,
  PROJECT_ID,
  advanceGoogleConsole,
  googleConsoleApiIds,
  googleConsoleStepUrl,
  googleEnableApisUrl,
  readGoogleConsoleAddress,
  withGoogleAccount
};
