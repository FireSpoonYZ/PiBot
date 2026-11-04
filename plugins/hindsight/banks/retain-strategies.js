/**
 * Named retain strategies and knowledge entity-label taxonomy.
 *
 * Aligned with @vectorize-io/hindsight-coding-agents bank-template practices, adapted for Pi:
 * default strategy is conversation (live Pi sessions), not git.
 * Pages are seeded separately (knowledge-base API) — not as bare mental_models in the template.
 */
export const GIT_RETAIN_MISSION = "You are ingesting a single git commit: its message and its full diff. Extract the concrete " +
    "technical DECISION and the CAUSE/INVARIANT it encodes, bound to the specific code entities " +
    "(functions, methods, files) and behaviors it changes. Preserve exact identifiers, paths, and " +
    "literal values verbatim. Capture both WHAT changed and WHY. Issue/PR references (#123, GH-123) " +
    "are load-bearing: keep them VERBATIM in the fact text and emit each as an ENTITY.";
export const GITLOG_RETAIN_MISSION = "You are ingesting an aggregated block of git commit MESSAGES ONLY (no diffs) — the project's " +
    "recent commit-message history, newest first. Extract the project's INITIATIVES, FEATURES, " +
    "ENHANCEMENTS, and notable themes over time. Do NOT extract per-line code detail. Group related " +
    "commits into a coherent initiative/theme where messages make that clear; preserve exact " +
    "identifiers and issue/PR references VERBATIM and emit each as an ENTITY.";
export const CONVERSATION_RETAIN_MISSION = "You are ingesting a developer conversation as a JSONL transcript (one {role, content} turn per line): the " +
    "user's requests, the assistant's narration, and compact tool-action turns (name + target only). " +
    "It may be a SHORT decision chat or a LONG working session — scale facts to the substance, never " +
    "to the message count. Extract the FEWEST facts that capture the OUTCOME: settled DECISIONS and " +
    "their exact rules/values (quote literals VERBATIM); concrete CHANGES to specific code entities; " +
    "problems and how they were resolved; conventions or invariants established; at most one fact for " +
    "a notable REJECTED alternative. CRITICAL: a conversation REVISES itself — record ONLY the FINAL " +
    "state as what is in effect; a superseded proposal appears ONLY inside the rejected fact, NEVER as " +
    "its own 'decided' fact; if the same setting changes several times keep only the LAST. Do NOT emit " +
    "one fact per message or per intermediate proposal. Keep issue/PR references VERBATIM and emit each " +
    "as an ENTITY. Do not invent; capture only what was actually settled.";
export const DOCUMENT_RETAIN_MISSION = "You are ingesting a standalone document (notes, docs, or structural findings). Extract the " +
    "concrete facts, concepts, and structure it describes. Preserve identifiers and paths verbatim.";
export const PI_RETAIN_STRATEGIES = {
    git: {
        retain_mission: GIT_RETAIN_MISSION,
        retain_extraction_mode: "verbose",
    },
    gitlog: {
        retain_mission: GITLOG_RETAIN_MISSION,
        retain_extraction_mode: "verbose",
        retain_chunk_size: 12_000,
    },
    conversation: {
        retain_mission: CONVERSATION_RETAIN_MISSION,
        retain_extraction_mode: "verbose",
        retain_chunk_size: 12_000,
    },
    document: {
        retain_mission: DOCUMENT_RETAIN_MISSION,
        retain_extraction_mode: "verbose",
        retain_chunk_size: 12_000,
    },
    survey: {
        retain_extraction_mode: "custom",
        retain_custom_instructions: "This document belongs to a Hindsight codebase-survey lifecycle. Apply ONE of two rules: " +
            "(1) If the content is an internal status marker — it says it is an internal marker, or " +
            "merely announces that a survey started/completed — extract NOTHING: return an empty list of facts. " +
            "(2) Otherwise the content is survey FINDINGS: extract concrete structural facts (components, " +
            "responsibilities, conventions, tech stack), preserving identifiers verbatim.",
        retain_chunk_size: 12_000,
    },
};
/** Fixed knowledge-tier entity labels (tag: true → knowledge:<value> on facts). */
export const KNOWLEDGE_ENTITY_LABELS = {
    key: "knowledge",
    type: "multi-values",
    optional: true,
    tag: true,
    description: "Routing labels for this project's Hindsight KNOWLEDGE PAGES — curated summaries of durable " +
        "engineering knowledge. Mark a fact only when it is durable, reusable knowledge a developer " +
        "would still want in future sessions. Leave EMPTY for routine or transient facts. MOST facts " +
        "should get no label here.",
    values: [
        {
            value: "feature-work",
            description: "A new feature, initiative, or enhancement being planned or built — not routine bug-fixes.",
        },
        {
            value: "decision",
            description: "A technical decision that will constrain future work, with its rationale.",
        },
        {
            value: "convention",
            description: "An established way this project does things — naming, structure, testing, or patterns.",
        },
        {
            value: "component",
            description: "What a module, file, service, or subsystem is responsible for, or how components relate.",
        },
        {
            value: "concept",
            description: "A domain concept, key abstraction, or project vocabulary a contributor must understand.",
        },
    ],
};
export const KNOWLEDGE_PAGE_SEEDS = [
    {
        name: "Component map",
        source_query: "From this project's commit history and past discussions, what are the main " +
            "components/modules/subsystems, what is each responsible for, and how do they relate?",
        tags: ["knowledge:component"],
    },
    {
        name: "Core concepts",
        source_query: "What are the core concepts, domain abstractions, and key entities in this project — " +
            "the vocabulary a developer must understand?",
        tags: ["knowledge:concept"],
    },
    {
        name: "Conventions and patterns",
        source_query: "What conventions, idioms, and recurring patterns does this project follow — testing, " +
            "error handling, naming, structure, and how changes are typically made?",
        tags: ["knowledge:convention"],
    },
    {
        name: "Key decisions and rationale",
        source_query: "What are the significant technical decisions made in this project and the rationale " +
            "behind them — the durable 'why we do it this way' a developer should know?",
        tags: ["knowledge:decision"],
    },
    {
        name: "Initiatives and enhancements",
        source_query: "Based on this repository's history and discussions, what are the major initiatives, " +
            "features, and enhancements the project has worked on? Summarize themes over time.",
        tags: ["knowledge:feature-work"],
    },
];
export const KNOWLEDGE_PAGE_MAX_TOKENS = 4096;
export const KNOWLEDGE_PAGE_TRIGGER = {
    fact_types: ["world", "experience", "observation"],
    refresh_after_consolidation: true,
};
/** Default strategy for live Pi session retains. */
export const LIVE_SESSION_RETAIN_STRATEGY = "conversation";
