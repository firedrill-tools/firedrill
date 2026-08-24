# `@firedrill/world-ir`

Versioned, runtime-safe schemas for the canonical world intermediate representation, resolved Tool lock, and immutable build manifest.

Source paths are deliberately absent from semantic identity. The compiler records current physical paths in its compile result while the build records stable resource IDs and content hashes, so moving a source file does not create a different world.
