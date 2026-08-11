import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import { Button } from "antd";

import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@/components/video-settings-panel";
import { canvasThemes } from "@/lib/canvas-theme";
import { getVideoModelProfile, normalizeVideoQualityForReferences, normalizeVideoSecondsForModel, normalizeVideoSizeForModel } from "@/lib/video-model";
import { modelOptionName } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasVideoSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
    buttonClassName?: string;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    referenceImageCount?: number;
};

export function CanvasVideoSettingsPopover({ config, onConfigChange, buttonClassName, placement = "topLeft", referenceImageCount = 0 }: CanvasVideoSettingsPopoverProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const model = modelOptionName(config.model || config.videoModel);
    const profile = getVideoModelProfile(model);
    const isVideoV2Full = profile.kind === "video-v2-full";
    const isMiniMaxH3 = profile.kind === "minimax-h3";
    const isVideoV3 = profile.kind === "video-v3";
    const seconds = isVideoV2Full ? "15" : profile.kind === "generic" ? config.videoSeconds : normalizeVideoSecondsForModel(model, config.videoSeconds);
    const size = profile.kind === "generic" ? config.size : normalizeVideoSizeForModel(model, config.size);
    const quality = isVideoV2Full ? "720p" : profile.kind === "generic" ? config.vquality : normalizeVideoQualityForReferences(model, config.vquality, referenceImageCount);
    const count = normalizeVideoBatchCount(config.count);
    const buttonRef = useRef<HTMLSpanElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

    useEffect(() => {
        if (!open) return;
        const syncPosition = () => setButtonRect(buttonRef.current?.getBoundingClientRect() || null);
        const closeOnOutsidePointer = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
            setOpen(false);
        };

        syncPosition();
        window.addEventListener("resize", syncPosition);
        window.addEventListener("scroll", syncPosition, true);
        window.addEventListener("pointerdown", closeOnOutsidePointer, true);
        return () => {
            window.removeEventListener("resize", syncPosition);
            window.removeEventListener("scroll", syncPosition, true);
            window.removeEventListener("pointerdown", closeOnOutsidePointer, true);
        };
    }, [open]);

    const panel = open && buttonRect ? <VideoSettingsPortal buttonRect={buttonRect} panelRef={panelRef} placement={placement} theme={theme} config={config} referenceImageCount={referenceImageCount} onConfigChange={onConfigChange} /> : null;

    return (
        <>
            <span ref={buttonRef} className="inline-flex min-w-0">
                <Button size="small" type="text" className={buttonClassName || "!h-8 !max-w-[170px] !justify-start !rounded-full !px-2.5"} style={{ background: theme.node.fill, color: theme.node.text }} icon={<Settings2 className="size-3.5" />} onClick={() => setOpen((current) => !current)}>
                    <span className="truncate">
                        {isMiniMaxH3
                            ? `${videoSizeLabel(size)} · ${videoSecondsLabel(seconds)} · ${count} 条`
                            : isVideoV3
                              ? `720p · ${videoSizeLabel(size)} · ${videoSecondsLabel(seconds)} · ${count} 条`
                              : `${videoResolutionLabel(quality)} · ${videoSizeLabel(size)} · ${videoSecondsLabel(seconds)} · ${count} 条`}
                    </span>
                </Button>
            </span>
            {panel}
        </>
    );
}

function VideoSettingsPortal({
    buttonRect,
    panelRef,
    placement,
    theme,
    config,
    referenceImageCount,
    onConfigChange,
}: {
    buttonRect: DOMRect;
    panelRef: RefObject<HTMLDivElement | null>;
    placement: CanvasVideoSettingsPopoverProps["placement"];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    referenceImageCount: number;
    onConfigChange: (key: keyof AiConfig, value: string) => void;
}) {
    const width = 356;
    const gap = 8;
    const margin = 12;
    const alignRight = placement?.endsWith("Right");
    const alignCenter = placement === "top" || placement === "bottom";
    const left = alignCenter ? buttonRect.left + buttonRect.width / 2 - width / 2 : alignRight ? buttonRect.right - width : buttonRect.left;
    const topPlacement = placement?.startsWith("top");
    const style = {
        position: "fixed",
        zIndex: 1200,
        width,
        left: Math.max(margin, Math.min(window.innerWidth - width - margin, left)),
        ...(topPlacement ? { bottom: window.innerHeight - buttonRect.top + gap, maxHeight: Math.max(260, buttonRect.top - margin * 2) } : { top: buttonRect.bottom + gap, maxHeight: Math.max(260, window.innerHeight - buttonRect.bottom - margin * 2) }),
        background: theme.toolbar.panel,
        borderRadius: 18,
        boxShadow: "0 18px 54px rgba(28, 25, 23, 0.16)",
        padding: 18,
        overflowY: "auto",
        color: theme.node.text,
    } as const;

    return createPortal(
        <div
            ref={panelRef}
            className="canvas-image-settings-popover"
            style={style}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
        >
            <VideoSettingsPanel config={config} referenceImageCount={referenceImageCount} onConfigChange={(key, value) => onConfigChange(key, value)} theme={theme} className="space-y-4" />
            <VideoBatchCountSetting config={config} theme={theme} onConfigChange={onConfigChange} />
        </div>,
        document.body,
    );
}

function normalizeVideoBatchCount(value: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1)));
}

function VideoBatchCountSetting({ config, theme, onConfigChange }: { config: AiConfig; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onConfigChange: (key: keyof AiConfig, value: string) => void }) {
    const count = normalizeVideoBatchCount(config.count);
    return (
        <div className="mt-4 space-y-2.5" style={{ color: theme.node.text }}>
            <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                生成条数
            </div>
            <div className="grid grid-cols-4 gap-2.5">
                {[1, 2, 3, 4, 5, 6, 8, 10].map((value) => (
                    <button
                        key={value}
                        type="button"
                        className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
                        style={{ background: "transparent", borderColor: count === value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onClick={() => onConfigChange("count", String(value))}
                    >
                        {value} 条
                    </button>
                ))}
                <input
                    type="number"
                    min={1}
                    max={15}
                    value={count}
                    className="col-span-2 h-9 min-w-0 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onChange={(event) => onConfigChange("count", event.target.value)}
                />
            </div>
            <div className="text-[11px] leading-4 opacity-55">一次提交可生成 1-15 条视频。</div>
        </div>
    );
}
