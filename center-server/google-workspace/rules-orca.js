/*
 * Trigger logic, Gmail history, Calendar syncToken/upcoming schedule, RFC 5322 address parsing,
 * DMARC verification, and matching algorithms adapted from stablyai/orca@e64e561738d8d465ab459e7e3f9e46d08b6396ea (v1.4.265).
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const GOOGLE_EVENT_SOURCES = Object.freeze(['gmail', 'calendar']);
export const MAX_FILTER_LENGTH = 200;
export const MAX_ADDRESSES = 10;
export const MAX_MINUTES_BEFORE = 24 * 60;

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

export const MAX_NEW_MAIL_PER_CHECK = 50;
export const MAX_HISTORY_PAGES = 5;
export const MESSAGE_READS_AT_ONCE = 10;
export const IGNORED_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT']);

export const MAX_SEED_PAGES = 40;
export const MAX_SCHEDULE_PAGES = 4;

export const SCHEDULE_MAX_AGE_MS = 30 * 60_000;
export const SEED_RETRY_MS = 60 * 60_000;
export const MAX_BACKOFF_MS = 30 * 60_000;
export const RATE_LIMIT_BACKOFF_MS = 60_000;
export const ERROR_BACKOFF_MS = 5 * 60_000;
export const MAX_REMEMBERED_FIRES = 500;
export const DEFAULT_TICK_MS = 60_000;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
      if (name.startsWith('#')) {
        const code = name[1]?.toLowerCase() === 'x'
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : '';
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Address headers per RFC 5322: display names may be quoted (with \-escapes) and hold commas, @ and
// <; (comments) and <angle-addrs> may hold commas too. Only the angle-addr, or a bare address, is real.
function scanAddressHeader(text, at) {
  let outside = '';
  let lastAngle = null;
  let angle = null;
  let quoted = false;
  let comment = 0;
  let blank = true;
  const keep = (part) => {
    if (angle === null) {
      outside += part;
    } else {
      angle += part;
    }
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (comment === 0 && char !== '(' && char.trim()) {
      blank = false;
    }
    if (comment > 0) {
      if (char === '\\') {
        i += 1;
      } else {
        comment += char === '(' ? 1 : char === ')' ? -1 : 0;
      }
    } else if (quoted) {
      if (char === '\\') {
        keep(text.slice(i, i + 2));
        i += 1;
      } else {
        keep(char);
        quoted = char !== '"';
      }
    } else if (char === '(') {
      comment = 1;
    } else if (char === '"') {
      quoted = true;
      keep(char);
    } else if (angle !== null) {
      if (char === '>') {
        lastAngle = angle;
        angle = null;
      } else {
        angle += char;
      }
    } else if (char === '<') {
      angle = '';
    } else {
      outside += char;
      at?.(i);
    }
  }
  return { outside, lastAngle, blank, unclosed: quoted || comment > 0 || angle !== null };
}

/** A comma-separated address list, commas inside quoted names kept: `"Lee, Kim" <lk@x.com>, a@x.com`. */
export function splitAddresses(header) {
  const text = header ?? '';
  const entries = [];
  let start = 0;
  scanAddressHeader(text, (index) => {
    if (text[index] === ',') {
      entries.push(text.slice(start, index));
      start = index + 1;
    }
  });
  entries.push(text.slice(start));
  return entries.map(entry => entry.trim()).filter(entry => !scanAddressHeader(entry).blank);
}

/**
 * One mailbox's real address, lowercased: inside its last `<...>`, else the bare address. Never
 * from the display name, so `"boss@x.com" <eve@x.com>` is eve@x.com.
 */
