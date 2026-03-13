
export function t(key, substitutions = []) {
  if (typeof substitutions !== "object" || substitutions === null) {
    substitutions = [substitutions];
  }
  if (!Array.isArray(substitutions)) {
    substitutions = Object.values(substitutions);
  }
  if (typeof chrome !== "undefined" && chrome.i18n && typeof chrome.i18n.getMessage === "function") {
    const result = chrome.i18n.getMessage(key, substitutions);
    if (result) {
      return result;
    }
  }
  if (Array.isArray(substitutions) && substitutions.length) {
    return `${key} ${substitutions.join(" ")}`;
  }
  return key;
}

export function pluralSuffix(count) {
  return Number(count) === 1 ? "" : "s";
}
