import React from 'react';
import { AgentState } from '../types';

interface ChatHeaderProps {
    agentState: AgentState;
    onAbort: () => void;
    onSettingsClick: () => void;
}

const stateLabels: Record<AgentState, string> = {
    idle: 'Ready',
    thinking: 'Thinking...',
    awaiting_approval: 'Awaiting Approval',
    executing: 'Executing...',
    error: 'Error',
};

export function ChatHeader({ agentState, onAbort, onSettingsClick }: ChatHeaderProps) {
    const isBusy = agentState === 'thinking' || agentState === 'executing';

    return (
        <div className="chat-header">
            <div className="chat-header-left">
                <span className="agent-logo">🤖 Agent OS</span>
                <span className={`agent-status status-${agentState}`}>
                    <span className="status-dot" />
                    {stateLabels[agentState]}
                </span>
            </div>
            <div className="chat-header-right">
                {isBusy && (
                    <button className="header-btn abort-btn" onClick={onAbort} title="Stop generation">
                        ⏹ Stop
                    </button>
                )}
                <button className="header-btn settings-btn" onClick={onSettingsClick} title="Settings">
                    ⚙️
                </button>
            </div>
        </div>
    );
}