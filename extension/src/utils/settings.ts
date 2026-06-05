import * as vscode from 'vscode';

export interface AgentOSSettings {
    backendUrl: string;
    provider: string;
    model: string;
    yoloMode: boolean;
    autoIndex: boolean;
}

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('agentOS');
}

export const settings: AgentOSSettings = {
    get backendUrl(): string {
        return getConfig().get<string>('backendUrl', 'http://localhost:8080');
    },
    get provider(): string {
        return getConfig().get<string>('provider', 'ollama');
    },
    get model(): string {
        return getConfig().get<string>('model', '');
    },
    get yoloMode(): boolean {
        return getConfig().get<boolean>('yoloMode', false);
    },
    get autoIndex(): boolean {
        return getConfig().get<boolean>('autoIndex', true);
    },
};