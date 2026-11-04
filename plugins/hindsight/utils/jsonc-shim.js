// Lightweight JSONC parser & writer shim for pi-hindsight config files
function stripJsonComments(text) {
  let result = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      result += ch;
      if (ch === "\\" && i + 1 < text.length) {
        result += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringChar = ch;
      result += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n" || text[i] === "\r") {
          result += text[i];
        }
        i += 1;
      }
      i += 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  // Also strip trailing commas before } or ]
  return result.replace(/,(\s*[}\]])/g, "$1");
}

export function parse(text, errors = [], _options = {}) {
  try {
    const stripped = stripJsonComments(String(text ?? ""));
    if (!stripped.trim()) return undefined;
    return JSON.parse(stripped);
  } catch (err) {
    if (Array.isArray(errors)) {
      errors.push({
        error: 1,
        offset: 0,
        length: 1,
        message: err?.message ?? String(err),
      });
    }
    return undefined;
  }
}

export function printParseErrorCode(code) {
  return `JsonParseError(${code})`;
}

export function modify(text, path, value, _options = {}) {
  const errors = [];
  let root = parse(text, errors);
  if (errors.length > 0 || !root || typeof root !== "object" || Array.isArray(root)) {
    root = {};
  }
  if (!Array.isArray(path) || path.length === 0) {
    root = value;
  } else {
    let cursor = root;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i];
      if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    const lastKey = path[path.length - 1];
    if (value === undefined) {
      delete cursor[lastKey];
    } else {
      cursor[lastKey] = value;
    }
  }
  const formatted = `${JSON.stringify(root, null, 2)}\n`;
  return [{ offset: 0, length: String(text ?? "").length, content: formatted }];
}

export function applyEdits(text, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return text;
  let current = String(text ?? "");
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);
  for (const edit of sorted) {
    current =
      current.slice(0, edit.offset) +
      edit.content +
      current.slice(edit.offset + edit.length);
  }
  return current;
}
