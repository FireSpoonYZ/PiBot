// OpenAI function definitions for the learning tool whitelist.
// The skill tools adapt the upstream schema to versioned managed skills (auto-published to the owner Bot).
// read_file / search_files are ADAPTED: upstream file_tools.py is not vendored,
// so params are scoped to the Bot's managed + bound skill content; unsupported
// targets return success:false instead of touching a real filesystem.

const SKILL_PROMPT_DESC_LIMIT = 60;

const nameProp = { type: 'string', description: "Skill name (lowercase, hyphens/underscores, max 64 chars); 'category/name' also resolves." };
const filePathProp = {
  type: 'string',
  description: "Path RELATIVE to the skill's own directory, e.g. 'references/api.md' — no leading slash, never absolute; first segment references/, templates/, scripts/, or assets/.",
};

function opSchema(action, props, required) {
  return {
    type: 'object', additionalProperties: false,
    properties: { name: { type: 'string' }, action: { type: 'string', enum: [action] }, ...props },
    required: ['name', 'action', ...required],
  };
}

export const LEARNING_SKILL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'skills_list',
      description: "List the skills available to this Bot: versioned managed skills plus bound installed skill packages, with name, description, state and provenance. Read-only.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_view',
      description: "Load a skill's SKILL.md (or one supporting file via file_path) before editing it. Records that this exact file was read during the learning job.",
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { name: nameProp, file_path: filePathProp },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_manage',
      description:
        'Create, patch, or curate versioned managed Skills for this Bot (committed to revision history and automatically published). ' +
        'Send an operations array with one or more edits. A failed operation rolls back the entire batch. ' +
        "Use create (full SKILL.md, before the skill's other operations), patch (prefer a targeted old_string/new_string change; " +
        'content alone REPLACES the whole file, read it via skill_view() ' +
        'first), write_file/remove_file (supporting files), or delete (curator consolidation only, requires absorbed_into). ' +
        'Description: max ' + SKILL_PROMPT_DESC_LIMIT + " chars, 'Use when <trigger>. <behavior>.', never " +
        'the category name (the index shows it). Write lessons, not logs: ' +
        'imperative rule + why, no PR numbers/dates/incident narration, one ' +
        'rule per lesson, references/ named by topic (extend before adding). ' +
        'skill_view() shows format conventions.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            description: "Ordered ops; each names its target skill (lowercase, hyphens/underscores, max 64 chars). Each action is its own shape; another action's text slot is invalid.",
            items: {
              anyOf: [
                opSchema('create', {
                  content: { type: 'string', description: 'Full SKILL.md text (YAML frontmatter + markdown body).' },
                  category: { type: 'string', description: "Optional category subdir (e.g. 'devops')." },
                }, ['content']),
                opSchema('patch', {
                  old_string: { type: 'string', minLength: 1, description: 'Text to find (same matching semantics as the patch tool).' },
                  new_string: { type: 'string', description: 'Replacement; empty string deletes the match.' },
                  replace_all: { type: 'boolean', description: 'Replace all occurrences (default false).' },
                  file_path: { type: 'string', description: "Optional supporting file (write_file's shape); default SKILL.md." },
                }, ['old_string', 'new_string']),
                opSchema('patch', {
                  content: { type: 'string', description: 'Full SKILL.md rewrite (REPLACES the whole file; last resort).' },
                }, ['content']),
                opSchema('write_file', {
                  file_path: filePathProp,
                  file_content: { type: 'string', description: 'Full text of the supporting file.' },
                }, ['file_path', 'file_content']),
                opSchema('remove_file', {
                  file_path: { type: 'string', description: "Supporting file (write_file's shape)." },
                }, ['file_path']),
                opSchema('delete', {
                  absorbed_into: { type: 'string', description: 'Live target skill name that absorbed this skill during curator consolidation.' },
                }, ['absorbed_into']),
              ],
            },
          },
        },
        required: ['operations'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "ADAPTED (upstream file_tools.py not vendored): read a file inside this Bot's skill library. Path forms: '<skill>', '<skill>/SKILL.md', '<skill>/references/x.md', optionally prefixed with 'skills/'. Also registers the read for read-before-write.",
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', description: "Skill-relative path, e.g. 'my-skill/SKILL.md' or 'my-skill/references/api.md'." },
          offset: { type: 'integer', description: 'Line offset to start from (0-based).' },
          limit: { type: 'integer', description: 'Maximum number of lines to return.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: "ADAPTED (upstream file_tools.py not vendored): search this Bot's skill files for a literal string. Scope the search to one skill by passing its name/path in path.",
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Literal text to search for (not a regex).' },
          path: { type: 'string', description: 'Optional skill name or path prefix to restrict the search.' },
          case_sensitive: { type: 'boolean', description: 'Default false.' },
          max_results: { type: 'integer', description: 'Maximum matches returned (default 50, capped).' },
        },
        required: ['query'],
      },
    },
  },
];

export const LEARNING_SKILL_TOOL_NAMES = LEARNING_SKILL_TOOLS.map((tool) => tool.function.name);
