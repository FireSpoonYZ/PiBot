function stringValue(value, fallback = "") {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    return fallback;
}
function toolName(message, part) {
    return stringValue(part?.name ?? message.toolName ?? message.name, "unknown");
}
function toolAllowed(name, filter) {
    if (filter.include && !filter.include.includes(name))
        return false;
    return !filter.exclude?.includes(name);
}
/** Keys tried, in order, for a compact tool-action target (coding-agents write-back discipline). */
const TOOL_TARGET_KEYS = [
    "file_path",
    "path",
    "notebook_path",
    "command",
    "pattern",
    "query",
    "url",
    "name",
    "id",
];
const ACTION_TARGET_CAP = 100;
/**
 * Compact tool input to a primary target string (file path, command, pattern, …).
 * Full args/outputs bury decisions in mechanical noise; retain only WHAT was touched.
 */
export function toolActionTarget(input) {
    let target = "";
    if (input && typeof input === "object") {
        const rec = input;
        for (const key of TOOL_TARGET_KEYS) {
            const value = rec[key];
            if (typeof value === "string" && value.trim()) {
                target = value.trim().split("\n")[0] ?? "";
                break;
            }
        }
    }
    else if (typeof input === "string") {
        target = input.trim().split("\n")[0] ?? "";
    }
    if (target.length > ACTION_TARGET_CAP)
        target = `${target.slice(0, ACTION_TARGET_CAP)}…`;
    return target;
}
function compactToolCallPart(name, args) {
    const target = toolActionTarget(args);
    return {
        type: "toolCall",
        name,
        // Compact form: name + primary target only (no full argument object / no outputs).
        arguments: target ? { target } : {},
    };
}
function textFromContent(content, options) {
    if (typeof content === "string")
        return options.includeText ? content : "";
    if (!Array.isArray(content))
        return options.includeText ? JSON.stringify(content ?? "") : "";
    return content
        .map((part) => {
        if (part && typeof part === "object" && "type" in part) {
            const p = part;
            if (p.type === "text")
                return options.includeText ? stringValue(p.text) : "";
            if (p.type === "thinking")
                return options.includeThinking ? stringValue(p.thinking ?? p.text) : "";
            if (p.type === "toolCall") {
                if (!options.includeToolCall)
                    return "";
                const name = stringValue(p.name, "unknown");
                if (options.toolCallFilter && !toolAllowed(name, options.toolCallFilter))
                    return "";
                if (options.compactToolCalls !== false) {
                    const target = toolActionTarget(p.arguments);
                    return target ? `[action ${name} ${target}]` : `[action ${name}]`;
                }
                return `[toolCall ${name}] ${JSON.stringify(p.arguments ?? {})}`;
            }
            if (p.type === "image")
                return options.includeText ? "[image omitted]" : "";
        }
        return options.includeText && options.includeUnknownJson !== false
            ? JSON.stringify(part)
            : "";
    })
        .filter(Boolean)
        .join("\n");
}
function projectContent(content, options) {
    if (typeof content === "string")
        return options.includeText ? content : "";
    if (!Array.isArray(content))
        return options.includeText ? (content ?? "") : "";
    const projected = content
        .map((part) => {
        if (part && typeof part === "object" && "type" in part) {
            const p = part;
            if (p.type === "text")
                return options.includeText ? part : undefined;
            if (p.type === "thinking")
                return options.includeThinking ? part : undefined;
            if (p.type === "toolCall") {
                if (!options.includeToolCall)
                    return undefined;
                const name = stringValue(p.name, "unknown");
                if (options.toolCallFilter && !toolAllowed(name, options.toolCallFilter))
                    return undefined;
                if (options.compactToolCalls !== false) {
                    return compactToolCallPart(name, p.arguments);
                }
                return part;
            }
            if (p.type === "image")
                return options.includeText ? part : undefined;
        }
        return options.includeText ? part : undefined;
    })
        .filter((part) => part !== undefined);
    return projected.length ? projected : "";
}
function stripFields(record, fields) {
    const out = { ...record };
    fields.forEach((field) => delete out[field]);
    return out;
}
function messageTimestamp(message) {
    return new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now()).toISOString();
}
export function projectMessage(message, config) {
    const m = message;
    const role = stringValue(m.role, "unknown");
    const retain = config?.retain;
    const isAssistant = role === "assistant";
    const includeAssistantText = retain?.content.assistant.includes("text") ?? true;
    const includeThinking = retain?.content.assistant.includes("thinking") ?? false;
    const includeToolCall = retain?.content.assistant.includes("toolCall") ?? true;
    const compactToolCalls = retain?.compactToolCalls !== false;
    const base = {
        role,
        timestamp: messageTimestamp(m),
        content: projectContent(m.content, {
            includeText: !isAssistant || includeAssistantText,
            includeThinking: isAssistant && includeThinking,
            includeToolCall: isAssistant && includeToolCall,
            compactToolCalls,
            ...(retain ? { toolCallFilter: retain.toolFilter.toolCall } : {}),
        }),
    };
    if (role === "toolResult") {
        base.toolName = m.toolName;
        base.isError = m.isError;
    }
    if (role === "assistant") {
        base.model = m.model;
        base.stopReason = m.stopReason;
    }
    return stripFields(base, retain?.strip.message ?? []);
}
export function projectMessageText(message, config) {
    const m = message;
    const role = stringValue(m.role, "unknown");
    const retain = config?.retain;
    const isAssistant = role === "assistant";
    const includeAssistantText = retain?.content.assistant.includes("text") ?? true;
    const includeThinking = retain?.content.assistant.includes("thinking") ?? false;
    const includeToolCall = retain?.content.assistant.includes("toolCall") ?? true;
    const compactToolCalls = retain?.compactToolCalls !== false;
    const base = {
        role,
        timestamp: messageTimestamp(m),
        content: textFromContent(m.content, {
            includeText: !isAssistant || includeAssistantText,
            includeThinking: isAssistant && includeThinking,
            includeToolCall: isAssistant && includeToolCall,
            includeUnknownJson: false,
            compactToolCalls,
            ...(retain ? { toolCallFilter: retain.toolFilter.toolCall } : {}),
        }),
    };
    if (role === "toolResult") {
        base.toolName = m.toolName;
        base.isError = m.isError;
    }
    if (role === "assistant") {
        base.model = m.model;
        base.stopReason = m.stopReason;
    }
    return stripFields(base, retain?.strip.message ?? []);
}
export function isInjectedHindsightMemory(message) {
    const record = message;
    if (record.customType === "hindsight-recall" ||
        record.type === "hindsight-recall" ||
        record.customType === "hindsight-mental-models" ||
        record.type === "hindsight-mental-models") {
        return true;
    }
    const text = textFromContent(record.content, {
        includeText: true,
        includeThinking: false,
        includeToolCall: true,
    }).trim();
    // Only prefix matches: substring contains would drop legitimate discussion of these tags.
    return (text.startsWith("<hindsight-memory>") ||
        text.startsWith("<hindsight_memories>") ||
        text.startsWith("<hindsight-mental-models>") ||
        text.startsWith("<mental_models>"));
}
function toolResultContent(message, mode) {
    const text = textFromContent(message.content, {
        includeText: true,
        includeThinking: false,
        includeToolCall: false,
    });
    if (mode === "summary")
        return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return text;
}
function projectToolResult(message, config) {
    const m = message;
    const name = toolName(m);
    if (!toolAllowed(name, config.retain.toolFilter.toolResult))
        return undefined;
    const modes = config.retain.content.toolResult;
    if (m.isError) {
        if (!modes.includes("error"))
            return undefined;
        return stripFields({
            role: "toolResult",
            timestamp: messageTimestamp(m),
            toolName: name,
            isError: true,
            content: toolResultContent(m, "error"),
        }, config.retain.strip.message);
    }
    if (modes.includes("content"))
        return projectMessage(message, config);
    if (modes.includes("summary")) {
        return stripFields({
            role: "toolResult",
            timestamp: messageTimestamp(m),
            toolName: name,
            isError: false,
            content: toolResultContent(m, "summary"),
        }, config.retain.strip.message);
    }
    return undefined;
}
function hasAssistantContentToRetain(message, config) {
    return Boolean(projectMessage(message, config).content);
}
export function projectMessages(messages, config) {
    return messages
        .filter((message) => !isInjectedHindsightMemory(message))
        .map((message) => {
        const role = message.role;
        if (role === "user")
            return config.retain.content.user.includes("text")
                ? projectMessage(message, config)
                : undefined;
        if (role === "assistant") {
            if (!hasAssistantContentToRetain(message, config))
                return undefined;
            return projectMessage(message, config);
        }
        if (role === "toolResult")
            return projectToolResult(message, config);
        return projectMessage(message, config);
    })
        .filter((message) => Boolean(message))
        .map((message) => stripFields(message, config.retain.strip.topLevel));
}
