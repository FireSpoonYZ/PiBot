function summarizeReflectTrace(trace) {
    if (!trace || typeof trace !== "object")
        return "";
    const record = trace;
    const toolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const llmCalls = Array.isArray(record.llm_calls) ? record.llm_calls : [];
    if (toolCalls.length === 0 && llmCalls.length === 0)
        return "";
    const toolNames = toolCalls
        .map((call) => call && typeof call === "object" ? call.tool : undefined)
        .filter((name) => typeof name === "string");
    const toolPart = toolCalls.length
        ? `${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}${toolNames.length ? ` (${[...new Set(toolNames)].join(", ")})` : ""}`
        : "";
    const llmPart = llmCalls.length
        ? `${llmCalls.length} LLM call${llmCalls.length === 1 ? "" : "s"}`
        : "";
    return `Trace: ${[toolPart, llmPart].filter(Boolean).join("; ")}`;
}
export function formatReflectResult(result) {
    if (typeof result === "string")
        return result;
    if (!result || typeof result !== "object")
        return JSON.stringify(result, null, 2);
    const record = result;
    const parts = [];
    if (typeof record.text === "string" && record.text.trim())
        parts.push(record.text.trim());
    if (record.structured_output && typeof record.structured_output === "object") {
        parts.push(`Structured output:\n${JSON.stringify(record.structured_output, null, 2)}`);
    }
    const traceSummary = summarizeReflectTrace(record.trace);
    if (traceSummary)
        parts.push(traceSummary);
    return parts.length ? parts.join("\n\n") : JSON.stringify(result, null, 2);
}
