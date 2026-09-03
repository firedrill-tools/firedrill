/**
 * Version of the public local runtime contract implemented by this release.
 * Tool packages declare a semver range against this value.
 */
export const FIREDRILL_ENGINE_VERSION = "0.1.0";

/**
 * Version shared by packages that ship as one framework release train.
 *
 * This is intentionally separate from the engine contract version: a patch or
 * prerelease of the framework does not force Tool authors to change a
 * compatible engine range.
 */
export const FIREDRILL_FRAMEWORK_VERSION = "0.1.0-rc.1";
