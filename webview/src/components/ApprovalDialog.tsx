import React from 'react';
import { PendingApproval } from '../types';

interface ApprovalDialogProps {
    approval: PendingApproval;
    onApprove: () => void;
    onReject: () => void;
}

export function ApprovalDialog({ approval, onApprove, onReject }: ApprovalDialogProps) {
    return (
        <div className="approval-overlay">
            <div className="approval-dialog">
                <div className="approval-header">
                    <span className="approval-icon">🔒</span>
                    <h3>Approve Tool Execution</h3>
                </div>
                <div className="approval-details">
                    <div className="approval-field">
                        <label>Tool</label>
                        <code>{approval.toolName}</code>
                    </div>
                    <div className="approval-field">
                        <label>Parameters</label>
                        <pre className="approval-params">
                            {JSON.stringify(approval.params, null, 2)}
                        </pre>
                    </div>
                    {approval.reason && (
                        <div className="approval-field">
                            <label>Reason</label>
                            <p className="approval-reason">{approval.reason}</p>
                        </div>
                    )}
                </div>
                <div className="approval-actions">
                    <button className="approval-btn reject-btn" onClick={onReject}>
                        ✕ Reject
                    </button>
                    <button className="approval-btn approve-btn" onClick={onApprove}>
                        ✓ Approve
                    </button>
                </div>
            </div>
        </div>
    );
}