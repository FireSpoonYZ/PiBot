import { getBuiltInBankTemplate, listBankTemplatesForAgentUse, listBuiltInBankTemplates, resolveBankTemplateManifest, } from "../banks/bank-templates.js";
import { resolveProjectIdentity } from "../banks/banking.js";
import { resolveOperationBank } from "../banks/bank-selection.js";
import { seedKnowledgePages } from "../banks/knowledge-page-seed.js";
export function createBankTemplateOperations(deps) {
    return {
        listBankTemplates() {
            return listBuiltInBankTemplates();
        },
        listBankTemplatesForAgentUse() {
            return listBankTemplatesForAgentUse(deps.getConfig().agentUse);
        },
        async applyBankTemplate(args) {
            const template = getBuiltInBankTemplate(args.templateId);
            if (!template) {
                throw new Error(`Unknown bank template id: ${args.templateId}. Open /hindsight and press t to list sets for the current agent use.`);
            }
            const client = deps.getClient();
            if (!client.importBankTemplate) {
                throw new Error("Hindsight client does not support bank template import.");
            }
            const config = deps.getConfig();
            // Each bundled template already declares which bank kind it targets, so apply resolves
            // that bank directly instead of taking a separate --bank override.
            const bankId = resolveOperationBank({
                requestedBank: template.target === "user" ? "global" : undefined,
                config,
                projectBankId: deps.getProjectBankId(),
            });
            const bankMissionSettings = template.target === "user" ? config.banks.user : config.banks.project;
            const cwd = deps.getCwd?.() ?? process.cwd();
            const resolvedProjectId = template.target === "project" ? resolveProjectIdentity(cwd, config).projectId : undefined;
            const manifest = resolveBankTemplateManifest(template, bankMissionSettings, {
                ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            });
            const dryRun = args.dryRun ?? true;
            const result = await client.importBankTemplate(bankId, manifest, { dryRun });
            // Coding project templates also seed the knowledge-page taxonomy when the server supports pages.
            let knowledgeSeed;
            if (template.id === "pi-coding-project") {
                const baseTags = [
                    "source:pi",
                    ...(resolvedProjectId ? [`project:${resolvedProjectId}`] : []),
                ];
                knowledgeSeed = await seedKnowledgePages({
                    client,
                    bankId,
                    baseTags,
                    dryRun,
                });
            }
            return {
                bankId,
                template,
                dryRun,
                result,
                ...(knowledgeSeed ? { knowledgeSeed } : {}),
            };
        },
    };
}
