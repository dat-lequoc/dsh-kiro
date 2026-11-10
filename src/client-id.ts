/**
 * Client identifier sent to Kiro. The service enforces a minimum client
 * version, so bump this to the current Kiro IDE release if requests are
 * rejected with "This version of Kiro is no longer supported".
 */
export const KIRO_CLIENT_VERSION = '1.4.121'
export const KIRO_USER_AGENT = `aws-sdk-js/3.738.0 KiroIDE-${KIRO_CLIENT_VERSION}`
