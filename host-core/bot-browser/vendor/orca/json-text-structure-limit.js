// From stablyai/orca v1.4.267. Copyright (c) 2026 Lovecast Inc. See ./LICENSE.
class JsonTextStructureCapacityError extends Error {
  constructor(resource, limit) {
    super(
      resource === "structuralTokens" ? `JSON structure exceeds ${limit} tokens` : `JSON nesting exceeds ${limit} levels`
    );
    this.resource = resource;
    this.limit = limit;
    this.name = "JsonTextStructureCapacityError";
  }
  resource;
  limit;
}
function assertJsonTextStructureWithinLimits(content, limits) {
  new JsonTextStructureValidator(limits).consume(content);
}
class JsonTextStructureValidator {
  constructor(limits) {
    this.limits = limits;
    assertLimit(limits.structuralTokens);
    assertLimit(limits.nestingDepth);
  }
  limits;
  structuralTokens = 0;
  depth = 0;
  maximumDepth = 0;
  inString = false;
  escaped = false;
  consume(content) {
    let linearString = false;
    for (let index = 0; index < content.length; index += 1) {
      const character = content[index];
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
          continue;
        }
        if (!linearString) {
          const quote = content.indexOf('"', index);
          const end = quote === -1 ? content.length : quote;
          let backslashes = 0;
          for (let at = end - 1; at >= index && content[at] === "\\"; at -= 1) {
            backslashes++;
          }
          if (quote === -1) {
            this.escaped = backslashes % 2 !== 0;
            return;
          }
          index = quote;
          if (backslashes % 2 === 0) {
            this.inString = false;
          } else {
            linearString = true;
          }
          continue;
        }
        if (character === "\\") {
          this.escaped = true;
        } else if (character === '"') {
          this.inString = false;
          linearString = false;
        }
        continue;
      }
      if (character === '"') {
        this.inString = true;
        continue;
      }
      if (!isStructuralToken(character)) {
        continue;
      }
      this.structuralTokens++;
      if (this.structuralTokens > this.limits.structuralTokens) {
        throw new JsonTextStructureCapacityError("structuralTokens", this.limits.structuralTokens);
      }
      if (character === "{" || character === "[") {
        this.depth++;
        this.maximumDepth = Math.max(this.maximumDepth, this.depth);
        if (this.depth > this.limits.nestingDepth) {
          throw new JsonTextStructureCapacityError("nestingDepth", this.limits.nestingDepth);
        }
      } else if (character === "}" || character === "]") {
        this.depth = Math.max(0, this.depth - 1);
      }
    }
  }
  usage() {
    return { structuralTokens: this.structuralTokens, nestingDepth: this.maximumDepth };
  }
}
function assertLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("JSON structure limits must be non-negative safe integers");
  }
}
function isStructuralToken(character) {
  return character === "{" || character === "}" || character === "[" || character === "]" || character === "," || character === ":";
}
export {
  JsonTextStructureCapacityError,
  JsonTextStructureValidator,
  assertJsonTextStructureWithinLimits
};
