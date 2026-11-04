import { configureMemory, initMemoryConfig } from "../config/config-writer.js";
export function createConfigOperations(deps) {
    return {
        async configure(cwd, args) {
            return configureMemory(cwd, args, deps);
        },
        async init(cwd) {
            const result = await initMemoryConfig(cwd, deps);
            deps.reloadConfig?.(cwd);
            return result;
        },
    };
}
