/** Pure JSON contract shared by the Host model tools and the Center MCP server. */
export function defineOperation({ name, description, properties = {}, required = [], readOnly = false, destructive = !readOnly }) {
  return Object.freeze({
    name, description, readOnly, destructive,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  });
}
