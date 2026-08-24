# `@firedrill/world-build`

Loads an immutable world build only after verifying its build identity, canonical IR hash, package-lock hash, exact artifact set, per-Tool artifact hashes, Tool manifest hashes, engine compatibility, and exported behavior contract.

Loading executes customer-supplied Tool behavior. The local framework treats code in the developer's repository as trusted local code; hosted execution must compose this loader inside the platform's package sandbox.
