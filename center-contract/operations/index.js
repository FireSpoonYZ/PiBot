import { operations as bots } from './bots.js';
import { operations as capabilities } from './capabilities.js';
import { operations as collaboration } from './collaboration.js';
import { operations as automation } from './automation.js';
import { operations as center } from './center-admin.js';
import { operations as messages } from './dispatch.js';

export const operationCatalog = Object.freeze(Object.entries({
  bots, capabilities, collaboration, automation, center, messages,
}).flatMap(([domain, definitions]) => definitions.map((operation) => Object.freeze({
  ...operation, domain, scope: `pibot:${domain}:${operation.readOnly ? 'read' : 'write'}`,
}))));

export const operationScopes = Object.freeze([
  ...new Set(operationCatalog.filter(operation => operation.audiences.includes('oauth')).map(operation => operation.scope)),
]);
