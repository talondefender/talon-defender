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