export function mailboxAddress(entry) {
  const { outside, lastAngle, unclosed } = scanAddressHeader(entry);
  if (unclosed) return null;
  const raw = lastAngle ?? outside.replace(/;\s*$/, '');
  const address = raw
    .slice(raw.lastIndexOf(':') + 1)
    .trim()
    .toLowerCase();
  return /^[^\s@]+@[^\s@"]+$/.test(address) ? address : null;
}

/** The real addresses in an address header, lowercased. */
export function mailboxAddresses(header) {
  return splitAddresses(header).flatMap((entry) => {
    const addr = mailboxAddress(entry);
    return addr ? [addr] : [];
  });
}

export function isGoogleTrigger(trigger) {
  return Boolean(trigger && (trigger.source === 'gmail' || trigger.source === 'calendar'));
}

export function assertGoogleTrigger(trigger) {
  if (!isGoogleTrigger(trigger)) {
    throw Object.assign(new Error('Unsupported Google trigger source.'), { code: 'INVALID_ARGUMENT' });
  }
  const texts = trigger.source === 'gmail'
    ? [
      trigger.account,
      trigger.subjectContains,
      trigger.label,
      ...(trigger.from ?? []),
      ...(trigger.to ?? []),
    ]
    : [trigger.account, trigger.calendar];
  if (
    texts.some(text => (text?.length ?? 0) > MAX_FILTER_LENGTH) ||
    (trigger.source === 'gmail' &&
      ((trigger.from?.length ?? 0) > MAX_ADDRESSES || (trigger.to?.length ?? 0) > MAX_ADDRESSES))
  ) {
    throw Object.assign(
      new Error(`The ${trigger.source}.${trigger.event} trigger's filters are too long.`),
      { code: 'INVALID_ARGUMENT' },
    );
  }
  if (
    trigger.source === 'calendar' &&
    (!Number.isInteger(trigger.minutesBefore) ||
      trigger.minutesBefore < 0 ||
      trigger.minutesBefore > MAX_MINUTES_BEFORE)
  ) {
    throw Object.assign(
      new Error(`calendar.starting_soon takes 0 to ${MAX_MINUTES_BEFORE} minutes before.`),
      { code: 'INVALID_ARGUMENT' },
    );
  }
}

export function httpStatusOf(error) {
  if (!error || typeof error !== 'object') return null;
  if (Number.isInteger(error.status)) return error.status;
  if (Number.isInteger(error.statusCode)) return error.statusCode;
  return null;
}

export function classifyCheckError(error) {
  const status = httpStatusOf(error);
  const code = typeof error?.code === 'string' ? error.code : '';
  const msg = typeof error?.message === 'string' ? error.message : '';
  const lower = msg.toLowerCase();

  if (
    code === 'GOOGLE_ACCOUNT_NOT_FOUND'
    || code === 'ACCOUNT_NOT_FOUND'
    || /isn't connected|not connected|account not found/.test(lower)
  ) {
    return {
      status: 'paused_account_missing',
      reason: 'ACCOUNT_NOT_FOUND',
      detail: 'Google account is no longer connected.',
      rateLimited: false,
      baseBackoffMs: ERROR_BACKOFF_MS,
    };
  }
  if (
    status === 401
    || code === 'GOOGLE_RECONNECT_REQUIRED'
    || code === 'RECONNECT_REQUIRED'
    || code === 'INVALID_GRANT'
    || /invalid_grant|reconnect|sign-in|access ended/.test(lower)
  ) {
    return {
      status: 'paused_account_reconnect',
      reason: 'RECONNECT_REQUIRED',
      detail: 'Google authorization expired or was revoked. Reconnect this account.',
      rateLimited: false,
      baseBackoffMs: ERROR_BACKOFF_MS,
    };
  }
  if (status === 429 || code === 'RATE_LIMITED' || /too many requests|rate limit/.test(lower)) {
    return {
      status: 'backing_off',
      reason: 'RATE_LIMITED',
      detail: 'Google API rate limit reached; backing off before retrying.',
      rateLimited: true,
      baseBackoffMs: RATE_LIMIT_BACKOFF_MS,
    };
  }
  if (status === 403 || code === 'GOOGLE_API_DISABLED' || code === 'GOOGLE_NEEDS_PERMISSION' || code === 'GOOGLE_BLOCKED_BY_ADMIN') {
    if (code === 'GOOGLE_API_DISABLED' || /api is turned off|not been used|api.*disabled/.test(lower)) {
      return {
        status: 'paused_service_unavailable',
        reason: 'API_DISABLED',
        detail: 'Required Google API is not enabled in the Cloud project.',
        rateLimited: false,
        baseBackoffMs: ERROR_BACKOFF_MS,
      };
    }
    if (code === 'GOOGLE_BLOCKED_BY_ADMIN' || /admin blocked|blocked by.*admin/.test(lower)) {
      return {
        status: 'paused_service_unavailable',
        reason: 'BLOCKED_BY_ADMIN',
        detail: 'Access to this Google service is blocked by the organization administrator.',
        rateLimited: false,
        baseBackoffMs: ERROR_BACKOFF_MS,
      };
    }
    return {
      status: 'paused_service_unavailable',
      reason: 'NEEDS_PERMISSION',
      detail: 'Google permission for this service has not been granted.',
      rateLimited: false,
      baseBackoffMs: ERROR_BACKOFF_MS,
    };
  }
  return {
    status: 'backing_off',
    reason: 'CHECK_ERROR',
    detail: 'Temporary error while checking Google; retrying after backoff.',
    rateLimited: false,
    baseBackoffMs: ERROR_BACKOFF_MS,
  };
}

async function inBatches(items, limit, work) {
  const results = [];
  for (let start = 0; start < items.length; start += limit) {
    results.push(...(await Promise.all(items.slice(start, start + limit).map(work))));
  }
  return results;
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseProfileBody(body) {
  if (!isRecord(body) || typeof body.historyId !== 'string') return null;
  return { historyId: body.historyId };
}

function parseHistoryBody(body) {
  if (!isRecord(body) || typeof body.historyId !== 'string') return null;
  if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') return null;
  const rawHistory = body.history === undefined ? [] : body.history;
  if (!Array.isArray(rawHistory)) return null;
  const history = [];
  for (const entry of rawHistory) {
    if (!isRecord(entry)) return null;
    if (entry.messagesAdded !== undefined) {
      if (!Array.isArray(entry.messagesAdded)) return null;
      const messagesAdded = [];
      for (const added of entry.messagesAdded) {
        if (!isRecord(added) || !isRecord(added.message)) return null;
        const msg = added.message;
        if (typeof msg.id !== 'string' || typeof msg.threadId !== 'string') return null;
        if (msg.labelIds !== undefined && (!Array.isArray(msg.labelIds) || !msg.labelIds.every(l => typeof l === 'string'))) {
          return null;
        }
        messagesAdded.push({
          message: {
            id: msg.id,
            threadId: msg.threadId,
            ...(msg.labelIds ? { labelIds: msg.labelIds } : {}),
          },
        });
      }
      history.push({ messagesAdded });
    } else {
      history.push({});
    }
  }
  return {
    historyId: body.historyId,
    ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    history,
  };
}

function parseLabelsBody(body) {
  if (!isRecord(body)) return null;
  const raw = body.labels === undefined ? [] : body.labels;
  if (!Array.isArray(raw)) return null;
  const labels = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return null;
    labels.push({ id: item.id, name: item.name });
  }
  return { labels };
}

function parseMessagePart(part) {
  if (!isRecord(part)) return null;
  if (part.headers !== undefined) {
    if (!Array.isArray(part.headers)) return null;
    for (const h of part.headers) {
      if (!isRecord(h) || typeof h.name !== 'string' || typeof h.value !== 'string') return null;
    }
  }
  return part;
}

function parseMessageBody(body) {
  if (!isRecord(body) || typeof body.id !== 'string' || typeof body.threadId !== 'string') return null;
  if (body.snippet !== undefined && typeof body.snippet !== 'string') return null;
  if (body.internalDate !== undefined && typeof body.internalDate !== 'string') return null;
  if (body.labelIds !== undefined && (!Array.isArray(body.labelIds) || !body.labelIds.every(l => typeof l === 'string'))) {
    return null;
  }
  if (body.payload !== undefined && !parseMessagePart(body.payload)) return null;
  return body;
}

function messageHeader(message, name) {
  return message.payload?.headers?.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value;
}

function messageSentAt(message) {
  return Number(message.internalDate ?? 0);
}

/** The one real From address, or none when the header names several or none. */
export function senderAddress(from) {
  const mailboxes = splitAddresses(from);
  return (mailboxes.length === 1 && mailboxAddress(mailboxes[0])) || undefined;
}

const domainOf = address => address.slice(address.lastIndexOf('@') + 1);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Gmail stamps its own check on top as `Authentication-Results: mx.google.com; ... dmarc=pass ...
// header.from=acme.com`. A sender can add look-alikes below it, so only the topmost one counts.
function senderVerified(message, from) {
  const address = senderAddress(from);
  if (!address) return false;
  const domain = domainOf(address);
  return (message.payload?.headers ?? [])
    .filter(entry => entry.name.toLowerCase() === 'authentication-results')
    .slice(0, 1)
    .map(entry => entry.value.toLowerCase())
    .some(
      value => value.trimStart().startsWith('mx.google.com;')
        && /\bdmarc=pass\b/.test(value)
        && new RegExp(`\\bheader\\.from=${escapeRegExp(domain)}(?![\\w.-])`).test(value),
    );
}

function newMailOf(message) {
  const from = messageHeader(message, 'From') ?? '';
  return {
    id: message.id,
    threadId: message.threadId,
    labelIds: message.labelIds ?? [],
    from,
    to: messageHeader(message, 'To') ?? '',
    cc: messageHeader(message, 'Cc') ?? '',
    subject: messageHeader(message, 'Subject') ?? '',
    snippet: htmlToText(message.snippet ?? ''),
    at: messageSentAt(message),
    senderVerified: senderVerified(message, from),
  };
}

/** Where history starts now: the mailbox's current point. */
export async function gmailHistoryNow(api) {
  return (await api.get('gmail', `${GMAIL_API_BASE}/profile`, parseProfileBody)).historyId;
}

/** Mail added since `historyId`, oldest first; re-seeded (and nothing fired) when Gmail lost the point. */
export async function gmailChangesSince(api, historyId) {
  const added = new Map();
  let latest = historyId;
  let pageToken;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const url = new URL(`${GMAIL_API_BASE}/history`);
    url.searchParams.set('startHistoryId', historyId);
    url.searchParams.set('historyTypes', 'messageAdded');
    url.searchParams.set('maxResults', '500');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const answer = await api.find('gmail', url.toString(), parseHistoryBody);
    if (!answer) {
      return { kind: 'seeded', historyId: await gmailHistoryNow(api) };
    }
    latest = answer.historyId;
    for (const entry of answer.history) {
      for (const { message } of entry.messagesAdded ?? []) {
        added.set(message.id, { id: message.id, labelIds: message.labelIds ?? [] });
      }
    }
    pageToken = answer.nextPageToken;
    if (!pageToken) break;
  }
  const wanted = [...added.values()].filter(
    entry => !entry.labelIds.some(label => IGNORED_LABELS.has(label)),
  );
  const kept = wanted.slice(-MAX_NEW_MAIL_PER_CHECK);
  const read = await inBatches(kept, MESSAGE_READS_AT_ONCE, async ({ id }) => {
    const url = new URL(`${GMAIL_API_BASE}/messages/${id}`);
    url.searchParams.set('format', 'metadata');
    for (const name of ['From', 'To', 'Cc', 'Subject', 'Authentication-Results']) {
      url.searchParams.append('metadataHeaders', name);
    }
    return api.find('gmail', url.toString(), parseMessageBody);
  });
  const mail = read
    .flatMap(message => (message ? [newMailOf(message)] : []))
    .filter(entry => !entry.labelIds.some(label => IGNORED_LABELS.has(label)))
    .sort((a, b) => a.at - b.at);
  return {
    kind: 'changes',
    historyId: latest,
    mail,
    skipped: wanted.length - kept.length,
  };
}

