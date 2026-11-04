import { isRecord } from "../config/config-normalize.js";
export function bankSettingsTargetDisplay(target) {
    return {
        location: target.location,
        bankId: target.bankId,
        locationLabel: `Location: ${target.location}`,
        bankLabel: `Bank: ${target.bankId}`,
        optionLabel: `${target.location} bank (${target.bankId})`,
        reviewLine: `${target.location} → Bank: ${target.bankId}`,
    };
}
export function bankSettingsTargetLines(target) {
    const display = bankSettingsTargetDisplay(target);
    return [display.locationLabel, display.bankLabel];
}
function objectCount(value) {
    return isRecord(value) ? Object.keys(value).length : 0;
}
export function bankConfigOverrideSummaryLines(response) {
    if (!isRecord(response))
        return ["Bank overrides: unavailable"];
    const overrides = isRecord(response.overrides) ? response.overrides : undefined;
    const config = isRecord(response.config) ? response.config : undefined;
    const overrideCount = objectCount(overrides);
    const resolvedCount = objectCount(config);
    return [`Bank overrides: ${overrideCount}`, `Resolved config fields: ${resolvedCount}`];
}
