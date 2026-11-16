// The one Node global the source reads, and only in `process.env.NODE_ENV`, which bundlers replace.
// Declared alone rather than through @types/node, so no other Node API typechecks in browser code.
declare const process: { readonly env: { readonly NODE_ENV?: string } };
