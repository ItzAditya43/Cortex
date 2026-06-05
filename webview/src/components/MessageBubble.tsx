import React from 'react';
import { Message } from '../types';

interface MessageBubbleProps {
    message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
    const isUser = message.role === 'user';
    const isTool = message.role === 'tool';
    const isAssistant = message.role === 'assistant';

    const avatar = isUser ? '👤' : isTool ? '🔧' : '🤖';

    return (
        <div className={`message ${message.role}-message`}>
            <div className="message-avatar">{avatar}</div>
            <div className="message-content">
                {isTool && message.toolName && (
                    <div className="tool-badge">
                        <span className="tool-name">{message.toolName}</span>
                        {message.toolCallId && (
                            <span className="tool-call-id">{message.toolCallId.slice(0, 12)}</span>
                        )}
                    </div>
                )}
                <pre className="message-text">{message.content}</pre>
                {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="tool-calls-list">
                        {message.toolCalls.map((tc, i) => (
                            <div key={tc.id || i} className="tool-call-item">
                                <span className="tool-call-badge">🔧 {tc.tool}</span>
                                {tc.thought && <p className="tool-thought">{tc.thought}</p>}
                                {tc.result && (
                                    <pre className="tool-result">
                                        {JSON.stringify(tc.result, null, 2)}
                                    </pre>
                                )}
                            </div>
                        ))}
                    </div>
                )}
                <div className="message-timestamp">
                    {message.timestamp.toLocaleTimeString()}
                </div>
            </div>
        </div>
    );
}