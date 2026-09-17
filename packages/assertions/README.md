# @firedrill-tools/assertions

Deterministic, read-only evaluation of compiled drill assertions against final world state and run-scoped durable evidence.

The evaluator does not mutate the world, execute tools, or interpret model output. Every result includes structured expected and actual values, a subject location, a diff operator, and the evidence sequences that support it.
