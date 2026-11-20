import Ajv from 'ajv';
import { operationCatalog } from '../../center-contract/operations/index.js';
import { createHandlers as bots } from './bots.js';
import { createHandlers as capabilities } from './capabilities.js';
import { createHandlers as collaboration } from './collaboration.js';
import { createHandlers as automation } from './automation.js';
import { createHandlers as center } from './center-admin.js';
import { createHandlers as observability } from './observability.js';
import { createHandlers as messages } from './dispatch.js';

const createGroups = {
  bots, capabilities, collaboration, automation, messages,
  center: deps => ({ ...center(deps), ...observability(deps) }),
};
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function openOperations(deps) {
  const ajv = new Ajv({ strict: false, ownProperties: true });
  const handlers = Object.fromEntries(Object.entries(createGroups).map(([group, create]) => [group, create(deps)]));
  const entries = new Map();
  for (const operation of operationCatalog) {
    const { name, domain, inputSchema } = operation;
    const run = Object.hasOwn(handlers[domain], name) && handlers[domain][name];
    if (entries.has(name) || !/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof run !== 'function') {
      throw new Error(`Invalid or duplicate built-in operation: ${name}`);
    }
    entries.set(name, { operation, run, validate: ajv.compile(inputSchema) });
  }
  for (const [group, implementations] of Object.entries(handlers)) {
    for (const name of Object.keys(implementations)) {
      if (entries.get(name)?.operation.domain !== group) throw new Error(`Undeclared built-in operation: ${name}`);
    }
  }

  const allowed = (actor, operation) => Boolean(
    actor && operation.audiences.includes(actor.kind) &&
    (actor.kind === 'bot' || actor.scopes?.includes(operation.scope)),
  );
  return {
    list(actor) { return operationCatalog.filter(operation => allowed(actor, operation)); },
    async call(actor, name, args) {
      const entry = entries.get(name);
      // Check authorization even when the client skipped listing, and don't disclose hidden tools.
      if (!entry || !allowed(actor, entry.operation)) fail('FORBIDDEN', 'Operation not available for this caller');
      if (!entry.validate(args)) fail('INVALID_ARGUMENT', 'Arguments do not match the operation schema');
      const value = await entry.run(args, actor);
      if (value === undefined) return { ok: true };
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) {
        fail('RESPONSE_TOO_LARGE', 'Result exceeds the tool limit; narrow the query');
      }
      return value;
    },
  };
}