/** Label names (lowercased) to ids, for rules that name a label. */
export async function gmailLabelIds(api) {
  const { labels } = await api.get('gmail', `${GMAIL_API_BASE}/labels`, parseLabelsBody);
  return new Map(labels.map(label => [label.name.toLowerCase(), label.id]));
}

const VALID_ATTENDEE_RESPONSES = new Set(['accepted', 'declined', 'tentative', 'needsAction']);

function parseSyncPageBody(body) {
  if (!isRecord(body)) return null;
  if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') return null;
  if (body.nextSyncToken !== undefined && typeof body.nextSyncToken !== 'string') return null;
  const rawItems = body.items === undefined ? [] : body.items;
  if (!Array.isArray(rawItems)) return null;
  const items = [];
  for (const item of rawItems) {
    if (!isRecord(item) || typeof item.id !== 'string') return null;
    items.push({ id: item.id });
  }
  return {
    items,
    ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
    ...(body.nextSyncToken ? { nextSyncToken: body.nextSyncToken } : {}),
  };
}

function parseCalendarEvent(raw) {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null;
  const start = isRecord(raw.start) ? raw.start : {};
  const end = isRecord(raw.end) ? raw.end : {};
  const rawAttendees = Array.isArray(raw.attendees) ? raw.attendees : [];
  const attendees = rawAttendees.filter(isRecord).map(attendee => ({
    email: typeof attendee.email === 'string' ? attendee.email : '',
    ...(typeof attendee.displayName === 'string' ? { displayName: attendee.displayName } : {}),
    responseStatus: VALID_ATTENDEE_RESPONSES.has(attendee.responseStatus)
      ? attendee.responseStatus
      : 'needsAction',
    ...(typeof attendee.organizer === 'boolean' ? { organizer: attendee.organizer } : {}),
    ...(typeof attendee.self === 'boolean' ? { self: attendee.self } : {}),
  }));
  return {
    id: raw.id,
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.summary === 'string' ? { summary: raw.summary } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.location === 'string' ? { location: raw.location } : {}),
    ...(typeof raw.htmlLink === 'string' ? { htmlLink: raw.htmlLink } : {}),
    ...(typeof raw.hangoutLink === 'string' ? { hangoutLink: raw.hangoutLink } : {}),
    ...(typeof raw.recurringEventId === 'string' ? { recurringEventId: raw.recurringEventId } : {}),
    start: {
      ...(typeof start.dateTime === 'string' ? { dateTime: start.dateTime } : {}),
      ...(typeof start.date === 'string' ? { date: start.date } : {}),
      ...(typeof start.timeZone === 'string' ? { timeZone: start.timeZone } : {}),
    },
    end: {
      ...(typeof end.dateTime === 'string' ? { dateTime: end.dateTime } : {}),
      ...(typeof end.date === 'string' ? { date: end.date } : {}),
      ...(typeof end.timeZone === 'string' ? { timeZone: end.timeZone } : {}),
    },
    ...(isRecord(raw.organizer) ? {
      organizer: {
        ...(typeof raw.organizer.email === 'string' ? { email: raw.organizer.email } : {}),
        ...(typeof raw.organizer.displayName === 'string' ? { displayName: raw.organizer.displayName } : {}),
        ...(typeof raw.organizer.self === 'boolean' ? { self: raw.organizer.self } : {}),
      },
    } : {}),
    attendees,
    ...(isRecord(raw.conferenceData) && Array.isArray(raw.conferenceData.entryPoints) ? {
      conferenceData: {
        entryPoints: raw.conferenceData.entryPoints.filter(isRecord).map(entry => ({
          ...(typeof entry.entryPointType === 'string' ? { entryPointType: entry.entryPointType } : {}),
          ...(typeof entry.uri === 'string' ? { uri: entry.uri } : {}),
        })),
      },
    } : {}),
  };
}

