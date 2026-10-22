export interface Settings {
	/** Guard `useToastContainer` so a malformed toast can never crash the container. */
	sanitizeContainer: boolean
	/** Fill a missing `position` before Discord enqueues a toast (root cause). */
	sanitizeDispatcher: boolean
	/** Log what was dropped/fixed to `logcat | grep ReactNativeJS`. */
	logDiagnostics: boolean
}

export const DEFAULT_SETTINGS: Settings = {
	sanitizeContainer: true,
	sanitizeDispatcher: true,
	logDiagnostics: true,
}
