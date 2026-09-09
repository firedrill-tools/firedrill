# Mailbox app

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

Developers and browser-driven agents use a synthetic inbox alongside the Tool's
HTTP, MCP, CLI and direct calls. Reading, drafting and sending must use the same
actor-scoped operations and state, not browser fixtures or a second database.

## Constraints

The app ships with the selected Tool and starts through the ordinary local world
listener. No account, container or separate development server is required.
Messages are synthetic; sending never delivers real email. Tool apps cannot
reset the world, inspect hidden state or choose a more privileged actor.

## Brand and interaction commitments

Inherit the existing Firedrill inspector's neutral surfaces, cobalt actions,
Inter typography and clear clickable controls. Use a familiar inbox, message
reading and compose layout, with responsive navigation and explicit destructive
confirmation. Preserve ordinary keyboard and accessible form behavior.

## Evidence

Source operations are defined in mailbox.tool.yaml and src/behavior.ts. Runtime
capability is not established until the packaged app is exercised against a real
local world. No provider-complete compatibility is implied.