function parseSchedulePageBody(body) {
  if (!isRecord(body)) return null;
  if (body.nextPageToken !== undefined && typeof body.nextPageToken !== 'string') return null;
  const rawItems = body.items === undefined ? [] : body.items;
  if (!Array.isArray(rawItems)) return null;
  const items = [];
  for (const item of rawItems) {
    const parsed = parseCalendarEvent(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return {
    items,
    ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}),
  };
}

export function eventSummary(calendarId, event) {
  const meet = event.hangoutLink
    ?? event.conferenceData?.entryPoints.find(entry => entry.entryPointType === 'video')?.uri;
  return {
    ref: `calendar:${calendarId}:event:${event.id}`,
    title: event.summary ?? '(no title)',
    start: event.start.dateTime ?? event.start.date ?? '',
    end: event.end.dateTime ?? event.end.date ?? '',
    allDay: event.start.dateTime === undefined,
    ...(event.location ? { location: event.location } : {}),
    ...(meet ? { meetUrl: meet } : {}),
    attendees: event.attendees.map(attendee => ({
      email: attendee.email,
      ...(attendee.displayName ? { name: attendee.displayName } : {}),
      response: attendee.responseStatus,
      ...(attendee.organizer ? { organizer: true } : {}),
      ...(attendee.self ? { self: true } : {}),
    })),
    recurring: event.recurringEventId !== undefined,
    ...(event.status ? { status: event.status } : {}),
  };
}

