// Enforce Conventional Commits, checked by the lefthook commit-msg hook. The
// release tooling derives the version from these subjects, so this is a
// correctness gate rather than a style one.
export default { extends: ['@commitlint/config-conventional'] };
