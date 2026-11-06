// How the plugin names itself to RHQ: the User-Agent, and the version the
// push step writes into a payload's `client.version`. A constant rather than
// a read of package.json, whose path differs between the source tree and the
// built plugin; a unit test keeps the two in step.

export const CLIENT_NAME = "royalties-hq-medusa";
export const CLIENT_VERSION = "0.1.3";
export const USER_AGENT = `${CLIENT_NAME}/${CLIENT_VERSION}`;
