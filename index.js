// Backwards compatibility.
//
// Before v0.2.0 the OpenCode plugin lived at this path. It now lives in
// adapters/opencode.js so the repo can host adapters for other agents too.
// Anyone whose config already pointed at this folder keeps working.

export { default } from "./adapters/opencode.js"
