import { type ReactNode } from "react";
import { Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { boolConfig, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceDurationOptions, seedancePixelLabel, seedanceRatioOptions, seedanceResolutionOptions } from "@/lib/seedance-video";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { getMiniMaxH3AspectRatioForSize, getMiniMaxH3SizeOptionsForRatio, isMiniMaxH3ResolutionSize, MINIMAX_H3_ASPECT_RATIOS, getVideoModelProfile, isVideoV2ModelKind, normalizeMiniMaxH3AspectRatio, normalizeVideoQualityForReferences, normalizeVideoRatioForModel, normalizeVideoSecondsForModel, normalizeVideoSizeForModel } from "@/lib/video-model";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
const secondOptions = [6, 10, 12, 16, 20];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];
const seedanceRatioLabelKeys: Record<string, string> = { "16:9": "landscape", "9:16": "portrait", "1:1": "square", "2:3": "portrait", "3:2": "landscape", "4:3": "standardLandscape", "3:4": "standardPortrait", "21:9": "cinematic", adaptive: "adaptive" };

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondOptions = secondOptions.map((value) => String(value));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    model?: string;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoAspectRatio" | "videoMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    referenceImageCount?: number;
};

export function VideoSettingsPanel({ config, model: selectedModel, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", referenceImageCount = 0 }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const videoModel = selectedModel || config.model || config.videoModel;
    const videoConfig = { ...config, model: videoModel };
    if (isSeedanceVideoConfig(videoConfig)) {
        return <SeedanceVideoSettingsPanel config={config} model={videoModel} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} />;
    }

    const model = modelOptionName(videoModel);
    const profile = getVideoModelProfile(model);
    if (profile.kind === "minimax-h3") {
        return <MiniMaxH3VideoSettingsPanel config={config} model={model} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} />;
    }
    if (profile.kind !== "generic") {
        return <RemoteVideoSettingsPanel config={config} model={model} onConfigChange={onConfigChange} theme={theme} showTitle={showTitle} className={className} referenceImageCount={referenceImageCount} />;
    }

    const seconds = Number(clampVideoSeconds(config.videoSeconds || "6"));
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const resolution = parseVideoResolution(config.vquality);
    const selectedRatio = inferVideoRatio(config.size || "auto");
    const dimensions = readVideoDimensions(config.size || "auto", resolution, selectedRatio);
    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", computeVideoSize(nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto") onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {resolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => selectResolution(item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        <ResolutionInput value={resolution} theme={theme} onChange={selectResolution} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {videoRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => applySize(resolution, item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-0 flex-1" min={VIDEO_SECONDS_MIN} max={VIDEO_SECONDS_MAX} step={1} value={seconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                        <SecondsInput value={seconds} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2.5">
                        {videoModeOptions.map((item) => (
                            <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                {t(`settingsPanels.video.modes.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function SeedanceVideoSettingsPanel({ config, model: selectedModel, onConfigChange, theme, showTitle, className }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const resolution = normalizeSeedanceResolution(config.vquality);
    const ratio = normalizeSeedanceRatio(config.size);
    const duration = normalizeSeedanceDuration(config.videoSeconds);
    const generateAudio = boolConfig(config.videoGenerateAudio, true);
    const watermark = boolConfig(config.videoWatermark, false);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.video.resolution")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceResolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => onConfigChange("vquality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {seedanceRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[68px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border bg-transparent px-1 text-sm transition hover:opacity-80"
                                style={{ borderColor: ratio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => onConfigChange("size", item.value)}
                            >
                                <SizePreview width={ratioPreview(item.value).width} height={ratioPreview(item.value).height} color={theme.node.text} />
                                <span>{i18n.t(`settingsPanels.video.ratios.${seedanceRatioLabelKeys[item.value]}`)}</span>
                                <span className="text-[10px] leading-none opacity-55">{item.value === "adaptive" ? "adaptive" : seedancePixelLabel(resolution, item.value)}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.duration")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {seedanceDurationOptions.map((value) => (
                            <OptionPill key={value} selected={duration === value} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                {value === -1 ? t("settingsPanels.video.smart") : `${value}s`}
                            </OptionPill>
                        ))}
                    </div>
                    <NumberInput value={String(duration)} min={-1} max={15} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.output")} color={theme.node.muted}>
                    <div className="grid gap-2 rounded-xl border p-2.5" style={{ borderColor: theme.node.stroke }}>
                        <SwitchRow label={t("settingsPanels.video.generateAudio")} checked={generateAudio} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        <SwitchRow label={t("settingsPanels.video.watermark")} checked={watermark} theme={theme} onChange={(checked) => onConfigChange("videoWatermark", String(checked))} />
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function MiniMaxH3VideoSettingsPanel({ config, model, onConfigChange, theme, showTitle, className }: VideoSettingsPanelProps & { model: string }) {
    const { t } = useTranslation();
    const profile = getVideoModelProfile(model);
    const seconds = normalizeVideoSecondsForModel(model, config.videoSeconds);
    const size = normalizeVideoSizeForModel(model, config.size);
    const ratio = isMiniMaxH3ResolutionSize(size) ? normalizeMiniMaxH3AspectRatio(config.videoAspectRatio) : getMiniMaxH3AspectRatioForSize(size);
    const sizes = getMiniMaxH3SizeOptionsForRatio(ratio);

    const updateRatio = (nextRatio: string) => {
        const currentSizes = getMiniMaxH3SizeOptionsForRatio(ratio);
        const nextSizes = getMiniMaxH3SizeOptionsForRatio(nextRatio);
        const currentIndex = Math.max(0, currentSizes.indexOf(size));
        onConfigChange("videoAspectRatio", nextRatio);
        onConfigChange("size", nextSizes[Math.min(currentIndex, nextSizes.length - 1)] || nextSizes[nextSizes.length - 1]);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {MINIMAX_H3_ASPECT_RATIOS.map((item) => (
                            <OptionPill key={item} selected={ratio === item} theme={theme} onClick={() => updateRatio(item)}>
                                {item}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <select
                        value={size}
                        aria-label={t("settingsPanels.video.size")}
                        className="h-10 w-full rounded-xl border bg-transparent px-3 text-sm outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text, background: theme.node.fill }}
                        onMouseDown={(event) => event.stopPropagation()}
                        onChange={(event) => {
                            const nextSize = event.target.value;
                            onConfigChange("size", nextSize);
                            if (!isMiniMaxH3ResolutionSize(nextSize)) onConfigChange("videoAspectRatio", getMiniMaxH3AspectRatioForSize(nextSize));
                        }}
                    >
                        {sizes.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <div className="text-[11px] leading-4 opacity-55">{ratio} 共 {sizes.length} 档：480P、768P、1080P、2K、4K。</div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {profile.seconds.map((value) => (
                            <OptionPill key={value} selected={seconds === String(value)} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                {value}s
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

function RemoteVideoSettingsPanel({ config, model, onConfigChange, theme, showTitle, className, referenceImageCount = 0 }: VideoSettingsPanelProps & { model: string }) {
    const { t } = useTranslation();
    const profile = getVideoModelProfile(model);
    const seconds = normalizeVideoSecondsForModel(model, config.videoSeconds);
    const inputSeconds = config.videoSeconds || seconds;
    const ratio = normalizeVideoRatioForModel(model, config.size);
    const quality = normalizeVideoQualityForReferences(model, config.vquality, referenceImageCount);
    const isGrok = profile.kind === "grok";
    const isV2Full = profile.kind === "video-v2-full";
    const isV3 = profile.kind === "video-v3";
    const isCustomDuration = isVideoV2ModelKind(profile.kind) || isV3;
    const qualityOptions = isGrok && referenceImageCount > 1 ? profile.qualityOptions.filter((item) => item !== "1080p") : profile.qualityOptions;

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className={`grid gap-2.5 ${isV2Full ? "grid-cols-2" : "grid-cols-3"}`}>
                        {profile.ratios.map((item) => (
                            <OptionPill key={item} selected={ratio === item} theme={theme} onClick={() => onConfigChange("size", item)}>
                                {item}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {profile.qualityOptions.length ? (
                    <SettingGroup title={t("settingsPanels.video.resolution")} color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {(profile.resolution === "fixed" ? profile.qualityOptions : qualityOptions).map((item) => (
                                <OptionPill key={item} selected={quality === item} disabled={profile.resolution === "fixed"} theme={theme} onClick={() => onConfigChange("vquality", item)}>
                                    {item}
                                </OptionPill>
                            ))}
                        </div>
                        {isGrok && referenceImageCount > 1 ? <div className="text-[11px] leading-4 opacity-55">{t("settingsPanels.video.multiReferenceResolution")}</div> : null}
                    </SettingGroup>
                ) : null}
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    {isCustomDuration ? (
                        <NumberInput value={inputSeconds} min={profile.secondsMin!} max={profile.secondsMax!} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} />
                    ) : (
                        <div className={`grid gap-2.5 ${profile.seconds.length === 1 ? "grid-cols-1" : "grid-cols-3"}`}>
                            {profile.seconds.map((value) => (
                                <OptionPill key={value} selected={seconds === String(value)} disabled={isV2Full} theme={theme} onClick={() => onConfigChange("videoSeconds", String(value))}>
                                    {value}s
                                </OptionPill>
                            ))}
                        </div>
                    )}
                    {isGrok ? <NumberInput value={inputSeconds} min={1} max={15} theme={theme} onChange={(value) => onConfigChange("videoSeconds", value)} /> : null}
                </SettingGroup>
                {isV3 ? (
                    <SettingGroup title={t("settingsPanels.video.output")} color={theme.node.muted}>
                        <SwitchRow label={t("settingsPanels.video.generateAudio")} checked={boolConfig(config.videoGenerateAudio, true)} theme={theme} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return `${normalizeVideoResolutionValue(value)}p`;
}

export function videoSizeLabel(value: string) {
    if (value === "adaptive" || value === "auto") return i18n.t("settingsPanels.video.adaptive");
    if (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(value)) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoAspectRatioLabel(value: string) {
    const ratio = String(value || "").trim();
    const labelKey = seedanceRatioLabelKeys[ratio];
    return labelKey ? i18n.t(`settingsPanels.video.ratios.${labelKey}`) : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" ? "reference" : "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SecondsInput({ value, theme, onCommit }: { value: number; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Number(clampVideoSeconds(input.value));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={VIDEO_SECONDS_MIN}
                max={VIDEO_SECONDS_MAX}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function NumberInput({ value, min, max, theme, onChange }: { value: string; min: number; max: number; theme: CanvasTheme; onChange: (value: string) => void }) {
    return <input type="number" min={min} max={max} className="h-9 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }} value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />;
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}

function ratioPreview(ratio: string) {
    if (ratio === "9:16") return { width: 9, height: 16 };
    if (ratio === "1:1") return { width: 1, height: 1 };
    if (ratio === "4:3") return { width: 4, height: 3 };
    if (ratio === "3:4") return { width: 3, height: 4 };
    if (ratio === "21:9") return { width: 21, height: 9 };
    if (ratio === "adaptive") return { width: 0, height: 0 };
    return { width: 16, height: 9 };
}

function SwitchRow({ label, checked, theme, onChange }: { label: string; checked: boolean; theme: CanvasTheme; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex h-8 items-center justify-between gap-3">
            <span className="text-sm" style={{ color: theme.node.text }}>
                {label}
            </span>
            <span onMouseDown={(event) => event.stopPropagation()}>
                <Switch size="small" checked={checked} onChange={onChange} />
            </span>
        </div>
    );
}