const calendarEventsUrl = calendarId =>
  new URL(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);

async function syncCalendarPages(api, calendarId, syncToken) {
  let pageToken;
  let changed = false;
  for (let page = 0; page < MAX_SEED_PAGES; page += 1) {
    const url = calendarEventsUrl(calendarId);
    url.searchParams.set('fields', 'items(id),nextPageToken,nextSyncToken');
    url.searchParams.set('maxResults', '2500');
    if (syncToken) url.searchParams.set('syncToken', syncToken);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const answer = await api.get('calendar', url.toString(), parseSyncPageBody);
    changed ||= answer.items.length > 0;
    if (answer.nextSyncToken) {
      return { syncToken: answer.nextSyncToken, changed };
    }
    pageToken = answer.nextPageToken;
    if (!pageToken) break;
  }
  return { syncToken: undefined, changed: true };
}

/**
 * Whether the calendar changed since `syncToken`, and the token to keep. With no token (or one Google
 * dropped: 410) it seeds a new one and reports a change, so the schedule is rebuilt.
 */
export async function calendarChangedSince(api, calendarId, syncToken) {
  if (!syncToken) {
    return { ...(await syncCalendarPages(api, calendarId, undefined)), changed: true };
  }
  try {
    return await syncCalendarPages(api, calendarId, syncToken);
  } catch (error) {
    if (httpStatusOf(error) === 410) {
      return { ...(await syncCalendarPages(api, calendarId, undefined)), changed: true };
    }
    throw error;
  }
}

