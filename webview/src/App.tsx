import React, { useState, useEffect, useCallback } from 'react';
import { AgentState, PendingApproval, Settings } from './types';
import { ChatHeader } from './components/ChatHeader';
import { MessageList } from './components/MessageList';
import { ChatInput } from './components/ChatInput';
import { ApprovalDialog } from './components/ApprovalDialog';
import { useVSCodeAPI } from './hooks/useVSCodeAPI';
import { useMessages } from './hooks/useMessages';

export function App() {
    const { sendMessage, listen } = useVSCodeAPI();
    const { messages, currentAssistantMessage, addUserMessage, appendToken, finalizeAssistantMessage, addToolResult } = useMessages();

    const [agentState, setAgentState] = useState<AgentState>('idle');
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [settings, setSettings] = useState<Settings>({ yoloMode: false });
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Listen for messages from extension
    useEffect(() => {
        const cleanup = listen((data: any) => {
            switch (data.type) {
                case 'init':
                    break;

                case 'agent_state':
                    setAgentState(data.state);
                    if (data.state === 'idle' || data.state === 'thinking') {
                        setErrorMessage(null);
                    }
                    break;

                case 'token':
                    appendToken(data.content);
                    break;

                case 'tool_call':
                    // Tool calls are shown inline with the assistant message
                    break;

                case 'tool_result':
                    addToolResult(data.toolCallId, data.toolName || 'tool', data.result);
                    break;

                case 'approval_request':
                    setPendingApproval({
                        toolCallId: data.toolCallId,
                        toolName: data.toolName,
                        params: data.params,
                        reason: data.reason,
                    });
                    break;

                case 'approval_resolved':
                    setPendingApproval(null);
                    break;

                case 'error':
                    console.error('Agent error:', data.message);
                    setErrorMessage(data.message || 'Unknown error');
                    break;

                case 'done':
                    finalizeAssistantMessage();
                    break;

                case 'configuration':
                    if (data.config) {
                        setSettings(data.config);
                    }
                    break;
            }
        });

        return cleanup;
    }, [listen, appendToken, addToolResult, finalizeAssistantMessage]);

    const handleSubmit = useCallback((text: string) => {
        addUserMessage(text);
        sendMessage('user_message', { text });
    }, [addUserMessage, sendMessage]);

    const handleAbort = useCallback(() => {
        sendMessage('abort');
        finalizeAssistantMessage();
        setAgentState('idle');
    }, [sendMessage, finalizeAssistantMessage]);

    const handleApprove = useCallback(() => {
        if (pendingApproval) {
            sendMessage('approval_response', {
                toolCallId: pendingApproval.toolCallId,
                approved: true,
            });
            setPendingApproval(null);
        }
    }, [pendingApproval, sendMessage]);

    const handleReject = useCallback(() => {
        if (pendingApproval) {
            sendMessage('approval_response', {
                toolCallId: pendingApproval.toolCallId,
                approved: false,
            });
            setPendingApproval(null);
        }
    }, [pendingApproval, sendMessage]);

    const handleToggleYolo = useCallback(() => {
        const newYolo = !settings.yoloMode;
        setSettings(prev => ({ ...prev, yoloMode: newYolo }));
        sendMessage('settings_update', { key: 'yoloMode', value: newYolo });
    }, [settings.yoloMode, sendMessage]);

    const handleReconnect = useCallback(() => {
        setErrorMessage(null);
        sendMessage('retry_connect');
    }, [sendMessage]);

    const isInputDisabled = agentState === 'thinking' || agentState === 'executing' || agentState === 'error';

    return (
        <div className="app-container">
            <ChatHeader
                agentState={agentState}
                onAbort={handleAbort}
                onSettingsClick={() => setShowSettings(!showSettings)}
            />

            {errorMessage && (
                <div className="error-banner">
                    <span className="error-banner-icon">⚠️</span>
                    <span className="error-banner-text">{errorMessage}</span>
                    {agentState === 'error' && (
                        <button className="error-banner-retry" onClick={handleReconnect}>Retry</button>
                    )}
                    <button className="error-banner-dismiss" onClick={() => setErrorMessage(null)}>✕</button>
                </div>
            )}

            {showSettings && (
                <div className="settings-panel">
                    <label className="setting-item">
                        <input
                            type="checkbox"
                            checked={settings.yoloMode}
                            onChange={handleToggleYolo}
                        />
                        <span>YOLO Mode (auto-approve all tools)</span>
                    </label>
                    <p className="setting-hint">
                        When enabled, all tool executions will be automatically approved without confirmation.
                    </p>
                </div>
            )}

            <MessageList
                messages={messages}
                currentAssistantMessage={currentAssistantMessage}
            />

            {pendingApproval && (
                <ApprovalDialog
                    approval={pendingApproval}
                    onApprove={handleApprove}
                    onReject={handleReject}
                />
            )}

            <ChatInput onSubmit={handleSubmit} disabled={isInputDisabled} />
        </div>
    );
}