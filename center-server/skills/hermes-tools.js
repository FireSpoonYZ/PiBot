// OpenAI function definitions for the Hermes review tool whitelist.
// skills_list / skill_view / skill_manage parameters are upstream-exact
// (tools/skill_manager_tool.py SKILL_MANAGE_SCHEMA, description with
// SKILL_PROMPT_DESC_LIMIT=60 per agent/curator.py and agent/learn_prompt.py).
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

export const HERMES_SKILL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'skills_list',
      description: "List the skills available to this Bot: managed drafts plus bound installed skill packages, with name, description, state and provenance. Read-only.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill_view',
      description: "Load a skill's SKILL.md (or one supporting file via file_path) so you can read its rules before writing. Records the read for read-before-write: patch/edit/delete of an existing file requires viewing that exact file first during this review.",
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
        'Create, update or delete skills: your procedural memory for recurring ' +
        'tasks. The call is an operations array (a single ' +
        'edit is a list of one); it applies atomically — any failure rolls ' +
        'every touched skill back. Ops: create (full SKILL.md; lands in ' +
        "the profile's skills directory or configured skills.create_dir; must precede that skill's other " +
        "ops), patch (targeted old_string/new_string fix — preferred; " +
        'content alone REPLACES the whole file, read it via skill_view() ' +
        'first), write_file/remove_file (supporting files), delete (sole ' +
        'op only). Existing skills are modified wherever they live. ' +
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
                  absorbed_into: { type: 'string', description: 'Curator consolidation: exact name of a non-archived umbrella in this Bot\'s curated_report (agent-created or eligible pinned skill). Pin an eligible manual target first, or choose an active curator-managed target; restore archived targets first. Empty string declares a prune.' },
                }, []),
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

export const HERMES_SKILL_TOOL_NAMES = HERMES_SKILL_TOOLS.map((tool) => tool.function.name);
