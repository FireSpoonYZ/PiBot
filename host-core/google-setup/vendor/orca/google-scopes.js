// From stablyai/orca v1.4.265 (src/shared/google/google-scopes.ts).
// Copyright (c) 2026 Lovecast Inc. See ../../LICENSE-ORCA-MIT.txt.
const GOOGLE_SERVICES = ["gmail", "calendar", "drive", "docs", "sheets", "contacts"];
const GOOGLE_SERVICE_CHOICES = ["gmail", "calendar", "files"];
const SCOPE = "https://www.googleapis.com/auth/";
const GOOGLE_SERVICE_INFO = {
  // gmail.modify covers read, draft, send, labels and archive.
  gmail: { label: "Gmail", scopes: [`${SCOPE}gmail.modify`], api: "gmail.googleapis.com" },
  calendar: {
    label: "Calendar",
    // calendarlist.readonly: which calendars there are, their names and time zones;
    // events.freebusy: when other people are busy, for suggest-time.
    scopes: [
      `${SCOPE}calendar.events`,
      `${SCOPE}calendar.calendarlist.readonly`,
      `${SCOPE}calendar.events.freebusy`
    ],
    api: "calendar-json.googleapis.com"
  },
  drive: { label: "Drive", scopes: [`${SCOPE}drive`], api: "drive.googleapis.com" },
  docs: { label: "Docs", scopes: [`${SCOPE}documents`], api: "docs.googleapis.com" },
  sheets: { label: "Sheets", scopes: [`${SCOPE}spreadsheets`], api: "sheets.googleapis.com" },
  // Name lookup, read-only: the person's contacts, people they emailed, and the company directory.
  contacts: {
    label: "Contacts",
    scopes: [
      `${SCOPE}contacts.readonly`,
      `${SCOPE}contacts.other.readonly`,
      `${SCOPE}directory.readonly`
    ],
    api: "people.googleapis.com"
  }
};
const GOOGLE_CHOICE_SERVICES = {
  gmail: ["gmail"],
  calendar: ["calendar"],
  files: ["drive", "docs", "sheets"]
};
const servicesScopes = (services) => services.flatMap((service) => GOOGLE_SERVICE_INFO[service].scopes);
const GOOGLE_BASE_SCOPES = [
  "openid",
  "email",
  ...servicesScopes(["contacts"])
];
function googleChoices(choices) {
  const picked = new Set(choices);
  return GOOGLE_SERVICE_CHOICES.filter((choice) => picked.has(choice));
}
function googleSignInScopes(choices) {
  return [
    ...GOOGLE_BASE_SCOPES,
    ...googleChoices(choices).flatMap((choice) => servicesScopes(GOOGLE_CHOICE_SERVICES[choice]))
  ];
}
function grantedGoogleChoices(scopes) {
  const granted = new Set(scopes);
  return GOOGLE_SERVICE_CHOICES.filter(
    (choice) => servicesScopes(GOOGLE_CHOICE_SERVICES[choice]).every((scope) => granted.has(scope))
  );
}
function googleChoiceServices(choices) {
  const services = /* @__PURE__ */ new Set([
    "contacts",
    ...googleChoices(choices).flatMap((choice) => GOOGLE_CHOICE_SERVICES[choice])
  ]);
  return GOOGLE_SERVICES.filter((service) => services.has(service));
}
function googleApiEnableUrl(service, projectId) {
  const url = new URL(
    `https://console.cloud.google.com/apis/library/${GOOGLE_SERVICE_INFO[service].api}`
  );
  if (projectId) {
    url.searchParams.set("project", projectId);
  }
  return url.toString();
}
export {
  GOOGLE_BASE_SCOPES,
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICES,
  GOOGLE_SERVICE_CHOICES,
  GOOGLE_SERVICE_INFO,
  googleApiEnableUrl,
  googleChoiceServices,
  googleChoices,
  googleSignInScopes,
  grantedGoogleChoices
};
