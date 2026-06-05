/**
 * Hook to communicate with the VS Code extension host.
 * Provides a typed interface for sending and receiving messages.
 */

declare function acquireVsCodeApi(): {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
};

let vscodeApi: ReturnType<typeof acquireVsCodeApi> | null = null;

function getVsCodeApi() {
    if (!vscodeApi) {
        try {
            vscodeApi = acquireVsCodeApi();
        } catch {
            // Fallback for dev mode outside VS Code
            vscodeApi = {
                postMessage: (msg: any) => {
                    console.log('[VS Code Dev] Would send:', msg);
                },
                getState: () => null,
                setState: () => {},
            };
        }
    }
    return vscodeApi;
}

type MessageHandler = (data: any) => void;

export function useVSCodeAPI() {
    const api = getVsCodeApi();

    function sendMessage(type: string, payload?: any) {
        api.postMessage({ type, payload });
    }

    function listen(handler: MessageHandler) {
        const listener = (event: MessageEvent) => {
            handler(event.data);
        };
        window.addEventListener('message', listener);
        return () => window.removeEventListener('message', listener);
    }

    return { sendMessage, listen, api };
}