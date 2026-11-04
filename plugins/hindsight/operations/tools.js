export function registerTools(pi, catalog) {
    for (const tool of catalog.tools)
        pi.registerTool(tool);
}