/** Timed events starting within the longest "minutes before", that the account hasn't declined. */
export async function upcomingEvents(
  api,
  calendarId,
  now,
  horizonMs = (MAX_MINUTES_BEFORE + 60) * 60_000,
) {
  const found = [];
  let pageToken;
  for (let page = 0; page < MAX_SCHEDULE_PAGES; page += 1) {
    const url = calendarEventsUrl(calendarId);
    url.searchParams.set('timeMin', new Date(now).toISOString());
    url.searchParams.set('timeMax', new Date(now + horizonMs).toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const answer = await api.get('calendar', url.toString(), parseSchedulePageBody);
    for (const event of answer.items) {
      const startMs = event.start.dateTime ? Date.parse(event.start.dateTime) : Number.NaN;
      const declined = event.attendees.some(
        attendee => attendee.self && attendee.responseStatus === 'declined',
      );
      if (event.status === 'cancelled' || declined || !(startMs > now)) continue;
      const organizer = event.organizer?.displayName ?? event.organizer?.email;
      found.push({
        summary: eventSummary(calendarId, event),
        startMs,
        ...(organizer ? { organizer } : {}),
        ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
      });
    }
    pageToken = answer.nextPageToken;
    if (!pageToken) break;
  }
  return found;
}

// An entry with @ is one address; without, a domain and its subdomains.
function addressMatches(address, wanted) {
  if (wanted.includes('@')) return address === wanted;
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return domain === wanted || domain.endsWith(`.${wanted}`);
}

export function gmailRuleMatches(rule, mail, labelIds) {
  if (rule.from?.length) {
    const sender = senderAddress(mail.from);
    // A forged sender must never start a run, so a from= rule needs Gmail's domain check.
    if (!sender || !mail.senderVerified || !rule.from.some(w => addressMatches(sender, w))) {
      return false;
    }
  }
  if (rule.to?.length) {
    const recipients = mailboxAddresses(`${mail.to}, ${mail.cc}`);
    if (!recipients.some(address => rule.to.some(w => addressMatches(address, w)))) {
      return false;
    }
  }
  if (
    rule.subjectContains
    && !mail.subject.toLowerCase().includes(rule.subjectContains.toLowerCase())
  ) {
    return false;
  }
  if (rule.label) {
    const id = labelIds?.get(rule.label.toLowerCase()) ?? rule.label;
    if (!mail.labelIds.includes(id)) return false;
  }
  return true;
}

export function gmailRunEvent(target, mail) {
  return {
    triggerId: target.rule.id,
    source: 'gmail',
    event: 'new_email',
    key: `gmail:${target.account}:${mail.id}`,
    subject: `gmail:${target.account}:thread:${mail.threadId}`,
    occurredAt: mail.at,
    ...(mail.from ? { actor: mail.from } : {}),
    place: `Gmail (${target.account})`,
    url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(target.account)}#all/${mail.threadId}`,
    text: [`Subject: ${mail.subject || '(no subject)'}`, mail.snippet].filter(Boolean).join('\n'),
    google: { account: target.account, ref: `gmail:thread:${mail.threadId}` },
  };
}

/** When a meeting's "minutes before" comes; the rule fires once at or after it, never after it starts. */
export const calendarDueAt = (rule, event) => event.startMs - rule.minutesBefore * 60_000;

