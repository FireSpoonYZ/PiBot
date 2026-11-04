import { readGlobalConfig, readProjectConfig } from "./config-writer.js";
import { buildConfigEditingFieldsFromRegistry, buildStatusFacts, } from "./config-editing-registry.js";
export { enabledDisabled, inputDefaultForConfigEditingField, parseConfigEditingFieldInput, patchForConfigEditingField, } from "./config-editing-registry.js";
export function readConfigLayers(cwd) {
    return { project: readProjectConfig(cwd), global: readGlobalConfig(), env: process.env };
}
export function buildConfigEditingFields(config, projectBankId, layers) {
    return buildConfigEditingFieldsFromRegistry(config, projectBankId, layers);
}
export function buildConfigEditingTabs(config, projectBankId, layers, statusFacts = [], options = {}) {
    const fields = buildConfigEditingFields(config, projectBankId, layers);
    // Default hub is Status only; advanced unlocks full settings tabs.
    const ids = options.showAdvanced
        ? ["Status", "Connection", "Banks", "Recall", "Retain", "Import", "UI"]
        : ["Status"];
    return ids.map((id) => ({
        id,
        fields: id === "Status"
            ? []
            : fields.filter((field) => field.tab === id && (options.showAdvanced || !field.advanced)),
        ...(id === "Status" ? { facts: buildStatusFacts(config, projectBankId, statusFacts) } : {}),
    }));
}
