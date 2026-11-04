export function resolveOperationBank(args) {
    const requested = args.requestedBank?.trim();
    if (!requested || requested === "project")
        return args.projectBankId;
    if (requested === "global") {
        if (!args.config.banks.user.enabled)
            throw new Error("User Hindsight bank is disabled. Enable banks.user first.");
        if (!args.config.banks.user.bankId)
            throw new Error("User Hindsight bank ID is not configured.");
        return args.config.banks.user.bankId;
    }
    return requested;
}