export function calendarRunEvent(target, event) {
  const { summary } = event;
  return {
    triggerId: target.rule.id,
    source: 'calendar',
    event: 'starting_soon',
    key: `${summary.ref}:${target.account}:${event.startMs}:${target.rule.minutesBefore}`,
    occurredAt: calendarDueAt(target.rule, event),
    ...(event.organizer ? { actor: event.organizer } : {}),
    place: `Google Calendar (${target.account})`,
    ...(event.htmlLink ? { url: event.htmlLink } : {}),
    text: [
      summary.title,
      `Starts ${new Date(event.startMs).toISOString()}`,
      ...(summary.location ? [`Where: ${summary.location}`] : []),
      ...(summary.meetUrl ? [`Meet: ${summary.meetUrl}`] : []),
      ...(summary.attendees.length > 0 ? [`${summary.attendees.length} invited`] : []),
    ].join('\n'),
    google: { account: target.account, ref: summary.ref },
  };
}

const FALLBACK_OPS = Object.freeze({
  assertGoogleTrigger,
  gmailHistoryNow,
  gmailChangesSince,
  gmailLabelIds,
  calendarChangedSince,
  upcomingEvents,
  gmailRuleMatches,
  gmailRunEvent,
  calendarDueAt,
  calendarRunEvent,
});

async function defaultLoadOrca() {
  try {
    const mod = await import('./orca-domain.js');
    if (typeof mod?.loadOrca === 'function') {
      return await mod.loadOrca();
    }
  } catch {
    // orca-domain.js may not be present in isolated unit tests; fall back to MIT-preserved ops.
  }
  return null;
}

/**
 * Resolves trigger operations from pinned vendored `orca-domain.js` when present,
 * falling back cleanly to the faithful MIT-preserved ESM implementations above.
 */
export async function resolveOrcaTriggerOps(loadOrcaOverride) {
  let modules = null;
  try {
    modules = typeof loadOrcaOverride === 'function' ? await loadOrcaOverride() : await defaultLoadOrca();
  } catch {
    modules = null;
  }
  if (!modules || typeof modules !== 'object') return FALLBACK_OPS;

  const gmailChangesMod = modules['google-gmail-changes'];
  const calChangesMod = modules['google-calendar-changes'];
  const matchMod = modules['google-trigger-match'];
  const triggersMod = modules['automation-google-triggers'];

  const rawCalendarChangedSince = typeof calChangesMod?.calendarChangedSince === 'function'
    ? calChangesMod.calendarChangedSince
    : calendarChangedSince;

  return {
    assertGoogleTrigger: typeof triggersMod?.assertGoogleTrigger === 'function'
      ? triggersMod.assertGoogleTrigger
      : assertGoogleTrigger,
    gmailHistoryNow: typeof gmailChangesMod?.gmailHistoryNow === 'function'
      ? gmailChangesMod.gmailHistoryNow
      : gmailHistoryNow,
    gmailChangesSince: typeof gmailChangesMod?.gmailChangesSince === 'function'
      ? gmailChangesMod.gmailChangesSince
      : gmailChangesSince,
    gmailLabelIds: typeof gmailChangesMod?.gmailLabelIds === 'function'
      ? gmailChangesMod.gmailLabelIds
      : gmailLabelIds,
    // Wrap vendored calendarChangedSince so HTTP 410 re-seeds even if the error came from a different class realm.
    calendarChangedSince: async (api, calendarId, syncToken) => {
      try {
        return await rawCalendarChangedSince(api, calendarId, syncToken);
      } catch (error) {
        if (syncToken && httpStatusOf(error) === 410) {
          return await rawCalendarChangedSince(api, calendarId, undefined);
        }
        throw error;
      }
    },
    upcomingEvents: typeof calChangesMod?.upcomingEvents === 'function'
      ? calChangesMod.upcomingEvents
      : upcomingEvents,
    gmailRuleMatches: typeof matchMod?.gmailRuleMatches === 'function'
      ? matchMod.gmailRuleMatches
      : gmailRuleMatches,
    gmailRunEvent: typeof matchMod?.gmailRunEvent === 'function'
      ? matchMod.gmailRunEvent
      : gmailRunEvent,
    calendarDueAt: typeof matchMod?.calendarDueAt === 'function'
      ? matchMod.calendarDueAt
      : calendarDueAt,
    calendarRunEvent: typeof matchMod?.calendarRunEvent === 'function'
      ? matchMod.calendarRunEvent
      : calendarRunEvent,
  };
}
