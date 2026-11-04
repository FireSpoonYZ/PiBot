export const DEFAULT_COLLAPSED_TOOL_RESULT_LINES = 12;

export function normalizeToolResultText(
  text,
  expanded,
  maxLines = DEFAULT_COLLAPSED_TOOL_RESULT_LINES,
) {
  const lines = String(text ?? "").split("\n");
  const canFold = lines.length > maxLines;
  const hiddenLineCount = canFold && !expanded ? lines.length - maxLines : 0;
  return {
    text: hiddenLineCount > 0 ? lines.slice(0, maxLines).join("\n") : String(text ?? ""),
    hiddenLineCount,
    totalLineCount: lines.length,
    canFold,
  };
}

export function renderMemoryToolTextResult(result) {
  return result;
}

export function retainToolResponse(result) {
  const deadLetterStatus = result.deadLettered
    ? ` ${result.deadLettered} job${result.deadLettered === 1 ? "" : "s"} moved to dead-letter queue; run /hindsight to inspect.`
    : "";
  const text =
    result.remaining > 0
      ? `Queued for ${result.bankId}; ${result.remaining} job${result.remaining === 1 ? "" : "s"} pending.${deadLetterStatus}`
      : `Retained in ${result.bankId} as ${result.documentId}.${deadLetterStatus}`;
  const operationText = result.operationIds?.length
    ? ` Operation IDs: ${result.operationIds.join(", ")}.`
    : "";
  return { content: [{ type: "text", text: `${text}${operationText}` }], details: result };
}
