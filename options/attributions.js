import { readSourceCodeInfo } from "../shared/source-code.js";

const sourceCodeLinkEl = document.getElementById("sourceCodeLink");

const init = async () => {
  if (!sourceCodeLinkEl) {
    return;
  }
  const info = await readSourceCodeInfo();
  const url = typeof info?.sourceCodeUrl === "string" ? info.sourceCodeUrl : "";
  if (!url) {
    sourceCodeLinkEl.textContent = "Source code URL unavailable";
    sourceCodeLinkEl.removeAttribute("href");
    return;
  }
  const version = typeof info?.version === "string" ? info.version.trim() : "";
  sourceCodeLinkEl.href = url;
  sourceCodeLinkEl.textContent = version
    ? `Source code for this version (v${version})`
    : "Source code for this version";
};

init().catch(() => {
  if (!sourceCodeLinkEl) {
    return;
  }
  sourceCodeLinkEl.textContent = "Source code URL unavailable";
  sourceCodeLinkEl.removeAttribute("href");
});

