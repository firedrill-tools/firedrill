# @firedrill/world-kernel

Package-driven execution for local Firedrill worlds. The kernel resolves every operation, event, fault, and subscription from the Tool definitions supplied by the caller; it has no built-in vendor behavior.

Tool modules are trusted local code in this release. Deterministic host APIs do not sandbox imports or ambient process authority.
