const normalizeRulesetId = value => {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed === "" ? "" : trimmed;
};

export function normalizeEnabledRulesets(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const id = normalizeRulesetId(value);
    if (id === "" || seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function getRulesetToggleState(enabledRulesets, toggleRulesets) {
  const enabledSet = new Set(normalizeEnabledRulesets(enabledRulesets));
  const toggleIds = normalizeEnabledRulesets(toggleRulesets);
  const enabledCount = toggleIds.reduce((count, id) =>
    count + (enabledSet.has(id) ? 1 : 0), 0);
  const allEnabled = toggleIds.length !== 0 && enabledCount === toggleIds.length;
  const anyEnabled = enabledCount !== 0;
  return {
    enabledCount,
    allEnabled,
    anyEnabled,
    partial: anyEnabled && allEnabled === false,
  };
}

export function applyRulesetToggleChange(currentEnabledRulesets, toggleRulesets, enabled) {
  const next = new Set(normalizeEnabledRulesets(currentEnabledRulesets));
  for (const id of normalizeEnabledRulesets(toggleRulesets)) {
    if (enabled) {
      next.add(id);
    } else {
      next.delete(id);
    }
  }
  return Array.from(next);
}

export function formatRulesetApplyError(result) {
  const quota = result?.staticRuleQuota instanceof Object ? result.staticRuleQuota : null;
  if (result?.error === "static_ruleset_quota_exceeded" && quota !== null) {
    return `Chrome rule limit: needs ${quota.requiredStaticRuleCount || 0}, available ${quota.projectedAvailableStaticRuleCount || quota.availableStaticRuleCount || 0}`;
  }
  if (result?.error === "static_ruleset_count_limit" && quota !== null) {
    return `Chrome ruleset limit: ${quota.enabledAfterCount || 0}/${quota.maxEnabledStaticRulesets || 0}`;
  }
  return String(result?.error || "ruleset_error");
}
