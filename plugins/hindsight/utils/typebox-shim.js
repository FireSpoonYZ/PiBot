// Lightweight TypeBox JSON Schema builder shim for pi-hindsight operation-catalog
export const Type = {
  String(options = {}) {
    return { type: "string", ...options };
  },
  Number(options = {}) {
    return { type: "number", ...options };
  },
  Integer(options = {}) {
    return { type: "integer", ...options };
  },
  Boolean(options = {}) {
    return { type: "boolean", ...options };
  },
  Null(options = {}) {
    return { type: "null", ...options };
  },
  Unknown(options = {}) {
    return { ...options };
  },
  Unsafe(schema = {}) {
    return { ...schema };
  },
  Literal(value, options = {}) {
    return { const: value, type: typeof value, ...options };
  },
  Optional(schema) {
    return { ...schema, __optional: true };
  },
  Array(items, options = {}) {
    return { type: "array", items, ...options };
  },
  Record(keySchema, valueSchema, options = {}) {
    return {
      type: "object",
      additionalProperties: valueSchema,
      ...options,
    };
  },
  Union(schemas, options = {}) {
    const literals = schemas.every(
      (s) => s && typeof s === "object" && "const" in s && typeof s.const === "string",
    );
    if (literals) {
      return {
        type: "string",
        enum: schemas.map((s) => s.const),
        ...options,
      };
    }
    return { anyOf: schemas, ...options };
  },
  Object(properties = {}, options = {}) {
    const cleanProps = {};
    const required = [];
    for (const [key, propSchema] of Object.entries(properties)) {
      if (!propSchema || typeof propSchema !== "object") {
        cleanProps[key] = propSchema;
        continue;
      }
      const { __optional, ...rest } = propSchema;
      cleanProps[key] = rest;
      if (!__optional) {
        required.push(key);
      }
    }
    const result = {
      type: "object",
      properties: cleanProps,
      ...options,
    };
    if (required.length > 0) {
      result.required = required;
    }
    return result;
  },
};

// Identity helper matching @earendil-works/pi-coding-agent defineTool
export function defineTool(tool) {
  return tool;
}
export function keyText(key) {
  return key;
}
