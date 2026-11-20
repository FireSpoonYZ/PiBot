const VALID_AUDIENCES = new Set(['bot', 'oauth']);
const DEFAULT_AUDIENCES = Object.freeze(['bot', 'oauth']);

/** Pure JSON contract shared by the Host model tools and the Center MCP server. */
export function defineOperation({
  name, description, properties = {}, required = [], readOnly = false, destructive = !readOnly,
  audiences = DEFAULT_AUDIENCES,
}) {
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.some(a => !VALID_AUDIENCES.has(a))) {
    throw new Error(`Invalid audiences for operation: ${name}`);
  }
  return Object.freeze({
    name, description, readOnly, destructive,
    audiences: Object.freeze([...new Set(audiences)]),
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  });
}
