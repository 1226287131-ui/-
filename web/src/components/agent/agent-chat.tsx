import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "antd";
import { ChevronDown } from "lucide-react";
import { motion, useSpring, useTransform } from "motion/react";

import { canvasThemes } from "@/lib/canvas-theme";
import { summarizeCanvasAgentOps } from "@/lib/canvas/canvas-agent-ops";
import { useAgentStore, type AgentChatItem, type AgentPendingToolCall, type AgentTokenUsage } from "@/stores/use-agent-store";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";
import { AgentChatMessage, AgentPendingToolCard, AgentToolCard, AgentWorkingMessage } from "./agent-chat-message";
import { agentMessageToChatMessage, currentPlanMessage, isPlanMessage, latestPlanMessage, toolCallDetail, toolName, workingActivity } from "./agent-event-formatters";

const SCROLL_BOTTOM_THRESHOLD = 48;

export function AgentChatTimeline({
    theme,
    pendingTool,
    sending,
    waiting,
    onRejectTool,
    onApproveTool,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    pendingTool: AgentPendingToolCall | null;
    sending: boolean;
    waiting: boolean;
    onRejectTool: () => void;
    onApproveTool: () => void;
}) {
    const messages = useAgentStore((state) => state.messages);
    const user = useUserStore((state) => state.user);
    const listRef = useRef<HTMLDivElement>(null);
    const followMessagesRef = useRef(true);
    const [showScrollToBottom, setShowScrollToBottom] = useState(false);
    const streaming = messages.some((message) => message.streamId);
    const working = workingActivity(messages.at(-1));
    const updateScrollState = useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= SCROLL_BOTTOM_THRESHOLD;
        followMessagesRef.current = atBottom;
        setShowScrollToBottom(!atBottom);
    }, []);
    const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
        const list = listRef.current;
        if (!list) return;
        followMessagesRef.current = true;
        list.scrollTo({ top: list.scrollHeight, behavior });
        setShowScrollToBottom(false);
    }, []);
    useEffect(() => {
        const frame = requestAnimationFrame(() => (followMessagesRef.current ? scrollToBottom("auto") : updateScrollState()));
        return () => cancelAnimationFrame(frame);
    }, [messages, pendingTool, scrollToBottom, updateScrollState, waiting]);
    return (
        <div className="relative min-h-0 flex-1">
            <div ref={listRef} className="thin-scrollbar h-full space-y-4 overflow-y-auto px-4 pb-12 pt-4" onScroll={updateScrollState}>
                {messages.map((item) => (
                    isPlanMessage(item) ? null : <AgentChatMessageRow key={item.id} item={item} theme={theme} user={user} />
                ))}
                {pendingTool ? (
                    <AgentPendingToolCard
                        summary={summarizeCanvasAgentOps(pendingTool.input?.ops || []) || toolName(pendingTool.name)}
                        detail={toolCallDetail(pendingTool.name, pendingTool.input, "pending")}
                        theme={theme}
                        onReject={onRejectTool}
                        onApprove={onApproveTool}
                    />
                ) : null}
                {(sending || waiting) && !streaming && !pendingTool ? <AgentWorkingMessage text={working.text} activityKey={working.key} theme={theme} /> : null}
            </div>
            {showScrollToBottom ? (
                <Tooltip title="滚动到底部" placement="left">
                    <Button
                        type="text"
                        shape="circle"
                        aria-label="滚动到底部"
                        className="!absolute bottom-3 left-1/2 z-10 !h-8 !w-8 !min-w-8 -translate-x-1/2 backdrop-blur transition hover:-translate-y-0.5"
                        style={{ background: theme.toolbar.panel, border: `1px solid ${theme.node.stroke}`, color: theme.node.text }}
                        icon={<ChevronDown className="size-4" />}
                        onClick={() => scrollToBottom()}
                    />
                </Tooltip>
            ) : null}
        </div>
    );
}

export function AgentTaskProgress({ theme, busy }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes]; busy: boolean }) {
    const plan = useAgentStore((state) => busy ? currentPlanMessage(state.messages) : latestPlanMessage(state.messages));
    if (!plan) return null;
    return (
        <div className="shrink-0 px-4 pt-2">
            <AgentToolCard key={plan.id} title={plan.title || "任务进度"} text={plan.text} detail={plan.detail} theme={theme} />
        </div>
    );
}

const AgentChatMessageRow = memo(function AgentChatMessageRow({ item, theme, user }: { item: AgentChatItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; user: LocalUser | null }) {
    return (
        <div style={{ contentVisibility: "auto", containIntrinsicSize: "0 80px" }}>
            <AgentChatMessage item={agentMessageToChatMessage(item)} theme={theme} user={user} />
        </div>
    );
});

export function AgentUsageBar({ usage, theme }: { usage: AgentTokenUsage; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="flex items-center justify-center gap-4 px-4 pt-1 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>
            <span className="opacity-70">最新调用</span>
            <UsageNumber label="输入" value={usage.input} color={theme.node.text} />
            <UsageNumber label="缓存" value={usage.cached} color={theme.node.text} />
            <UsageNumber label="输出" value={usage.output} color={theme.node.text} />
        </div>
    );
}

function UsageNumber({ label, value, color }: { label: string; value: number; color: string }) {
    const spring = useSpring(value, { stiffness: 110, damping: 24, mass: 0.7 });
    const text = useTransform(spring, (current) => Math.round(current).toLocaleString());
    useEffect(() => spring.set(value), [spring, value]);
    return (
        <span className="inline-flex items-baseline gap-1" aria-label={`${label} ${value.toLocaleString()}`}>
            <span>{label}</span>
            <motion.span aria-hidden className="font-medium" style={{ color }}>
                {text}
            </motion.span>
        </span>
    );
}

