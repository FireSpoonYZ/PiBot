// From stablyai/orca v1.4.265 (src/main/orcad/browser-providers/chromium/external-chromium-profile-path.ts).
// Copyright (c) 2026 Lovecast Inc. See ./LICENSE.
import { access, readFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
const HOST_ENVIRONMENT = {
  platform: process.platform,
  snapRoots: ["/snap", "/var/lib/snapd/snap"],
  homePath: () => userInfo().homedir
};
async function strictSnapNameUnderRoot(executableTarget, appName, snapRoot) {
  try {
    if (await realpath(join(snapRoot, "bin", appName)) !== executableTarget) {
      return null;
    }
    const snapName = appName.split(".")[0];
    const manifest = parseYaml(
      await readFile(join(snapRoot, snapName, "current", "meta", "snap.yaml"), "utf8")
    );
    const confinement = typeof manifest === "object" && manifest !== null && "confinement" in manifest ? manifest.confinement : void 0;
    return confinement === void 0 || confinement === "strict" ? snapName : null;
  } catch {
    return null;
  }
}
async function strictSnapNameForExecutable(executablePath, environment) {
  if (environment.platform !== "linux") {
    return null;
  }
  let executableTarget;
  try {
    executableTarget = await realpath(executablePath);
  } catch {
    return null;
  }
  const appName = basename(executablePath);
  for (const snapRoot of environment.snapRoots) {
    const snapName = await strictSnapNameUnderRoot(executableTarget, appName, snapRoot);
    if (snapName) {
      return snapName;
    }
  }
  return null;
}
async function hasChromiumUsedProfile(profilePath) {
  try {
    await access(join(profilePath, "Local State"));
    return true;
  } catch {
    return false;
  }
}
async function resolveExternalChromiumProfilePath(executablePath, stateProfilePath, sessionIdentity, environment = HOST_ENVIRONMENT) {
  const snapName = await strictSnapNameForExecutable(executablePath, environment);
  if (!snapName || await hasChromiumUsedProfile(stateProfilePath)) {
    return stateProfilePath;
  }
  return join(environment.homePath(), "snap", snapName, "common", `pibot-browser-${sessionIdentity}`);
}
export {
  resolveExternalChromiumProfilePath
};
