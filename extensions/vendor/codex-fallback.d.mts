import type { CliproxyCodexStreamSimple, CloseCodexWebSocketSessions } from "../codex-stream.ts";

export const streamSimple: CliproxyCodexStreamSimple;
export const stream: CliproxyCodexStreamSimple;
export const closeOpenAICodexWebSocketSessions: CloseCodexWebSocketSessions;
export const fallbackMetadata: {
	version: string;
	supportsConfigurationUpdate: boolean;
	supportsTranscript: boolean;
	nativeMidConvoEffort: boolean;
};
export function configureFallbackProviderIds(ids: string[]): void;
