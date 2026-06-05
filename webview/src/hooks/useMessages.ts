import { useState, useCallback, useRef } from 'react';
import { Message } from '../types';

export function useMessages() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [currentAssistantMessage, setCurrentAssistantMessage] = useState<string>('');
    const messageIdCounter = useRef(0);

    const addUserMessage = useCallback((content: string) => {
        const msg: Message = {
            id: `msg_${++messageIdCounter.current}`,
            role: 'user',
            content,
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, msg]);
        setCurrentAssistantMessage('');
    }, []);

    const appendToken = useCallback((content: string) => {
        setCurrentAssistantMessage(prev => prev + content);
    }, []);

    const finalizeAssistantMessage = useCallback(() => {
        if (!currentAssistantMessage) return;
        const msg: Message = {
            id: `msg_${++messageIdCounter.current}`,
            role: 'assistant',
            content: currentAssistantMessage,
            timestamp: new Date(),
        };
        setMessages(prev => [...prev, msg]);
        setCurrentAssistantMessage('');
    }, [currentAssistantMessage]);

    const addToolResult = useCallback((toolCallId: string, toolName: string, result: any) => {
        const msg: Message = {
            id: `msg_${++messageIdCounter.current}`,
            role: 'tool',
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            timestamp: new Date(),
            toolCallId,
            toolName,
        };
        setMessages(prev => [...prev, msg]);
    }, []);

    const clearMessages = useCallback(() => {
        setMessages([]);
        setCurrentAssistantMessage('');
    }, []);

    return {
        messages,
        currentAssistantMessage,
        addUserMessage,
        appendToken,
        finalizeAssistantMessage,
        addToolResult,
        clearMessages,
    };
}