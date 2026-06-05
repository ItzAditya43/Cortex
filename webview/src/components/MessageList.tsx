import React, { useRef, useEffect } from 'react';
import { Message } from '../types';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
    messages: Message[];
    currentAssistantMessage: string;
}

export function MessageList({ messages, currentAssistantMessage }: MessageListProps) {
    const bottomRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages, currentAssistantMessage]);

    if (messages.length === 0 && !currentAssistantMessage) {
        return (
            <div className="message-list-empty">
                <div className="empty-icon">🤖</div>
                <h2>Agent OS</h2>
                <p>Your autonomous coding assistant.</p>
                <p className="empty-hint">Type a message to start working.</p>
            </div>
        );
    }

    return (
        <div className="message-list">
            {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
            ))}
            {currentAssistantMessage && (
                <div className="message assistant-message streaming">
                    <div className="message-avatar">🤖</div>
                    <div className="message-content">
                        <pre className="message-text">{currentAssistantMessage}</pre>
                        <span className="cursor-blink">|</span>
                    </div>
                </div>
            )}
            <div ref={bottomRef} />
        </div>
    );
}