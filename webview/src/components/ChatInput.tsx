import React, { useState, useRef, useEffect } from 'react';

interface ChatInputProps {
    onSubmit: (text: string) => void;
    disabled: boolean;
}

export function ChatInput({ onSubmit, disabled }: ChatInputProps) {
    const [input, setInput] = useState('');
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (!disabled && textareaRef.current) {
            textareaRef.current.focus();
        }
    }, [disabled]);

    const handleSubmit = () => {
        const text = input.trim();
        if (!text || disabled) return;
        onSubmit(text);
        setInput('');
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    };

    const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        // Auto-resize
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
    };

    return (
        <div className="chat-input-container">
            <textarea
                ref={textareaRef}
                className="chat-input"
                value={input}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                placeholder={disabled ? 'Waiting for agent...' : 'Ask Agent OS to do something...'}
                disabled={disabled}
                rows={1}
            />
            <button
                className="send-btn"
                onClick={handleSubmit}
                disabled={disabled || !input.trim()}
                title="Send message"
            >
                ➤
            </button>
        </div>
    );
}