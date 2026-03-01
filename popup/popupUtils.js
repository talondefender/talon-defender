export function formatNumber(value = 0) {
  return Number(value || 0).toLocaleString();
}

export function formatDataSaved(value = 0) {
  const numeric = Number(value || 0);
  if (Number.isNaN(numeric)) {
    return "0 KB";
  }

  if (numeric >= 1024) {
    return `${(numeric / 1024).toFixed(1)} MB`;
  }

  return `${numeric.toFixed(0)} KB`;
}
